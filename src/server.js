import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { getConfig, getSafeRuntimeStatus } from './config.js';
import { verifyEd25519Signature } from './crypto.js';
import { createRequestId, error as logError, info as logInfo, warn as logWarn } from './logger.js';
import { actorCanAccept, actorCanCounter, actorCanReject, actorCanWithdraw } from './negotiation.js';
import { assuranceTiers, getPolicyResponse, screenListing } from './policy.js';
import { createPostgresStore } from './postgres-store.js';
import { createRateLimiter } from './rate-limit.js';
import { createStore } from './store.js';
import { canTransition, getTransition } from './trades.js';

const runtimeConfig = getConfig();
const defaultStore = runtimeConfig.databaseUrl
  ? createPostgresStore({ connectionString: runtimeConfig.databaseUrl })
  : createStore(runtimeConfig.dataDir ? { filePath: `${runtimeConfig.dataDir}/agent-exchange.json` } : {});
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;

const adminAssets = Object.freeze({
  '/admin': { path: '../public/admin.html', type: 'text/html; charset=utf-8' },
  '/admin/': { path: '../public/admin.html', type: 'text/html; charset=utf-8' },
  '/admin/admin.css': { path: '../public/admin.css', type: 'text/css; charset=utf-8' },
  '/admin/admin.js': { path: '../public/admin.js', type: 'application/javascript; charset=utf-8' }
});

function json(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-request-id': payload.requestId ?? '',
    'content-length': Buffer.byteLength(body),
    ...extraHeaders
  });
  res.end(body);
}

async function serveAdminAsset(pathname, res) {
  const asset = adminAssets[pathname];
  if (!asset) return false;

  const body = await readFile(new URL(asset.path, import.meta.url));
  res.writeHead(200, {
    'content-type': asset.type,
    'cache-control': 'no-store',
    'content-length': body.length
  });
  res.end(body);
  return true;
}

async function readJson(req) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    totalBytes += chunk.length;
    const maxJsonBodyBytes = getConfig().maxJsonBodyBytes;
    if (totalBytes > maxJsonBodyBytes) {
      const error = new Error('Request body too large');
      error.code = 'REQUEST_BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) {
    return {};
  }

  return JSON.parse(raw);
}

function validateListingInput(input) {
  const errors = [];

  if (!input || typeof input !== 'object') errors.push('body must be a JSON object');
  if (!input.sellerAgentId || typeof input.sellerAgentId !== 'string') errors.push('sellerAgentId is required');
  if (!input.title || typeof input.title !== 'string') errors.push('title is required');
  if (!input.category || typeof input.category !== 'string') errors.push('category is required');
  if (!Number.isInteger(input.assuranceTier) || !(input.assuranceTier in assuranceTiers)) {
    errors.push('assuranceTier must be one of 0, 1, 2, or 3');
  }
  if (!input.priceUsdc || !/^\d+(\.\d{1,6})?$/.test(String(input.priceUsdc))) {
    errors.push('priceUsdc must be a decimal string');
  }
  if (input.inventoryType && !['unique', 'fungible'].includes(input.inventoryType)) {
    errors.push('inventoryType must be unique or fungible');
  }
  if (input.inventoryType === 'fungible') {
    if (!Number.isInteger(input.totalQuantity) || input.totalQuantity <= 0) {
      errors.push('totalQuantity is required for fungible listings');
    }
    if (!input.unitPriceUsdc || !/^\d+(\.\d{1,6})?$/.test(String(input.unitPriceUsdc))) {
      errors.push('unitPriceUsdc is required for fungible listings');
    }
  }

  return errors;
}

function validateTradeInput(input) {
  const errors = [];

  if (!input || typeof input !== 'object') errors.push('body must be a JSON object');
  if (!input.listingId || typeof input.listingId !== 'string') errors.push('listingId is required');
  if (!input.buyerAgentId || typeof input.buyerAgentId !== 'string') errors.push('buyerAgentId is required');
  if (input.quantity !== undefined && (!Number.isInteger(input.quantity) || input.quantity <= 0)) {
    errors.push('quantity must be a positive integer');
  }
  if (input.unitPriceUsdc !== undefined && !/^\d+(\.\d{1,6})?$/.test(String(input.unitPriceUsdc))) {
    errors.push('unitPriceUsdc must be a decimal string');
  }

  return errors;
}

function validateAgentInput(input) {
  const errors = [];

  if (!input || typeof input !== 'object') errors.push('body must be a JSON object');
  if (!input.developerId || typeof input.developerId !== 'string') errors.push('developerId is required');
  if (!input.name || typeof input.name !== 'string') errors.push('name is required');
  if (input.publicKeyJwk && typeof input.publicKeyJwk !== 'object') {
    errors.push('publicKeyJwk must be a JWK object');
  }

  return errors;
}

function validateOfferInput(input) {
  const errors = [];

  if (!input || typeof input !== 'object') errors.push('body must be a JSON object');
  if (!input.listingId || typeof input.listingId !== 'string') errors.push('listingId is required');
  if (!input.buyerAgentId || typeof input.buyerAgentId !== 'string') errors.push('buyerAgentId is required');
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) errors.push('quantity must be a positive integer');
  if (!input.unitPriceUsdc || !/^\d+(\.\d{1,6})?$/.test(String(input.unitPriceUsdc))) {
    errors.push('unitPriceUsdc must be a decimal string');
  }
  if (!input.expiresAt || Number.isNaN(Date.parse(input.expiresAt))) errors.push('expiresAt is required');
  if (input.expiresAt && Date.parse(input.expiresAt) <= Date.now()) {
    errors.push('expiresAt must be in the future');
  }

  return errors;
}

function validateAutoAcceptRuleInput(input) {
  const errors = [];

  if (!input || typeof input !== 'object') errors.push('body must be a JSON object');
  if (input.actorAgentId !== undefined && typeof input.actorAgentId !== 'string') {
    errors.push('actorAgentId must be a string when supplied');
  }
  if (!input.minUnitPriceUsdc || !/^\d+(\.\d{1,6})?$/.test(String(input.minUnitPriceUsdc))) {
    errors.push('minUnitPriceUsdc must be a decimal string');
  }
  if (!Number.isInteger(input.maxQuantityPerTrade) || input.maxQuantityPerTrade <= 0) {
    errors.push('maxQuantityPerTrade must be a positive integer');
  }
  if (
    !input.maxDailyAutoAcceptedUsdc ||
    !/^\d+(\.\d{1,6})?$/.test(String(input.maxDailyAutoAcceptedUsdc))
  ) {
    errors.push('maxDailyAutoAcceptedUsdc must be a decimal string');
  }
  if (!Number.isInteger(input.offerExpiresWithinSeconds) || input.offerExpiresWithinSeconds <= 0) {
    errors.push('offerExpiresWithinSeconds must be a positive integer');
  }

  return errors;
}

function parseIntegerQuery(value, { name, defaultValue, min = 0, max = MAX_LIST_LIMIT }) {
  if (value === undefined) return { value: defaultValue };
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return { error: `${name} must be an integer between ${min} and ${max}` };
  }
  return { value: parsed };
}

function parseListQuery(query, filterConfig) {
  const limit = parseIntegerQuery(query.limit, {
    name: 'limit',
    defaultValue: DEFAULT_LIST_LIMIT,
    min: 1,
    max: MAX_LIST_LIMIT
  });
  const offset = parseIntegerQuery(query.offset, {
    name: 'offset',
    defaultValue: 0,
    min: 0,
    max: Number.MAX_SAFE_INTEGER
  });
  const errors = [limit.error, offset.error].filter(Boolean);
  const filters = {
    limit: limit.value,
    offset: offset.value
  };

  for (const [name, options = {}] of Object.entries(filterConfig)) {
    if (query[name] === undefined || query[name] === '') continue;
    if (options.type === 'integer') {
      const parsed = Number(query[name]);
      if (!Number.isInteger(parsed)) {
        errors.push(`${name} must be an integer`);
      } else {
        filters[name] = parsed;
      }
      continue;
    }
    filters[name] = query[name];
  }

  if (errors.length > 0) return { errors };
  return { filters };
}

function paginatedBody(key, items, filters) {
  return {
    [key]: items,
    pagination: {
      limit: filters.limit,
      offset: filters.offset,
      returned: items.length
    }
  };
}

function countBy(items, field) {
  return items.reduce((counts, item) => {
    const key = String(item[field] ?? 'unknown');
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function recent(items, limit = 12) {
  return [...items]
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
    .slice(0, limit);
}

function hashIp(value) {
  return value ? createHash('sha256').update(String(value)).digest('hex') : null;
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress ?? null;
}

async function resolveRequestActor(headers, store) {
  const token = getBearerToken(headers);
  if (!token || typeof store.getSessionByToken !== 'function') return {};
  const session = await store.getSessionByToken(token);
  return session ? { actorAgentId: session.agentId, sessionId: session.id } : {};
}

async function safeRecordRequest(store, input) {
  if (typeof store.recordRequestLog !== 'function') return;
  try {
    await store.recordRequestLog(input);
  } catch (error) {
    logWarn('audit.request_log_failed', { requestId: input.requestId, error });
  }
}

async function safeRecordAudit(store, input) {
  if (typeof store.recordAuditEvent !== 'function') return;
  try {
    await store.recordAuditEvent(input);
  } catch (error) {
    logWarn('audit.event_log_failed', { requestId: input.requestId, type: input.type, error });
  }
}

function getHeader(headers, name) {
  return headers?.[name.toLowerCase()] ?? headers?.[name] ?? null;
}

function idempotencyKey(headers, body) {
  return getHeader(headers, 'idempotency-key') ?? body.idempotencyKey ?? null;
}

function getBearerToken(headers) {
  const header = getHeader(headers, 'authorization');
  if (!header || typeof header !== 'string') return null;

  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

async function authenticateAgent(headers, store) {
  const token = getBearerToken(headers);
  if (!token) {
    return {
      error: {
        status: 401,
        body: {
          error: 'authentication_required',
          message: 'Use Authorization: Bearer <session token> for this request.'
        }
      }
    };
  }

  const session = await store.getSessionByToken(token);
  if (!session) {
    return {
      error: {
        status: 401,
        body: {
          error: 'invalid_or_expired_session',
          message: 'The bearer session is invalid or expired.'
        }
      }
    };
  }

  const agent = await store.getAgent(session.agentId);
  if (!agent || agent.status !== 'active') {
    return {
      error: {
        status: 401,
        body: {
          error: 'agent_session_inactive',
          message: 'The bearer session is not tied to an active agent.'
        }
      }
    };
  }

  return { auth: { session, agent, agentId: agent.id } };
}

function requireAdmin(headers) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) {
    return {
      status: 503,
      body: {
        error: 'admin_auth_not_configured',
        message: 'ADMIN_TOKEN must be configured before admin maintenance or dispute resolution can run.'
      }
    };
  }

  if (getHeader(headers, 'x-admin-token') !== expected) {
    return {
      status: 403,
      body: {
        error: 'admin_actor_required',
        message: 'Admin routes require a valid x-admin-token header.'
      }
    };
  }

  return null;
}

function requireBodyActorMatchesSession(body, auth) {
  if (body.actorAgentId && body.actorAgentId !== auth.agentId) {
    return {
      status: 403,
      body: {
        error: 'authenticated_actor_mismatch',
        message: 'actorAgentId must match the bearer session agent.'
      }
    };
  }
  return null;
}

function requireFieldMatchesSession(field, value, auth) {
  if (value !== auth.agentId) {
    return {
      status: 403,
      body: {
        error: 'authenticated_actor_mismatch',
        message: `${field} must match the bearer session agent.`
      }
    };
  }
  return null;
}

function listingAcceptsNewTrades(listing) {
  return listing && ['active', 'partially_filled'].includes(listing.status);
}

function authorizeTradeAction({ rawAction, trade, actor, body }) {
  if (rawAction === 'accept' || rawAction === 'deliver') {
    return actor === trade.sellerAgentId
      ? null
      : {
          error: 'seller_actor_required',
          message: 'Only the seller agent can perform this trade action.'
        };
  }

  if (rawAction === 'confirm') {
    return actor === trade.buyerAgentId
      ? null
      : {
          error: 'buyer_actor_required',
          message: 'Only the buyer agent can confirm delivery.'
        };
  }

  if (rawAction === 'dispute') {
    return actor === trade.buyerAgentId || actor === trade.sellerAgentId
      ? null
      : {
          error: 'trade_party_required',
          message: 'Only a party to the trade can open a dispute.'
        };
  }

  if (rawAction === 'refund') {
    return actor === trade.sellerAgentId || actor === 'admin'
      ? null
      : {
          error: 'seller_or_admin_required',
          message: 'Only the seller or an admin can initiate this refund path.'
        };
  }

  if (rawAction === 'resolve') {
    return actor === 'admin'
      ? null
      : {
          error: 'admin_actor_required',
          message: 'Dispute resolution requires an admin actor in the current prototype.'
        };
  }

  return null;
}

export async function handleApiRequest(
  { method, pathname, body = {}, headers = {}, query = {} },
  store = defaultStore
) {
  if (method === 'GET' && pathname === '/v1/health') {
    return {
      status: 200,
      body: {
          ok: true,
          name: 'Agent Exchange',
          version: '0.1.0',
          runtime: getSafeRuntimeStatus()
      }
    };
  }

  if (method === 'GET' && pathname === '/v1/policy') {
    return { status: 200, body: getPolicyResponse() };
  }

  if (method === 'GET' && pathname === '/v1/categories') {
    return {
      status: 200,
      body: {
          categories: [
            {
              id: 'generic',
              name: 'Generic permitted listing',
              status: 'active',
              assuranceTiers: [0, 1, 2, 3]
            },
            {
              id: 'digital_good',
              name: 'Digital good',
              status: 'active',
              assuranceTiers: [0, 1, 2, 3]
            },
            {
              id: 'real_world_experience',
              name: 'Real-world experience',
              status: 'tiered',
              assuranceTiers: [0, 1],
              note: 'Tier 2 or 3 requires machine-verifiable or partner-confirmed fulfillment.'
            }
          ],
          assuranceTiers: Object.values(assuranceTiers)
      }
    };
  }

  if (method === 'GET' && pathname === '/v1/listings') {
    const listQuery = parseListQuery(query, {
      sellerAgentId: {},
      category: {},
      assuranceTier: { type: 'integer' },
      status: {},
      inventoryType: {}
    });
    if (listQuery.errors) return { status: 400, body: { error: 'invalid_query', errors: listQuery.errors } };
    const listings = await store.listListings(listQuery.filters);
    return { status: 200, body: paginatedBody('listings', listings, listQuery.filters) };
  }

  const listingMatch = pathname.match(/^\/v1\/listings\/([^/]+)$/);
  if (method === 'GET' && listingMatch) {
    const listing = await store.getListing(listingMatch[1]);
    if (!listing) return { status: 404, body: { error: 'listing_not_found' } };
    return { status: 200, body: { listing } };
  }

  const listingOffersMatch = pathname.match(/^\/v1\/listings\/([^/]+)\/offers$/);
  if (method === 'GET' && listingOffersMatch) {
    const listQuery = parseListQuery(query, {
      buyerAgentId: {},
      sellerAgentId: {},
      status: {}
    });
    if (listQuery.errors) return { status: 400, body: { error: 'invalid_query', errors: listQuery.errors } };
    const filters = { ...listQuery.filters, listingId: listingOffersMatch[1] };
    const offers = await store.listOffers(filters);
    return {
      status: 200,
      body: paginatedBody('offers', offers, filters)
    };
  }

  const listingMarketMatch = pathname.match(/^\/v1\/listings\/([^/]+)\/market$/);
  if (method === 'GET' && listingMarketMatch) {
    const market = await store.getMarket(listingMarketMatch[1]);
    if (!market) return { status: 404, body: { error: 'listing_not_found' } };
    return { status: 200, body: { market } };
  }

  if (method === 'GET' && pathname === '/v1/markets') {
    return { status: 200, body: { markets: await store.listMarkets() } };
  }

  const listingAutoAcceptMatch = pathname.match(/^\/v1\/listings\/([^/]+)\/auto-accept-rules$/);
  if (method === 'GET' && listingAutoAcceptMatch) {
    return {
      status: 200,
      body: {
        autoAcceptRules: await store.listAutoAcceptRules(listingAutoAcceptMatch[1])
      }
    };
  }

  if (method === 'POST' && listingAutoAcceptMatch) {
    const authResult = await authenticateAgent(headers, store);
    if (authResult.error) return authResult.error;

    const listing = await store.getListing(listingAutoAcceptMatch[1]);
    if (!listing) return { status: 404, body: { error: 'listing_not_found' } };

    const errors = validateAutoAcceptRuleInput(body);
    if (errors.length > 0) return { status: 400, body: { error: 'invalid_auto_accept_rule', errors } };
    const actorError = requireBodyActorMatchesSession(body, authResult.auth);
    if (actorError) return actorError;
    if (authResult.auth.agentId !== listing.sellerAgentId) {
      return { status: 403, body: { error: 'seller_actor_required' } };
    }

    return await store.withIdempotency(
      {
        scope: `POST /v1/listings/${listing.id}/auto-accept-rules`,
        key: idempotencyKey(headers, body),
        input: { ...body, actorAgentId: authResult.auth.agentId }
      },
      async () => {
        const rule = await store.createAutoAcceptRule(listing, {
          ...body,
          actorAgentId: authResult.auth.agentId
        });
        return { status: 201, body: { autoAcceptRule: rule } };
      }
    );
  }

  if (method === 'GET' && pathname === '/v1/agents') {
    return { status: 200, body: { agents: await store.listAgents() } };
  }

  if (method === 'GET' && pathname === '/v1/admin/audit') {
    const adminError = requireAdmin(headers);
    if (adminError) return adminError;

    const dashboardLimit = 10000;
    const [
      agents,
      listings,
      offers,
      trades,
      escrowEvents,
      moderationEvents,
      reputationEvents,
      auditEvents,
      requestLogs
    ] = await Promise.all([
      store.listAgents(),
      store.listListings({ limit: dashboardLimit, offset: 0 }),
      store.listOffers({ limit: dashboardLimit, offset: 0 }),
      store.listTrades({ limit: dashboardLimit, offset: 0 }),
      store.listEscrowEvents(),
      store.listModerationEvents(),
      store.listReputationEvents(),
      typeof store.listAuditEvents === 'function' ? store.listAuditEvents({ limit: 100, offset: 0 }) : [],
      typeof store.listRequestLogs === 'function' ? store.listRequestLogs({ limit: 100, offset: 0 }) : []
    ]);

    return {
      status: 200,
      body: {
        generatedAt: new Date().toISOString(),
        runtime: getSafeRuntimeStatus(),
        totals: {
          agents: agents.length,
          listings: listings.length,
          offers: offers.length,
          trades: trades.length,
          escrowEvents: escrowEvents.length,
          moderationEvents: moderationEvents.length,
          reputationEvents: reputationEvents.length,
          auditEvents: auditEvents.length,
          requestLogs: requestLogs.length
        },
        breakdowns: {
          listingsByStatus: countBy(listings, 'status'),
          listingsByAssuranceTier: countBy(listings, 'assuranceTier'),
          offersByStatus: countBy(offers, 'status'),
          tradesByState: countBy(trades, 'state'),
          requestLogsByStatus: countBy(requestLogs, 'status'),
          auditEventsBySeverity: countBy(auditEvents, 'severity')
        },
        recent: {
          trades: recent(trades),
          reputationEvents: recent(reputationEvents),
          escrowEvents: recent(escrowEvents),
          moderationEvents: recent(moderationEvents),
          auditEvents: recent(auditEvents),
          requestLogs: recent(requestLogs)
        }
      }
    };
  }

  if (method === 'GET' && pathname === '/v1/admin/events') {
    const adminError = requireAdmin(headers);
    if (adminError) return adminError;
    const listQuery = parseListQuery(query, {
      type: {},
      severity: {},
      resourceType: {},
      resourceId: {},
      actorAgentId: {}
    });
    if (listQuery.errors) return { status: 400, body: { error: 'invalid_query', errors: listQuery.errors } };
    return { status: 200, body: paginatedBody('events', await store.listAuditEvents(listQuery.filters), listQuery.filters) };
  }

  if (method === 'GET' && pathname === '/v1/admin/request-logs') {
    const adminError = requireAdmin(headers);
    if (adminError) return adminError;
    const listQuery = parseListQuery(query, { status: { type: 'integer' } });
    if (listQuery.errors) return { status: 400, body: { error: 'invalid_query', errors: listQuery.errors } };
    return { status: 200, body: paginatedBody('requestLogs', await store.listRequestLogs(listQuery.filters), listQuery.filters) };
  }

  if (method === 'GET' && pathname === '/v1/admin/moderation') {
    const adminError = requireAdmin(headers);
    if (adminError) return adminError;
    return { status: 200, body: { moderationEvents: await store.listModerationEvents() } };
  }

  const adminInspectMatch = pathname.match(/^\/v1\/admin\/inspect\/(agents|listings|offers|trades)\/([^/]+)$/);
  if (method === 'GET' && adminInspectMatch) {
    const adminError = requireAdmin(headers);
    if (adminError) return adminError;
    const [, type, id] = adminInspectMatch;
    const readers = {
      agents: () => store.getAgent(id),
      listings: () => store.getListing(id),
      offers: () => store.getOffer(id),
      trades: () => store.getTrade(id)
    };
    const resource = await readers[type]();
    if (!resource) return { status: 404, body: { error: 'resource_not_found' } };
    const singular = type.slice(0, -1);
    const events = await store.listAuditEvents({
      limit: 50,
      offset: 0,
      resourceType: singular === 'agencie' ? 'agent' : singular,
      resourceId: id
    });
    return { status: 200, body: { type, id, resource, events } };
  }

  const adminPauseListingMatch = pathname.match(/^\/v1\/admin\/listings\/([^/]+)\/pause$/);
  if (method === 'POST' && adminPauseListingMatch) {
    const adminError = requireAdmin(headers);
    if (adminError) return adminError;
    const listing = await store.pauseListing(adminPauseListingMatch[1], {
      reason: body.reason ?? null,
      actor: 'admin'
    });
    if (!listing) return { status: 404, body: { error: 'listing_not_found' } };
    return { status: 200, body: { listing } };
  }

  const adminFlagAgentMatch = pathname.match(/^\/v1\/admin\/agents\/([^/]+)\/flag$/);
  if (method === 'POST' && adminFlagAgentMatch) {
    const adminError = requireAdmin(headers);
    if (adminError) return adminError;
    const agent = await store.flagAgent(adminFlagAgentMatch[1], {
      reason: body.reason ?? null,
      actor: 'admin'
    });
    if (!agent) return { status: 404, body: { error: 'agent_not_found' } };
    return { status: 200, body: { agent } };
  }

  const agentReputationMatch = pathname.match(/^\/v1\/agents\/([^/]+)\/reputation$/);
  if (method === 'GET' && agentReputationMatch) {
    const agent = await store.getAgent(agentReputationMatch[1]);
    if (!agent) return { status: 404, body: { error: 'agent_not_found' } };
    return {
      status: 200,
      body: {
        agent,
        reputationEvents: await store.listReputationEvents(agent.id)
      }
    };
  }

  const agentMatch = pathname.match(/^\/v1\/agents\/([^/]+)$/);
  if (method === 'GET' && agentMatch) {
    const agent = await store.getAgent(agentMatch[1]);
    if (!agent) return { status: 404, body: { error: 'agent_not_found' } };
    return { status: 200, body: { agent } };
  }

  if (method === 'POST' && pathname === '/v1/maintenance/cleanup') {
    const adminError = requireAdmin(headers);
    if (adminError) return adminError;
    const cleanup = await store.cleanupExpired();
    await safeRecordAudit(store, {
      type: 'maintenance.cleanup',
      severity: 'info',
      payload: cleanup
    });
    return { status: 200, body: { cleanup } };
  }

  if (method === 'POST' && pathname === '/v1/agents/register') {
    const errors = validateAgentInput(body);

    if (errors.length > 0) {
      return { status: 400, body: { error: 'invalid_agent', errors } };
    }

    const agent = await store.createAgent(body);
    return { status: 201, body: { agent } };
  }

  const challengeMatch = pathname.match(/^\/v1\/agents\/([^/]+)\/verify\/challenge$/);
  if (method === 'POST' && challengeMatch) {
    const agent = await store.getAgent(challengeMatch[1]);
    if (!agent) {
      return { status: 404, body: { error: 'agent_not_found' } };
    }
    if (!agent.publicKeyJwk) {
      return {
        status: 409,
        body: {
          error: 'agent_key_required',
          message: 'Register an Ed25519 publicKeyJwk before requesting a verification challenge.'
        }
      };
    }

    const challenge = await store.createChallenge(agent.id);
    return { status: 201, body: { challenge } };
  }

  const verifyMatch = pathname.match(/^\/v1\/agents\/([^/]+)\/verify\/response$/);
  if (method === 'POST' && verifyMatch) {
    const agent = await store.getAgent(verifyMatch[1]);
    if (!agent) {
      return { status: 404, body: { error: 'agent_not_found' } };
    }

    const challenge = await store.getChallenge(body.challengeId);
    if (!challenge || challenge.agentId !== agent.id) {
      return { status: 404, body: { error: 'challenge_not_found' } };
    }
    if (challenge.usedAt) {
      return { status: 409, body: { error: 'challenge_already_used' } };
    }
    if (Date.parse(challenge.expiresAt) <= Date.now()) {
      return { status: 410, body: { error: 'challenge_expired' } };
    }

    const verified = verifyEd25519Signature({
      publicKeyJwk: agent.publicKeyJwk,
      message: challenge.canonical,
      signatureBase64: body.signature
    });

    if (!verified) {
      return { status: 401, body: { error: 'invalid_signature' } };
    }

    await store.markChallengeUsed(challenge.id);
    const session = await store.createSession(agent.id);
    return { status: 201, body: { session } };
  }

  if (method === 'POST' && pathname === '/v1/listings') {
    const authResult = await authenticateAgent(headers, store);
    if (authResult.error) return authResult.error;

    const input = body;
    const errors = validateListingInput(input);

    if (errors.length > 0) {
      return { status: 400, body: { error: 'invalid_listing', errors } };
    }

    const actorError = requireFieldMatchesSession('sellerAgentId', input.sellerAgentId, authResult.auth);
    if (actorError) return actorError;

    if (!(await store.getAgent(input.sellerAgentId))) {
      return {
        status: 404,
        body: {
          error: 'seller_agent_not_found',
          message: 'Listings must be tied to a registered seller agent.'
        }
      };
    }

    const screening = screenListing(input);
    if (!screening.allowed) {
      const moderationEvent = await store.recordBlockedListingAttempt(input, screening);
      logWarn('policy.blocked_listing', {
        sellerAgentId: input.sellerAgentId,
        category: input.category,
        reportable: screening.reportable,
        matches: screening.matches.map((match) => match.id),
        moderationEventId: moderationEvent.id
      });
      return {
        status: 422,
        body: {
          error: 'prohibited_listing',
          message:
            'This listing violates Agent Exchange policy and cannot be created. Severe abuse attempts may be preserved and reported to appropriate authorities.',
          reportable: screening.reportable,
          matches: screening.matches,
          moderationEventId: moderationEvent.id
        }
      };
    }

    const listing = await store.createListing(input, screening);
    return { status: 201, body: { listing } };
  }

  if (method === 'POST' && pathname === '/v1/trades') {
    const authResult = await authenticateAgent(headers, store);
    if (authResult.error) return authResult.error;

    const input = body;
    const errors = validateTradeInput(input);

    if (errors.length > 0) {
      return { status: 400, body: { error: 'invalid_trade', errors } };
    }

    const actorError = requireFieldMatchesSession('buyerAgentId', input.buyerAgentId, authResult.auth);
    if (actorError) return actorError;

    const listing = await store.getListing(input.listingId);
    if (!listing) {
      return { status: 404, body: { error: 'listing_not_found' } };
    }
    if (!(await store.getAgent(input.buyerAgentId))) {
      return {
        status: 404,
        body: {
          error: 'buyer_agent_not_found',
          message: 'Trades must be tied to a registered buyer agent.'
        }
      };
    }
    if (input.buyerAgentId === listing.sellerAgentId) {
      return {
        status: 409,
        body: {
          error: 'self_trade_blocked',
          message: 'An agent cannot trade with itself.'
        }
      };
    }

    const tier = assuranceTiers[listing.assuranceTier];
    if (tier.buyerAcknowledgementRequired && input.assuranceAcknowledgement !== true) {
      return {
        status: 409,
        body: {
          error: 'assurance_acknowledgement_required',
          assuranceTier: tier,
          message:
            'This listing is not platform-verified. The buyer agent must explicitly acknowledge the assurance tier before trading.'
        }
      };
    }

    return await store.withIdempotency(
      {
        scope: 'POST /v1/trades',
        key: idempotencyKey(headers, input),
        input
      },
      async () => {
        if (!listingAcceptsNewTrades(listing)) {
          return { status: 409, body: { error: 'listing_not_tradeable', status: listing.status } };
        }
        const result = await store.createTrade(input, listing);
        if (result.error) {
          return { status: 409, body: result.error };
        }
        return { status: 201, body: { trade: result.trade, reservation: result.reservation } };
      }
    );
  }

  if (method === 'GET' && pathname === '/v1/trades') {
    const listQuery = parseListQuery(query, {
      listingId: {},
      buyerAgentId: {},
      sellerAgentId: {},
      state: {}
    });
    if (listQuery.errors) return { status: 400, body: { error: 'invalid_query', errors: listQuery.errors } };
    const trades = await store.listTrades(listQuery.filters);
    return { status: 200, body: paginatedBody('trades', trades, listQuery.filters) };
  }

  const tradeMatch = pathname.match(/^\/v1\/trades\/([^/]+)$/);
  if (method === 'GET' && tradeMatch) {
    const trade = await store.getTrade(tradeMatch[1]);
    if (!trade) return { status: 404, body: { error: 'trade_not_found' } };
    return { status: 200, body: { trade } };
  }

  if (method === 'GET' && pathname === '/v1/offers') {
    const listQuery = parseListQuery(query, {
      listingId: {},
      buyerAgentId: {},
      sellerAgentId: {},
      status: {}
    });
    if (listQuery.errors) return { status: 400, body: { error: 'invalid_query', errors: listQuery.errors } };
    const offers = await store.listOffers(listQuery.filters);
    return { status: 200, body: paginatedBody('offers', offers, listQuery.filters) };
  }

  const offerMatch = pathname.match(/^\/v1\/offers\/([^/]+)$/);
  if (method === 'GET' && offerMatch) {
    const offer = await store.getOffer(offerMatch[1]);
    if (!offer) return { status: 404, body: { error: 'offer_not_found' } };
    return { status: 200, body: { offer } };
  }

  if (method === 'POST' && pathname === '/v1/offers') {
    const authResult = await authenticateAgent(headers, store);
    if (authResult.error) return authResult.error;

    const errors = validateOfferInput(body);
    if (errors.length > 0) return { status: 400, body: { error: 'invalid_offer', errors } };
    const actorError = requireFieldMatchesSession('buyerAgentId', body.buyerAgentId, authResult.auth);
    if (actorError) return actorError;

    const listing = await store.getListing(body.listingId);
    if (!listing) return { status: 404, body: { error: 'listing_not_found' } };
    if (!listingAcceptsNewTrades(listing)) {
      return { status: 409, body: { error: 'listing_not_tradeable', status: listing.status } };
    }
    if (!listing.acceptsOffers) return { status: 409, body: { error: 'listing_does_not_accept_offers' } };
    if (!(await store.getAgent(body.buyerAgentId))) return { status: 404, body: { error: 'buyer_agent_not_found' } };
    if (body.buyerAgentId === listing.sellerAgentId) {
      return { status: 409, body: { error: 'self_trade_blocked' } };
    }
    if (assuranceTiers[listing.assuranceTier].buyerAcknowledgementRequired && body.assuranceAcknowledgement !== true) {
      return { status: 409, body: { error: 'assurance_acknowledgement_required' } };
    }

    return await store.withIdempotency(
      {
        scope: 'POST /v1/offers',
        key: idempotencyKey(headers, body),
        input: { ...body, actorAgentId: authResult.auth.agentId }
      },
      async () => {
        const offer = await store.createOffer(
          {
            ...body,
            actorAgentId: authResult.auth.agentId
          },
          listing
        );
        const autoAccept = await store.evaluateAutoAccept(offer);
        return {
          status: 201,
          body: {
            offer,
            autoAccept
          }
        };
      }
    );
  }

  const offerActionMatch = pathname.match(/^\/v1\/offers\/([^/]+)\/([^/]+)$/);
  if (method === 'POST' && offerActionMatch) {
    const authResult = await authenticateAgent(headers, store);
    if (authResult.error) return authResult.error;

    const [, offerId, rawAction] = offerActionMatch;
    const offer = await store.getOffer(offerId);
    if (!offer) return { status: 404, body: { error: 'offer_not_found' } };

    const actorError = requireBodyActorMatchesSession(body, authResult.auth);
    if (actorError) return actorError;
    const actor = authResult.auth.agentId;

    if (rawAction === 'counter') {
      const errors = validateOfferInput({
        ...body,
        listingId: offer.listingId,
        buyerAgentId: offer.buyerAgentId
      });
      if (errors.length > 0) return { status: 400, body: { error: 'invalid_counteroffer', errors } };
      if (!actorCanCounter({ offer, actorAgentId: actor })) {
        return { status: 403, body: { error: 'counterparty_actor_required' } };
      }
      return await store.withIdempotency(
        {
          scope: `POST /v1/offers/${offerId}/counter`,
          key: idempotencyKey(headers, body),
          input: { ...body, actorAgentId: actor }
        },
        async () => {
          const counterOffer = await store.counterOffer(offer, {
            ...body,
            actorAgentId: actor
          });
          return { status: 201, body: { offer: counterOffer } };
        }
      );
    }

    if (rawAction === 'accept') {
      if (!actorCanAccept({ offer, actorAgentId: actor })) {
        return { status: 403, body: { error: 'counterparty_actor_required' } };
      }
      return await store.withIdempotency(
        {
          scope: `POST /v1/offers/${offerId}/accept`,
          key: idempotencyKey(headers, body),
          input: { ...body, actorAgentId: actor }
        },
        () => store.acceptOffer(offerId, actor)
      );
    }

    if (rawAction === 'reject') {
      if (!actorCanReject({ offer, actorAgentId: actor })) {
        return { status: 403, body: { error: 'counterparty_actor_required' } };
      }
      const rejected = await store.rejectOffer(offerId, actor);
      return { status: 200, body: { offer: rejected } };
    }

    if (rawAction === 'withdraw') {
      if (!actorCanWithdraw({ offer, actorAgentId: actor })) {
        return { status: 403, body: { error: 'offer_creator_required' } };
      }
      const withdrawn = await store.withdrawOffer(offerId, actor);
      return { status: 200, body: { offer: withdrawn } };
    }

    if (rawAction === 'expire') {
      if (actor !== offer.buyerAgentId && actor !== offer.sellerAgentId) {
        return { status: 403, body: { error: 'trade_party_required' } };
      }
      const expired = await store.expireOffer(offerId, actor);
      return { status: 200, body: { offer: expired } };
    }

    return { status: 404, body: { error: 'unknown_offer_action' } };
  }

  const autoAcceptDisableMatch = pathname.match(/^\/v1\/auto-accept-rules\/([^/]+)\/disable$/);
  if (method === 'POST' && autoAcceptDisableMatch) {
    const authResult = await authenticateAgent(headers, store);
    if (authResult.error) return authResult.error;
    const actorError = requireBodyActorMatchesSession(body, authResult.auth);
    if (actorError) return actorError;
    const actor = authResult.auth.agentId;

    const existingRule = await store.getAutoAcceptRule(autoAcceptDisableMatch[1]);
    if (!existingRule) return { status: 404, body: { error: 'auto_accept_rule_not_found' } };
    if (existingRule.sellerAgentId !== actor) return { status: 403, body: { error: 'seller_actor_required' } };
    const rule = await store.disableAutoAcceptRule(autoAcceptDisableMatch[1], actor);
    return { status: 200, body: { autoAcceptRule: rule } };
  }

  if (method === 'GET' && pathname === '/v1/inventory/reservations') {
    return { status: 200, body: { reservations: await store.listInventoryReservations() } };
  }

  const tradeActionMatch = pathname.match(/^\/v1\/trades\/([^/]+)\/([^/]+)$/);
  if (method === 'POST' && tradeActionMatch) {
    const [, tradeId, rawAction] = tradeActionMatch;
    const action = rawAction === 'resolve' ? `resolve_${body.resolution}` : rawAction;
    const transition = getTransition(action);

    if (!transition) {
      return { status: 404, body: { error: 'unknown_trade_action' } };
    }

    const trade = await store.getTrade(tradeId);
    if (!trade) {
      return { status: 404, body: { error: 'trade_not_found' } };
    }
    if (!canTransition(trade, transition)) {
      return {
        status: 409,
        body: {
          error: 'invalid_trade_transition',
          state: trade.state,
          action: rawAction,
          allowedFrom: transition.from
        }
      };
    }

    let actor = null;
    if (rawAction === 'resolve') {
      const adminError = requireAdmin(headers);
      if (adminError) return adminError;
      actor = 'admin';
    } else if (rawAction === 'refund' && body.actorRole === 'admin') {
      const adminError = requireAdmin(headers);
      if (adminError) return adminError;
      actor = 'admin';
    } else {
      const authResult = await authenticateAgent(headers, store);
      if (authResult.error) return authResult.error;
      const actorError = requireBodyActorMatchesSession(body, authResult.auth);
      if (actorError) return actorError;
      actor = authResult.auth.agentId;
    }

    const authzError = authorizeTradeAction({ rawAction, trade, actor, body });
    if (authzError) {
      return { status: 403, body: authzError };
    }

    return await store.withIdempotency(
      {
        scope: `POST /v1/trades/${tradeId}/${rawAction}`,
        key: idempotencyKey(headers, body),
        input: { ...body, actorAgentId: actor }
      },
      async () => {
        const escrowEvent = transition.escrowType
          ? await store.createEscrowEvent({
              tradeId,
              type: transition.escrowType,
              amountUsdc: trade.priceUsdc,
              actor,
              payload: {
                note: 'Stub escrow adapter; replace with Commerce Payments integration.'
              }
            })
          : null;

        const updatedTrade = await store.transitionTrade(tradeId, {
          to: transition.to,
          eventType: transition.eventType,
          actor,
          payload: {
            proof: body.proof ?? null,
            reason: body.reason ?? null,
            resolution: body.resolution ?? null,
            escrowEventId: escrowEvent?.id ?? null
          }
        });

        return { status: 200, body: { trade: updatedTrade, escrowEvent } };
      }
    );
  }

  if (method === 'GET' && pathname === '/v1/escrow/events') {
    return { status: 200, body: { escrowEvents: await store.listEscrowEvents() } };
  }

  return { status: 404, body: { error: 'not_found' } };
}

export function createApp({
  store = defaultStore,
  rateLimiter = createRateLimiter(runtimeConfig.rateLimit)
} = {}) {
  return http.createServer(async (req, res) => {
    const requestId = createRequestId();
    const startedAt = performance.now();
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && await serveAdminAsset(url.pathname, res)) {
        const latencyMs = Math.round((performance.now() - startedAt) * 100) / 100;
        logInfo('http.request', {
          requestId,
          method: req.method,
          path: url.pathname,
          status: 200,
          latencyMs
        });
        await safeRecordRequest(store, {
          requestId,
          method: req.method,
          path: url.pathname,
          route: url.pathname,
          status: 200,
          latencyMs,
          ipHash: hashIp(clientIp(req)),
          userAgent: req.headers['user-agent'] ?? null
        });
       return;
      }

      if (req.method === 'GET' && url.pathname === '/v1/admin/events/stream') {
        const adminError = requireAdmin(req.headers);
        if (adminError) {
          return json(res, adminError.status, { ...adminError.body, requestId });
        }

        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-request-id': requestId
        });

        let lastEventId = null;
        const sendEvents = async () => {
          const events = await store.listAuditEvents({ limit: 25, offset: 0 });
          const fresh = lastEventId
            ? events.slice(0, Math.max(0, events.findIndex((event) => event.id === lastEventId))).reverse()
            : events.slice(0, 10).reverse();
          for (const event of fresh) {
            res.write(`id: ${event.id}\n`);
            res.write(`event: audit\n`);
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          }
          if (events[0]) lastEventId = events[0].id;
        };

        await sendEvents();
        const timer = setInterval(() => {
          sendEvents().catch((error) => {
            logWarn('audit.stream_failed', { requestId, error });
          });
        }, 2000);
        req.on('close', () => clearInterval(timer));
        return;
      }

      const rateLimit = rateLimiter.check(req, url.pathname);
      if (!rateLimit.allowed) {
        const latencyMs = Math.round((performance.now() - startedAt) * 100) / 100;
        const actor = await resolveRequestActor(req.headers, store);
        logWarn('http.rate_limited', {
          requestId,
          method: req.method,
          path: url.pathname,
          bucket: rateLimit.bucket,
          retryAfterSeconds: rateLimit.retryAfterSeconds,
          latencyMs
        });
        await safeRecordRequest(store, {
          requestId,
          method: req.method,
          path: url.pathname,
          route: url.pathname,
          status: 429,
          latencyMs,
          ...actor,
          errorCode: 'rate_limited',
          ipHash: hashIp(clientIp(req)),
          userAgent: req.headers['user-agent'] ?? null
        });
        await safeRecordAudit(store, {
          type: 'http.rate_limited',
          severity: 'warn',
          actorAgentId: actor.actorAgentId,
          sessionId: actor.sessionId,
          requestId,
          payload: {
            method: req.method,
            path: url.pathname,
            bucket: rateLimit.bucket,
            retryAfterSeconds: rateLimit.retryAfterSeconds
          }
        });
        return json(
          res,
          429,
          {
            error: 'rate_limited',
            message: 'Too many requests. Retry after the number of seconds in the Retry-After header.',
            requestId
          },
          rateLimit.headers
        );
      }

      const body = req.method === 'GET' ? {} : await readJson(req);
      const result = await handleApiRequest(
        {
          method: req.method,
          pathname: url.pathname,
          query: Object.fromEntries(url.searchParams.entries()),
          body,
          headers: req.headers
        },
        store
      );
      result.body.requestId = requestId;
      const latencyMs = Math.round((performance.now() - startedAt) * 100) / 100;
      const actor = await resolveRequestActor(req.headers, store);
      logInfo('http.request', {
        requestId,
        method: req.method,
        path: url.pathname,
        status: result.status,
        latencyMs
      });
      await safeRecordRequest(store, {
        requestId,
        method: req.method,
        path: url.pathname,
        route: url.pathname,
        status: result.status,
        latencyMs,
        ...actor,
        errorCode: result.status >= 400 ? result.body.error ?? null : null,
        ipHash: hashIp(clientIp(req)),
        userAgent: req.headers['user-agent'] ?? null
      });
      if (result.status >= 400) {
        await safeRecordAudit(store, {
          type: result.status >= 500 ? 'http.error_response' : 'http.rejected_request',
          severity: result.status >= 500 ? 'error' : 'warn',
          actorAgentId: actor.actorAgentId,
          sessionId: actor.sessionId,
          requestId,
          payload: {
            method: req.method,
            path: url.pathname,
            status: result.status,
            error: result.body.error ?? null
          }
        });
      }
      return json(res, result.status, result.body, rateLimit.headers);
    } catch (error) {
      const status = error.code === 'REQUEST_BODY_TOO_LARGE'
        ? 413
        : error instanceof SyntaxError
          ? 400
          : 500;
      const latencyMs = Math.round((performance.now() - startedAt) * 100) / 100;
      logError('http.error', {
        requestId,
        method: req.method,
        status,
        latencyMs,
        error
      });
      await safeRecordRequest(store, {
        requestId,
        method: req.method,
        path: req.url ?? '',
        route: req.url ?? '',
        status,
        latencyMs,
        errorCode: error.code ?? (error instanceof SyntaxError ? 'invalid_json' : 'internal_error'),
        ipHash: hashIp(clientIp(req)),
        userAgent: req.headers['user-agent'] ?? null
      });
      await safeRecordAudit(store, {
        type: 'http.error',
        severity: status >= 500 ? 'error' : 'warn',
        requestId,
        payload: {
          method: req.method,
          path: req.url ?? '',
          status,
          error: error.message,
          code: error.code ?? null
        }
      });
      if (error.code === 'REQUEST_BODY_TOO_LARGE') {
        return json(res, 413, { error: 'request_body_too_large', requestId });
      }
      if (error instanceof SyntaxError) {
        return json(res, 400, { error: 'invalid_json', requestId });
      }

      return json(res, 500, {
        error: 'internal_error',
        message: error.message,
        requestId
      });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = getConfig().port;
  const server = createApp();
  server.listen(port, () => {
    console.log(`Agent Exchange API listening on http://localhost:${port}`);
  });
}
