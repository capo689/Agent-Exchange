import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import { getConfig, getSafeRuntimeStatus } from './config.js';
import { verifyEd25519Signature } from './crypto.js';
import { createRequestId, error as logError, info as logInfo, warn as logWarn } from './logger.js';
import { compareUsdc } from './money.js';
import { actorCanAccept, actorCanCounter, actorCanReject, actorCanWithdraw } from './negotiation.js';
import {
  escrowContractAbi,
  escrowTradeIdHash,
  verifyEscrowContractEvent
} from './escrow-contract.js';
import { getEscrowWatcherStatus, runEscrowWatcher } from './escrow-watcher.js';
import { verifyOnchainUsdcTransfer } from './onchain.js';
import {
  buildX402PaymentRequirements,
  canonicalJson,
  paymentStatuses,
  parseX402PaymentPayload,
  settleX402Payment,
  usdcToAtomicAmount,
  verifySandboxWebhookSignature
} from './payments.js';
import { assuranceTiers, getPolicyResponse, screenListing } from './policy.js';
import { createPostgresStore } from './postgres-store.js';
import { createRateLimiter } from './rate-limit.js';
import { buildReconciliationReport } from './reconciliation.js';
import { deliverOutboundWebhook } from './outbound-webhooks.js';
import { createStore } from './store.js';
import { canTransition, getTransition } from './trades.js';

const runtimeConfig = getConfig();
const defaultStore = runtimeConfig.databaseUrl
  ? createPostgresStore({ connectionString: runtimeConfig.databaseUrl })
  : createStore(runtimeConfig.dataDir ? { filePath: `${runtimeConfig.dataDir}/agent-exchange.json` } : {});
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
const paidMarketSnapshotPriceUsdc = '0.01';
const paidAccessProviders = new Set(['x402', 'manual_usdc']);

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

function validateApiKeyInput(input) {
  const errors = [];
  if (!input || typeof input !== 'object') errors.push('body must be a JSON object');
  if (!input.name || typeof input.name !== 'string') errors.push('name is required');
  if (input.scopes !== undefined) {
    if (!Array.isArray(input.scopes) || input.scopes.some((scope) => typeof scope !== 'string')) {
      errors.push('scopes must be an array of strings');
    }
  }
  if (input.expiresAt !== undefined && input.expiresAt !== null && Number.isNaN(Date.parse(input.expiresAt))) {
    errors.push('expiresAt must be an ISO timestamp when supplied');
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

function listingQuality(listing, seller = null) {
  const checks = [
    {
      key: 'title',
      passed: String(listing.title ?? '').trim().length >= 8,
      message: 'Title is specific enough to scan.'
    },
    {
      key: 'description',
      passed: String(listing.description ?? '').trim().length >= 40,
      message: 'Description explains what the buyer receives.'
    },
    {
      key: 'category',
      passed: Boolean(listing.category),
      message: 'Category is present.'
    },
    {
      key: 'price',
      passed: Boolean(listing.priceUsdc),
      message: 'Price is present.'
    },
    {
      key: 'sellerAccountability',
      passed: Boolean(seller?.publicKeyJwk) && seller?.status !== 'flagged',
      message: 'Seller has a usable agent identity and is not flagged.'
    },
    {
      key: 'policyScreened',
      passed: Boolean(listing.screening),
      message: 'Listing has a policy-screening result.'
    }
  ];
  const passed = checks.filter((check) => check.passed).length;
  return {
    score: Math.round((passed / checks.length) * 100),
    checks
  };
}

function agentOnboardingStatus(agent, listings = []) {
  const activeListings = listings.filter((listing) => listing.sellerAgentId === agent.id && listing.status !== 'blocked');
  const checks = [
    {
      key: 'identity',
      passed: Boolean(agent.publicKeyJwk),
      message: 'Agent has an Ed25519 public key.'
    },
    {
      key: 'sessionReady',
      passed: agent.status === 'active',
      message: 'Agent is active and can authenticate requests.'
    },
    {
      key: 'reputation',
      passed: Number(agent.reputationScore) >= 50,
      message: 'Agent has enough reputation for private alpha demos.'
    },
    {
      key: 'listingReady',
      passed: activeListings.length > 0,
      message: 'Agent has at least one non-blocked listing.'
    },
    {
      key: 'wallet',
      passed: Boolean(agent.walletAddress),
      message: 'Agent has a wallet address on file.'
    }
  ];
  const passed = checks.filter((check) => check.passed).length;
  return {
    agentId: agent.id,
    ready: passed >= 4 && agent.status !== 'flagged',
    score: Math.round((passed / checks.length) * 100),
    activeListings: activeListings.length,
    checks
  };
}

function searchText(value) {
  return String(value ?? '').toLowerCase();
}

function recent(items, limit = 12) {
  return [...items]
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
    .slice(0, limit);
}

async function authorizePaidAccess({ store, headers, query, priceUsdc, resource }) {
  const paymentIntentId =
    queryValue(query, 'paymentIntentId') ??
    getHeader(headers, 'x-payment-intent-id');
  if (!paymentIntentId) {
    return {
      error: {
        status: 402,
        body: {
          error: 'payment_intent_required',
          resource,
          priceUsdc,
          acceptedProviders: [...paidAccessProviders],
          instructions: 'Pay with x402 or manual_usdc, then retry with paymentIntentId query param or x-payment-intent-id header.'
        }
      }
    };
  }

  const paymentIntent = await store.getPaymentIntent(paymentIntentId);
  if (!paymentIntent) {
    return { error: { status: 404, body: { error: 'payment_intent_not_found' } } };
  }
  if (!paidAccessProviders.has(paymentIntent.provider)) {
    return {
      error: {
        status: 402,
        body: {
          error: 'payment_provider_not_accepted',
          provider: paymentIntent.provider,
          acceptedProviders: [...paidAccessProviders]
        }
      }
    };
  }
  if (paymentIntent.status !== paymentStatuses.succeeded) {
    return {
      error: {
        status: 402,
        body: {
          error: 'payment_not_settled',
          paymentStatus: paymentIntent.status
        }
      }
    };
  }
  if (compareUsdc(paymentIntent.amountUsdc, priceUsdc) < 0) {
    return {
      error: {
        status: 402,
        body: {
          error: 'payment_amount_too_low',
          requiredAmountUsdc: priceUsdc,
          paymentAmountUsdc: paymentIntent.amountUsdc
        }
      }
    };
  }

  await store.recordAuditEvent?.({
    type: 'paid_access.granted',
    severity: 'info',
    resourceType: 'payment_intent',
    resourceId: paymentIntent.id,
    payload: {
      resource,
      priceUsdc,
      provider: paymentIntent.provider,
      amountUsdc: paymentIntent.amountUsdc
    }
  });

  return { paymentIntent };
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
  if (token && typeof store.getSessionByToken === 'function') {
    const session = await store.getSessionByToken(token);
    if (session) return { actorAgentId: session.agentId, sessionId: session.id };
  }
  const signedAgentId = getHeader(headers, 'x-agent-id');
  return signedAgentId ? { actorAgentId: signedAgentId, sessionId: null } : {};
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
    const event = await store.recordAuditEvent(input);
    const outboundWebhook = getConfig().outboundWebhook;
    if (event && outboundWebhook.configured) {
      deliverOutboundWebhook({
        url: outboundWebhook.url,
        secret: outboundWebhook.secret,
        event
      }).catch((error) => {
        logWarn('webhook.delivery_failed', { requestId: input.requestId, type: input.type, error });
      });
    }
  } catch (error) {
    logWarn('audit.event_log_failed', { requestId: input.requestId, type: input.type, error });
  }
}

function getHeader(headers, name) {
  if (!headers) return null;
  const direct = headers[name.toLowerCase()] ?? headers[name];
  if (direct != null) return direct;
  const target = name.toLowerCase();
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === target);
  return match ? match[1] : null;
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

function getApiKeyToken(headers) {
  const direct = getHeader(headers, 'x-agent-api-key');
  if (direct && typeof direct === 'string') return direct.trim();
  const header = getHeader(headers, 'authorization');
  if (!header || typeof header !== 'string') return null;
  const match = header.match(/^ApiKey\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function normalizeQueryForSignature(query = {}) {
  if (typeof query?.entries === 'function') {
    return Object.fromEntries([...query.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }
  return Object.fromEntries(
    Object.entries(query ?? {})
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
  );
}

function signedRequestBodyDigest(body = {}) {
  return createHash('sha256').update(canonicalJson(body ?? {})).digest('hex');
}

function requestedApiScope({ method, pathname }) {
  const mode = method === 'GET' ? 'read' : 'write';
  if (pathname?.startsWith('/v1/listings')) return `listings:${mode}`;
  if (pathname?.startsWith('/v1/trades')) return `trades:${mode}`;
  if (pathname?.startsWith('/v1/offers')) return `offers:${mode}`;
  if (pathname?.startsWith('/v1/agents')) return `agents:${mode}`;
  if (pathname?.startsWith('/v1/inventory')) return `inventory:${mode}`;
  return mode;
}

function apiKeyAllowsScope(apiKey, request = {}) {
  const scopes = new Set(apiKey.scopes ?? []);
  const requested = requestedApiScope(request);
  const mode = request.method === 'GET' ? 'read' : 'write';
  return (
    scopes.has('*') ||
    scopes.has(requested) ||
    scopes.has(mode) ||
    (mode === 'read' && scopes.has('write'))
  );
}

async function authenticateApiKey(headers, store, request = {}) {
  const token = getApiKeyToken(headers);
  if (!token) return null;
  if (typeof store.getApiKeyByToken !== 'function') {
    return {
      error: {
        status: 503,
        body: {
          error: 'api_key_auth_unavailable',
          message: 'Scoped API key authentication is unavailable on this store.'
        }
      }
    };
  }
  const apiKey = await store.getApiKeyByToken(token);
  if (!apiKey) {
    return {
      error: {
        status: 401,
        body: {
          error: 'invalid_or_expired_api_key',
          message: 'The API key is invalid, revoked, or expired.'
        }
      }
    };
  }
  if (!apiKeyAllowsScope(apiKey, request)) {
    return {
      error: {
        status: 403,
        body: {
          error: 'api_key_scope_denied',
          requiredScope: requestedApiScope(request),
          scopes: apiKey.scopes
        }
      }
    };
  }
  const agent = await store.getAgent(apiKey.agentId);
  if (!agent || agent.status !== 'active') {
    return {
      error: {
        status: 401,
        body: {
          error: 'api_key_agent_inactive',
          message: 'The API key is not tied to an active agent.'
        }
      }
    };
  }

  return { auth: { session: null, apiKey, agent, agentId: agent.id, authMethod: 'api_key' } };
}

export function canonicalSignedRequest({ agentId, method, pathname, query = {}, body = {}, timestamp, nonce }) {
  return [
    'agent-exchange.request.v1',
    `agent_id:${agentId}`,
    `method:${String(method ?? '').toUpperCase()}`,
    `path:${pathname}`,
    `query:${canonicalJson(normalizeQueryForSignature(query))}`,
    `body_sha256:${signedRequestBodyDigest(body)}`,
    `timestamp:${timestamp}`,
    `nonce:${nonce}`
  ].join('\n');
}

function getSignedRequestHeaders(headers) {
  const agentId = getHeader(headers, 'x-agent-id');
  const timestamp = getHeader(headers, 'x-agent-timestamp');
  const nonce = getHeader(headers, 'x-agent-nonce');
  const signature = getHeader(headers, 'x-agent-signature');
  if (!agentId && !timestamp && !nonce && !signature) return null;
  return {
    agentId: typeof agentId === 'string' ? agentId : '',
    timestamp: typeof timestamp === 'string' ? timestamp : '',
    nonce: typeof nonce === 'string' ? nonce : '',
    signature: typeof signature === 'string' ? signature : ''
  };
}

async function authenticateSignedAgent(headers, store, request = {}) {
  const signed = getSignedRequestHeaders(headers);
  if (!signed) return null;

  const missing = Object.entries(signed).filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    return {
      error: {
        status: 401,
        body: {
          error: 'invalid_signed_request',
          message: 'Signed requests require x-agent-id, x-agent-timestamp, x-agent-nonce, and x-agent-signature.',
          missing
        }
      }
    };
  }

  const timestampMs = Date.parse(signed.timestamp);
  const skewMs = Math.abs(Date.now() - timestampMs);
  if (Number.isNaN(timestampMs) || skewMs > 5 * 60 * 1000) {
    return {
      error: {
        status: 401,
        body: {
          error: 'signed_request_timestamp_invalid',
          message: 'Signed request timestamp must be an ISO timestamp within five minutes of server time.'
        }
      }
    };
  }

  const agent = await store.getAgent(signed.agentId);
  if (!agent || agent.status !== 'active' || !agent.publicKeyJwk) {
    return {
      error: {
        status: 401,
        body: {
          error: 'signed_request_agent_inactive',
          message: 'Signed request agent is missing, inactive, or has no public key.'
        }
      }
    };
  }

  const canonical = canonicalSignedRequest({
    agentId: signed.agentId,
    method: request.method,
    pathname: request.pathname,
    query: request.query,
    body: request.body,
    timestamp: signed.timestamp,
    nonce: signed.nonce
  });
  const valid = verifyEd25519Signature({
    publicKeyJwk: agent.publicKeyJwk,
    message: canonical,
    signatureBase64: signed.signature
  });
  if (!valid) {
    return {
      error: {
        status: 401,
        body: {
          error: 'signed_request_signature_invalid',
          message: 'Signed request signature could not be verified.'
        }
      }
    };
  }

  if (typeof store.recordSignedRequestNonce !== 'function') {
    return {
      error: {
        status: 503,
        body: {
          error: 'signed_request_nonce_store_unavailable',
          message: 'Signed request replay protection is unavailable.'
        }
      }
    };
  }

  const nonceResult = await store.recordSignedRequestNonce({
    agentId: signed.agentId,
    nonce: signed.nonce,
    expiresAt: new Date(timestampMs + 5 * 60 * 1000).toISOString()
  });
  if (nonceResult.error) return nonceResult;

  return {
    auth: {
      session: null,
      agent,
      agentId: agent.id,
      authMethod: 'signed_request',
      signedRequest: {
        timestamp: signed.timestamp,
        nonce: signed.nonce
      }
    }
  };
}

async function authenticateAgent(headers, store, request = {}) {
  const token = getBearerToken(headers);
  if (!token) {
    const apiKeyResult = await authenticateApiKey(headers, store, request);
    if (apiKeyResult) return apiKeyResult;
    const signedResult = await authenticateSignedAgent(headers, store, request);
    if (signedResult) return signedResult;
    return {
      error: {
        status: 401,
        body: {
          error: 'authentication_required',
          message: 'Use Authorization: Bearer <session token> or Ed25519 signed request headers for this request.'
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

  return { auth: { session, agent, agentId: agent.id, authMethod: 'bearer_session' } };
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

function isAdminRequest(headers) {
  const expected = process.env.ADMIN_TOKEN;
  return Boolean(expected && getHeader(headers, 'x-admin-token') === expected);
}

async function authorizeAdminOrAgent(headers, store, request = {}) {
  if (isAdminRequest(headers)) {
    return { access: { role: 'admin', isAdmin: true, agentId: null, agent: null, session: null } };
  }

  const authResult = await authenticateAgent(headers, store, request);
  if (authResult.error) return authResult;
  return {
    access: {
      role: 'agent',
      isAdmin: false,
      agentId: authResult.auth.agentId,
      agent: authResult.auth.agent,
      session: authResult.auth.session
    }
  };
}

function requireOwnAgentOrAdmin(agentId, access) {
  if (access.isAdmin || access.agentId === agentId) return null;
  return {
    status: 403,
    body: {
      error: 'resource_access_denied',
      message: 'This resource is visible only to the owning agent or an admin.'
    }
  };
}

function isTradeParty(trade, agentId) {
  return trade?.buyerAgentId === agentId || trade?.sellerAgentId === agentId;
}

function isOfferParty(offer, agentId) {
  return offer?.buyerAgentId === agentId || offer?.sellerAgentId === agentId || offer?.createdByAgentId === agentId;
}

function paginateScoped(items, filters) {
  return items.slice(filters.offset, filters.offset + filters.limit);
}

function scopedQueryForList(filters) {
  return { ...filters, limit: 10000, offset: 0 };
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

  if (rawAction === 'confirm' || rawAction === 'fund-onchain' || rawAction === 'release-onchain') {
    return actor === trade.buyerAgentId
      ? null
      : {
          error: 'buyer_actor_required',
          message: 'Only the buyer agent can perform this trade action.'
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

  if (rawAction === 'refund-onchain') {
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

function validateSandboxWebhookInput(input) {
  const errors = [];
  if (!input || typeof input !== 'object') errors.push('body must be a JSON object');
  if (!input.eventId || typeof input.eventId !== 'string') errors.push('eventId is required');
  if (!input.paymentIntentId || typeof input.paymentIntentId !== 'string') {
    errors.push('paymentIntentId is required');
  }
  if (!['PENDING', 'SUCCEEDED', 'DECLINED', 'FAILED'].includes(input.status)) {
    errors.push('status must be PENDING, SUCCEEDED, DECLINED, or FAILED');
  }
  return errors;
}

function parseOptionalBlockNumber(value, name) {
  if (value === undefined || value === null || value === '') return { value: null };
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return { error: `${name} must be a non-negative integer` };
  }
  return { value: parsed };
}

function queryValue(query, name) {
  if (typeof query?.get === 'function') return query.get(name);
  return query?.[name] ?? null;
}

function x402RequirementsForAmount(amountUsdc) {
  const x402 = getConfig().payment.x402;
  if (!x402.configured) {
    return {
      error: {
        status: 503,
        body: {
          error: 'x402_not_configured',
          message: 'X402_PAY_TO must be configured before x402 payment requirements can be issued.'
        }
      }
    };
  }

  try {
    return {
      x402,
      paymentRequirements: buildX402PaymentRequirements({ amountUsdc, x402 })
    };
  } catch (error) {
    return {
      error: {
        status: 400,
        body: {
          error: 'invalid_x402_payment_requirements',
          message: error.message
        }
      }
    };
  }
}

function manualUsdcInstructionsForAmount(amountUsdc) {
  const x402 = getConfig().payment.x402;
  if (!x402.payTo || !x402.asset || !x402.network) {
    return {
      error: {
        status: 503,
        body: {
          error: 'manual_usdc_not_configured',
          message: 'X402_PAY_TO, X402_NETWORK, and X402_ASSET must be configured before manual USDC payments can run.'
        }
      }
    };
  }

  try {
    return {
      network: x402.network,
      asset: x402.asset,
      payTo: x402.payTo,
      amountUsdc,
      amount: usdcToAtomicAmount(amountUsdc)
    };
  } catch (error) {
    return {
      error: {
        status: 400,
        body: {
          error: 'invalid_manual_usdc_amount',
          message: error.message
        }
      }
    };
  }
}

function x402ResourceUrl(pathname) {
  const baseUrl = (
    process.env.AGENT_EXCHANGE_PUBLIC_URL ??
    process.env.AGENT_EXCHANGE_URL ??
    'https://ax-7508.onrender.com'
  ).replace(/\/$/, '');
  return `${baseUrl}${pathname}`;
}

function x402PaymentRequiredForProbe(paymentRequirements) {
  return {
    x402Version: 2,
    resource: {
      url: x402ResourceUrl('/v1/payments/x402/probe'),
      description: 'Agent Exchange x402 hosted settlement probe',
      mimeType: 'application/json',
      serviceName: 'Agent Exchange'
    },
    accepts: [paymentRequirements]
  };
}

async function recordX402Settlement({ store, result, requirements, amountUsdc, paymentPayload, route }) {
  const providerPaymentId = result.transaction ?? result.settle?.transaction ?? null;
  if (!providerPaymentId) {
    return {
      error: {
        status: 502,
        body: {
          error: 'x402_missing_settlement_transaction',
          settle: result.settle ?? null
        }
      }
    };
  }

  const actor = result.payer ?? paymentPayload.payload?.authorization?.from ?? 'external';
  const ledger = await store.recordExternalPaymentSettlement({
    provider: 'x402',
    providerPaymentId,
    action: 'CAPTURE',
    amountUsdc,
    actor,
    status: paymentStatuses.succeeded,
    idempotencyKey: `x402:${providerPaymentId}`,
    eventType: 'x402.payment_settled',
    metadata: {
      route,
      payer: result.payer,
      payTo: requirements.x402.payTo,
      network: result.network,
      amountAtomic: result.amount,
      paymentRequirements: result.paymentRequirements
    },
    payload: {
      payer: result.payer,
      transaction: providerPaymentId,
      network: result.network,
      amount: result.amount,
      verify: result.verify ?? null,
      settle: result.settle ?? null
    }
  });

  if (ledger.error) return { error: ledger.error };
  return ledger;
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

  if (method === 'GET' && pathname === '/v1/search') {
    const term = searchText(queryValue(query, 'q'));
    const category = queryValue(query, 'category');
    const assuranceTier = queryValue(query, 'assuranceTier');
    const limitResult = parseIntegerQuery(queryValue(query, 'limit') ?? undefined, {
      name: 'limit',
      defaultValue: 20,
      min: 1,
      max: 50
    });
    if (limitResult.error) return { status: 400, body: { error: 'invalid_query', errors: [limitResult.error] } };

    const [listings, agents] = await Promise.all([
      store.listListings({ limit: 10000, offset: 0 }),
      store.listAgents()
    ]);
    const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
    const results = listings
      .filter((listing) => listingAcceptsNewTrades(listing))
      .filter((listing) => !category || listing.category === category)
      .filter((listing) => !assuranceTier || String(listing.assuranceTier) === String(assuranceTier))
      .map((listing) => {
        const seller = agentsById.get(listing.sellerAgentId);
        const haystack = searchText(`${listing.title} ${listing.description} ${listing.category} ${seller?.name ?? ''}`);
        const quality = listingQuality(listing, seller);
        const textMatch = !term || haystack.includes(term);
        return {
          type: 'listing',
          score: (textMatch ? 50 : 0) + quality.score,
          listing,
          seller: seller ? {
            id: seller.id,
            name: seller.name,
            reputationScore: seller.reputationScore,
            verificationTier: seller.verificationTier
          } : null,
          quality
        };
      })
      .filter((result) => !term || result.score > result.quality.score)
      .sort((a, b) => b.score - a.score)
      .slice(0, limitResult.value);

    return {
      status: 200,
      body: {
        query: {
          q: term,
          category: category ?? null,
          assuranceTier: assuranceTier ?? null
        },
        results
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

  const listingQualityMatch = pathname.match(/^\/v1\/listings\/([^/]+)\/quality$/);
  if (method === 'GET' && listingQualityMatch) {
    const listing = await store.getListing(listingQualityMatch[1]);
    if (!listing || listing.status === 'blocked') return { status: 404, body: { error: 'listing_not_found' } };
    const seller = await store.getAgent(listing.sellerAgentId);
    return { status: 200, body: { listingId: listing.id, quality: listingQuality(listing, seller) } };
  }

  const listingMatch = pathname.match(/^\/v1\/listings\/([^/]+)$/);
  if (method === 'GET' && listingMatch) {
    const listing = await store.getListing(listingMatch[1]);
    if (!listing) return { status: 404, body: { error: 'listing_not_found' } };
    return { status: 200, body: { listing } };
  }

  const listingOffersMatch = pathname.match(/^\/v1\/listings\/([^/]+)\/offers$/);
  if (method === 'GET' && listingOffersMatch) {
    const accessResult = await authorizeAdminOrAgent(headers, store, { method, pathname, query, body });
    if (accessResult.error) return accessResult.error;
    const listQuery = parseListQuery(query, {
      buyerAgentId: {},
      sellerAgentId: {},
      status: {}
    });
    if (listQuery.errors) return { status: 400, body: { error: 'invalid_query', errors: listQuery.errors } };
    const filters = { ...listQuery.filters, listingId: listingOffersMatch[1] };
    const allOffers = await store.listOffers(scopedQueryForList(filters));
    const visibleOffers = accessResult.access.isAdmin
      ? allOffers
      : allOffers.filter((offer) => isOfferParty(offer, accessResult.access.agentId));
    const offers = paginateScoped(visibleOffers, filters);
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
    const authResult = await authenticateAgent(headers, store, { method, pathname, query, body });
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
    const accessResult = await authorizeAdminOrAgent(headers, store, { method, pathname, query, body });
    if (accessResult.error) return accessResult.error;
    const agents = accessResult.access.isAdmin
      ? await store.listAgents()
      : [accessResult.access.agent];
    return { status: 200, body: { agents } };
  }

  if (method === 'GET' && pathname === '/v1/paid/market-snapshot') {
    const access = await authorizePaidAccess({
      store,
      headers,
      query,
      priceUsdc: paidMarketSnapshotPriceUsdc,
      resource: 'market_snapshot'
    });
    if (access.error) return access.error;

    const dashboardLimit = 10000;
    const [listings, offers, trades] = await Promise.all([
      store.listListings({ limit: dashboardLimit, offset: 0 }),
      store.listOffers({ limit: dashboardLimit, offset: 0 }),
      store.listTrades({ limit: dashboardLimit, offset: 0 })
    ]);
    const activeListings = listings.filter((listing) => ['active', 'open'].includes(listing.status));
    const capturedTrades = trades.filter((trade) => trade.state === 'CAPTURED');
    return {
      status: 200,
      body: {
        ok: true,
        resource: 'market_snapshot',
        priceUsdc: paidMarketSnapshotPriceUsdc,
        unlockedBy: {
          paymentIntentId: access.paymentIntent.id,
          provider: access.paymentIntent.provider,
          amountUsdc: access.paymentIntent.amountUsdc
        },
        generatedAt: new Date().toISOString(),
        snapshot: {
          totals: {
            activeListings: activeListings.length,
            offers: offers.length,
            trades: trades.length,
            capturedTrades: capturedTrades.length
          },
          listingsByCategory: countBy(activeListings, 'category'),
          listingsByAssuranceTier: countBy(activeListings, 'assuranceTier'),
          offersByStatus: countBy(offers, 'status'),
          tradesByState: countBy(trades, 'state'),
          recentListings: recent(activeListings, 5).map((listing) => ({
            id: listing.id,
            title: listing.title,
            category: listing.category,
            assuranceTier: listing.assuranceTier,
            priceUsdc: listing.priceUsdc,
            inventoryType: listing.inventoryType
          })),
          recentTrades: recent(trades, 5).map((trade) => ({
            id: trade.id,
            state: trade.state,
            priceUsdc: trade.priceUsdc,
            listingId: trade.listingId
          }))
        }
      }
    };
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
      paymentIntents,
      paymentEvents,
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
      typeof store.listPaymentIntents === 'function' ? store.listPaymentIntents({ limit: dashboardLimit, offset: 0 }) : [],
      typeof store.listPaymentEvents === 'function' ? store.listPaymentEvents({ limit: dashboardLimit, offset: 0 }) : [],
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
          paymentIntents: paymentIntents.length,
          paymentEvents: paymentEvents.length,
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
          paymentIntentsByStatus: countBy(paymentIntents, 'status'),
          paymentIntentsByProvider: countBy(paymentIntents, 'provider'),
          paymentEventsByProvider: countBy(paymentEvents, 'provider'),
          requestLogsByStatus: countBy(requestLogs, 'status'),
          auditEventsBySeverity: countBy(auditEvents, 'severity')
        },
        recent: {
          trades: recent(trades),
          reputationEvents: recent(reputationEvents),
          escrowEvents: recent(escrowEvents),
          paymentIntents: recent(paymentIntents),
          paymentEvents: recent(paymentEvents),
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
    const moderationEvents = await store.listModerationEvents();
    return {
      status: 200,
      body: {
        moderationEvents,
        queue: {
          total: moderationEvents.length,
          reportable: moderationEvents.filter((event) => event.reportable).length,
          byType: countBy(moderationEvents, 'type')
        }
      }
    };
  }

  if (method === 'GET' && pathname === '/v1/admin/payments') {
    const adminError = requireAdmin(headers);
    if (adminError) return adminError;
    const intentQuery = parseListQuery(query, {
      tradeId: {},
      action: {},
      provider: {},
      status: {}
    });
    if (intentQuery.errors) return { status: 400, body: { error: 'invalid_query', errors: intentQuery.errors } };
    return {
      status: 200,
      body: {
        ...paginatedBody('paymentIntents', await store.listPaymentIntents(intentQuery.filters), intentQuery.filters),
        paymentEvents: await store.listPaymentEvents({ limit: 100, offset: 0 })
      }
    };
  }

  if (method === 'GET' && pathname === '/v1/admin/reconciliation') {
    const adminError = requireAdmin(headers);
    if (adminError) return adminError;
    const stuckAfterMinutes = queryValue(query, 'stuckAfterMinutes');
    const parsedStuckAfter = stuckAfterMinutes == null
      ? 30
      : Number(stuckAfterMinutes);
    if (!Number.isInteger(parsedStuckAfter) || parsedStuckAfter < 1 || parsedStuckAfter > 1440) {
      return {
        status: 400,
        body: {
          error: 'invalid_query',
          errors: ['stuckAfterMinutes must be an integer between 1 and 1440']
        }
      };
    }
    return {
      status: 200,
      body: {
        reconciliation: await buildReconciliationReport(store, { stuckAfterMinutes: parsedStuckAfter })
      }
    };
  }

  if (method === 'GET' && pathname === '/v1/admin/escrow-watcher/status') {
    const adminError = requireAdmin(headers);
    if (adminError) return adminError;
    return {
      status: 200,
      body: {
        watcher: await getEscrowWatcherStatus({ config: getConfig() })
      }
    };
  }

  if (method === 'POST' && pathname === '/v1/admin/escrow-watcher/run') {
    const adminError = requireAdmin(headers);
    if (adminError) return adminError;
    const fromBlock = parseOptionalBlockNumber(body.fromBlock, 'fromBlock');
    const toBlock = parseOptionalBlockNumber(body.toBlock, 'toBlock');
    const lookbackBlocks = parseOptionalBlockNumber(body.lookbackBlocks, 'lookbackBlocks');
    const errors = [fromBlock.error, toBlock.error, lookbackBlocks.error].filter(Boolean);
    if (errors.length > 0) return { status: 400, body: { error: 'invalid_escrow_watcher_range', errors } };

    const result = await runEscrowWatcher({
      store,
      config: getConfig(),
      fromBlock: fromBlock.value,
      toBlock: toBlock.value,
      lookbackBlocks: lookbackBlocks.value ?? 500
    });
    if (result.error) return result.error;
    return { status: 200, body: { watcherRun: result } };
  }

  const adminPaymentMatch = pathname.match(/^\/v1\/admin\/payments\/([^/]+)$/);
  if (method === 'GET' && adminPaymentMatch) {
    const adminError = requireAdmin(headers);
    if (adminError) return adminError;
    const paymentIntent = await store.getPaymentIntent(adminPaymentMatch[1]);
    if (!paymentIntent) return { status: 404, body: { error: 'payment_intent_not_found' } };
    return {
      status: 200,
      body: {
        paymentIntent,
        paymentEvents: await store.listPaymentEvents({ paymentIntentId: paymentIntent.id, limit: 100, offset: 0 })
      }
    };
  }

  const adminPaymentRepairMatch = pathname.match(/^\/v1\/admin\/payments\/([^/]+)\/repair$/);
  if (method === 'POST' && adminPaymentRepairMatch) {
    const adminError = requireAdmin(headers);
    if (adminError) return adminError;
    if (typeof store.adminRepairPaymentIntent !== 'function') {
      return { status: 503, body: { error: 'payment_repair_unavailable' } };
    }
    const result = await store.adminRepairPaymentIntent({
      paymentIntentId: adminPaymentRepairMatch[1],
      status: body.status,
      reason: body.reason,
      force: body.force === true,
      metadata: body.metadata ?? {},
      actor: 'admin'
    });
    if (result.error) return result.error;
    return { status: 200, body: result };
  }

  if (method === 'GET' && pathname === '/v1/payments/x402/requirements') {
    const amountUsdc = queryValue(query, 'amountUsdc');
    const result = x402RequirementsForAmount(amountUsdc);
    if (result.error) return result.error;
    return {
      status: 200,
      body: {
        provider: 'x402',
        paymentRequirements: result.paymentRequirements
      }
    };
  }

  if (method === 'GET' && pathname === '/v1/escrow/contract/config') {
    const escrowContract = getConfig().payment.escrowContract;
    const sampleTradeId = queryValue(query, 'tradeId') ?? 'sample_trade_id';
    return {
      status: 200,
      body: {
        configured: escrowContract.configured,
        address: escrowContract.address,
        network: escrowContract.network,
        asset: escrowContract.asset,
        platformFeeBps: escrowContract.platformFeeBps,
        tradeIdHashAlgorithm: 'keccak256(utf8(tradeId))',
        sampleTradeId,
        sampleTradeIdHash: escrowTradeIdHash(sampleTradeId),
        abi: escrowContractAbi
      }
    };
  }

  if (method === 'GET' && pathname === '/v1/payments/manual-usdc/instructions') {
    const amountUsdc = queryValue(query, 'amountUsdc') ?? '0.01';
    const instructions = manualUsdcInstructionsForAmount(amountUsdc);
    if (instructions.error) return instructions.error;
    return {
      status: 200,
      body: {
        provider: 'manual_usdc',
        instructions: {
          ...instructions,
          message: 'Send USDC on the configured network to payTo, then submit the transaction hash to /v1/payments/manual-usdc/verify.'
        }
      }
    };
  }

  if (method === 'POST' && pathname === '/v1/payments/manual-usdc/verify') {
    const amountUsdc = body.amountUsdc ?? '0.01';
    const instructions = manualUsdcInstructionsForAmount(amountUsdc);
    if (instructions.error) return instructions.error;

    const verification = await verifyOnchainUsdcTransfer({
      txHash: body.txHash,
      amountUsdc,
      payer: body.payer,
      payTo: instructions.payTo,
      asset: instructions.asset,
      network: instructions.network,
      rpcUrl: process.env.BASE_RPC_URL,
      fetchFn: globalThis.fetch
    });

    if (verification.error) return verification.error;

    const ledger = await store.recordExternalPaymentSettlement({
      provider: 'manual_usdc',
      providerPaymentId: verification.transaction,
      action: 'CAPTURE',
      amountUsdc,
      actor: verification.payer,
      status: paymentStatuses.succeeded,
      idempotencyKey: `manual_usdc:${verification.transaction}`,
      eventType: 'manual_usdc.transfer_confirmed',
      metadata: {
        route: '/v1/payments/manual-usdc/verify',
        payer: verification.payer,
        payTo: verification.payTo,
        network: verification.network,
        asset: verification.asset,
        amountAtomic: verification.amount,
        blockNumber: verification.blockNumber,
        logIndex: verification.logIndex
      },
      payload: verification
    });

    if (ledger.error) return ledger.error;

    return {
      status: 202,
      body: {
        ok: true,
        provider: 'manual_usdc',
        settlement: verification,
        paymentIntent: ledger.paymentIntent,
        paymentEvent: ledger.paymentEvent,
        duplicate: ledger.duplicate
      }
    };
  }

  if (method === 'GET' && pathname === '/v1/payments/x402/probe') {
    const amountUsdc = queryValue(query, 'amountUsdc') ?? '0.01';
    const requirements = x402RequirementsForAmount(amountUsdc);
    if (requirements.error) return requirements.error;
    const paymentRequired = x402PaymentRequiredForProbe(requirements.paymentRequirements);
    const paymentPayload =
      parseX402PaymentPayload(getHeader(headers, 'payment-signature')) ??
      parseX402PaymentPayload(getHeader(headers, 'x-payment'));

    if (!paymentPayload) {
      return {
        status: 402,
        headers: {
          'PAYMENT-REQUIRED': encodePaymentRequiredHeader(paymentRequired)
        },
        body: {
          ...paymentRequired,
          error: 'x402_payment_required'
        }
      };
    }

    const result = await settleX402Payment({
      paymentPayload,
      paymentRequirements: requirements.paymentRequirements,
      x402: requirements.x402
    });

    if (!result.ok) {
      return {
        status: result.status,
        headers: {
          'PAYMENT-REQUIRED': encodePaymentRequiredHeader({
            ...paymentRequired,
            error: result.error
          })
        },
        body: {
          error: result.error,
          paymentRequired,
          verify: result.verify ?? null,
          settle: result.settle ?? null
        }
      };
    }

    const ledger = await recordX402Settlement({
      store,
      result,
      requirements,
      amountUsdc,
      paymentPayload,
      route: '/v1/payments/x402/probe'
    });

    if (ledger.error) return ledger.error;

    return {
      status: 200,
      headers: {
        'PAYMENT-RESPONSE': encodePaymentResponseHeader(result.settle)
      },
      body: {
        ok: true,
        provider: 'x402',
        settlement: {
          payer: result.payer,
          transaction: result.transaction,
          network: result.network,
          amount: result.amount
        },
        paymentIntent: ledger.paymentIntent,
        paymentEvent: ledger.paymentEvent,
        duplicate: ledger.duplicate,
        message: 'x402 probe payment settled'
      }
    };
  }

  if (method === 'POST' && pathname === '/v1/payments/x402/settle') {
    const adminError = requireAdmin(headers);
    if (adminError) return adminError;

    const amountUsdc = body.amountUsdc;
    const requirements = x402RequirementsForAmount(amountUsdc);
    if (requirements.error) return requirements.error;
    const paymentPayload =
      parseX402PaymentPayload(body.paymentPayload) ??
      parseX402PaymentPayload(getHeader(headers, 'payment-signature')) ??
      parseX402PaymentPayload(getHeader(headers, 'x-payment'));

    const result = await settleX402Payment({
      paymentPayload,
      paymentRequirements: requirements.paymentRequirements,
      x402: requirements.x402
    });

    if (!result.ok) {
      return {
        status: result.status,
        body: {
          error: result.error,
          paymentRequirements: result.paymentRequirements,
          verify: result.verify ?? null,
          settle: result.settle ?? null
        }
      };
    }

    const ledger = await recordX402Settlement({
      store,
      result,
      requirements,
      amountUsdc,
      paymentPayload,
      route: '/v1/payments/x402/settle'
    });

    if (ledger.error) return ledger.error;

    return {
      status: 202,
      body: {
        provider: 'x402',
        settlement: {
          payer: result.payer,
          transaction: result.transaction,
          network: result.network,
          amount: result.amount
        },
        paymentRequirements: result.paymentRequirements,
        paymentIntent: ledger.paymentIntent,
        paymentEvent: ledger.paymentEvent,
        duplicate: ledger.duplicate
      }
    };
  }

  if (method === 'POST' && pathname === '/v1/payments/sandbox/webhook') {
    const errors = validateSandboxWebhookInput(body);
    if (errors.length > 0) return { status: 400, body: { error: 'invalid_sandbox_webhook', errors } };

    const secret = process.env.PAYMENT_SANDBOX_WEBHOOK_SECRET;
    if (secret) {
      const signature = getHeader(headers, 'x-sandbox-payment-signature');
      if (!verifySandboxWebhookSignature({ secret, payload: body, signature })) {
        return { status: 401, body: { error: 'invalid_payment_webhook_signature' } };
      }
    } else {
      const adminError = requireAdmin(headers);
      if (adminError) return adminError;
    }

    const result = await store.recordPaymentWebhookEvent({
      eventId: body.eventId,
      paymentIntentId: body.paymentIntentId,
      status: body.status,
      type: body.type ?? 'sandbox.payment_status',
      payload: body.payload ?? {}
    });
    if (result.error) return result.error;
    return {
      status: result.duplicate ? 200 : 202,
      body: result
    };
  }

  const adminInspectMatch = pathname.match(/^\/v1\/admin\/inspect\/(agents|listings|offers|trades|payments)\/([^/]+)$/);
  if (method === 'GET' && adminInspectMatch) {
    const adminError = requireAdmin(headers);
    if (adminError) return adminError;
    const [, type, id] = adminInspectMatch;
    const readers = {
      agents: () => store.getAgent(id),
      listings: () => store.getListing(id),
      offers: () => store.getOffer(id),
      trades: () => store.getTrade(id),
      payments: () => store.getPaymentIntent(id)
    };
    const resource = await readers[type]();
    if (!resource) return { status: 404, body: { error: 'resource_not_found' } };
    const singular = type === 'payments' ? 'payment_intent' : type.slice(0, -1);
    const events = await store.listAuditEvents({
      limit: 50,
      offset: 0,
      resourceType: singular,
      resourceId: id
    });
    const paymentEvents = type === 'payments'
      ? await store.listPaymentEvents({ paymentIntentId: id, limit: 100, offset: 0 })
      : [];
    return { status: 200, body: { type, id, resource, events, paymentEvents } };
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
    const accessResult = await authorizeAdminOrAgent(headers, store, { method, pathname, query, body });
    if (accessResult.error) return accessResult.error;
    const agent = await store.getAgent(agentReputationMatch[1]);
    if (!agent) return { status: 404, body: { error: 'agent_not_found' } };
    const accessError = requireOwnAgentOrAdmin(agent.id, accessResult.access);
    if (accessError) return accessError;
    return {
      status: 200,
      body: {
        agent,
        reputationEvents: await store.listReputationEvents(agent.id)
      }
    };
  }

  const agentOnboardingMatch = pathname.match(/^\/v1\/agents\/([^/]+)\/onboarding$/);
  if (method === 'GET' && agentOnboardingMatch) {
    const accessResult = await authorizeAdminOrAgent(headers, store, { method, pathname, query, body });
    if (accessResult.error) return accessResult.error;
    const agent = await store.getAgent(agentOnboardingMatch[1]);
    if (!agent) return { status: 404, body: { error: 'agent_not_found' } };
    const accessError = requireOwnAgentOrAdmin(agent.id, accessResult.access);
    if (accessError) return accessError;
    const listings = await store.listListings({ sellerAgentId: agent.id, limit: 10000, offset: 0 });
    return { status: 200, body: { onboarding: agentOnboardingStatus(agent, listings) } };
  }

  const agentApiKeysMatch = pathname.match(/^\/v1\/agents\/([^/]+)\/api-keys$/);
  if (method === 'GET' && agentApiKeysMatch) {
    const accessResult = await authorizeAdminOrAgent(headers, store, { method, pathname, query, body });
    if (accessResult.error) return accessResult.error;
    const agent = await store.getAgent(agentApiKeysMatch[1]);
    if (!agent) return { status: 404, body: { error: 'agent_not_found' } };
    const accessError = requireOwnAgentOrAdmin(agent.id, accessResult.access);
    if (accessError) return accessError;
    if (typeof store.listApiKeys !== 'function') return { status: 503, body: { error: 'api_keys_unavailable' } };
    return { status: 200, body: { apiKeys: await store.listApiKeys(agent.id) } };
  }

  if (method === 'POST' && agentApiKeysMatch) {
    const accessResult = await authorizeAdminOrAgent(headers, store, { method, pathname, query, body });
    if (accessResult.error) return accessResult.error;
    const agent = await store.getAgent(agentApiKeysMatch[1]);
    if (!agent) return { status: 404, body: { error: 'agent_not_found' } };
    const accessError = requireOwnAgentOrAdmin(agent.id, accessResult.access);
    if (accessError) return accessError;
    if (typeof store.createApiKey !== 'function') return { status: 503, body: { error: 'api_keys_unavailable' } };
    const errors = validateApiKeyInput(body);
    if (errors.length > 0) return { status: 400, body: { error: 'invalid_api_key', errors } };
    const result = await store.createApiKey({
      agentId: agent.id,
      name: body.name,
      scopes: body.scopes ?? ['read'],
      expiresAt: body.expiresAt ?? null
    });
    if (result.error) return result.error;
    return { status: 201, body: result };
  }

  const agentApiKeyRevokeMatch = pathname.match(/^\/v1\/agents\/([^/]+)\/api-keys\/([^/]+)\/revoke$/);
  if (method === 'POST' && agentApiKeyRevokeMatch) {
    const accessResult = await authorizeAdminOrAgent(headers, store, { method, pathname, query, body });
    if (accessResult.error) return accessResult.error;
    const agent = await store.getAgent(agentApiKeyRevokeMatch[1]);
    if (!agent) return { status: 404, body: { error: 'agent_not_found' } };
    const accessError = requireOwnAgentOrAdmin(agent.id, accessResult.access);
    if (accessError) return accessError;
    if (typeof store.revokeApiKey !== 'function') return { status: 503, body: { error: 'api_keys_unavailable' } };
    const apiKey = await store.revokeApiKey({ agentId: agent.id, keyId: agentApiKeyRevokeMatch[2] });
    if (!apiKey) return { status: 404, body: { error: 'api_key_not_found' } };
    return { status: 200, body: { apiKey } };
  }

  const agentMatch = pathname.match(/^\/v1\/agents\/([^/]+)$/);
  if (method === 'GET' && agentMatch) {
    const accessResult = await authorizeAdminOrAgent(headers, store, { method, pathname, query, body });
    if (accessResult.error) return accessResult.error;
    const agent = await store.getAgent(agentMatch[1]);
    if (!agent) return { status: 404, body: { error: 'agent_not_found' } };
    const accessError = requireOwnAgentOrAdmin(agent.id, accessResult.access);
    if (accessError) return accessError;
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
    const authResult = await authenticateAgent(headers, store, { method, pathname, query, body });
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
    const authResult = await authenticateAgent(headers, store, { method, pathname, query, body });
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
    const accessResult = await authorizeAdminOrAgent(headers, store, { method, pathname, query, body });
    if (accessResult.error) return accessResult.error;
    const listQuery = parseListQuery(query, {
      listingId: {},
      buyerAgentId: {},
      sellerAgentId: {},
      state: {}
    });
    if (listQuery.errors) return { status: 400, body: { error: 'invalid_query', errors: listQuery.errors } };
    const allTrades = await store.listTrades(scopedQueryForList(listQuery.filters));
    const visibleTrades = accessResult.access.isAdmin
      ? allTrades
      : allTrades.filter((trade) => isTradeParty(trade, accessResult.access.agentId));
    const trades = paginateScoped(visibleTrades, listQuery.filters);
    return { status: 200, body: paginatedBody('trades', trades, listQuery.filters) };
  }

  const tradeMatch = pathname.match(/^\/v1\/trades\/([^/]+)$/);
  if (method === 'GET' && tradeMatch) {
    const accessResult = await authorizeAdminOrAgent(headers, store, { method, pathname, query, body });
    if (accessResult.error) return accessResult.error;
    const trade = await store.getTrade(tradeMatch[1]);
    if (!trade) return { status: 404, body: { error: 'trade_not_found' } };
    if (!accessResult.access.isAdmin && !isTradeParty(trade, accessResult.access.agentId)) {
      return { status: 403, body: { error: 'trade_party_required' } };
    }
    return { status: 200, body: { trade } };
  }

  if (method === 'GET' && pathname === '/v1/offers') {
    const accessResult = await authorizeAdminOrAgent(headers, store, { method, pathname, query, body });
    if (accessResult.error) return accessResult.error;
    const listQuery = parseListQuery(query, {
      listingId: {},
      buyerAgentId: {},
      sellerAgentId: {},
      status: {}
    });
    if (listQuery.errors) return { status: 400, body: { error: 'invalid_query', errors: listQuery.errors } };
    const allOffers = await store.listOffers(scopedQueryForList(listQuery.filters));
    const visibleOffers = accessResult.access.isAdmin
      ? allOffers
      : allOffers.filter((offer) => isOfferParty(offer, accessResult.access.agentId));
    const offers = paginateScoped(visibleOffers, listQuery.filters);
    return { status: 200, body: paginatedBody('offers', offers, listQuery.filters) };
  }

  const offerMatch = pathname.match(/^\/v1\/offers\/([^/]+)$/);
  if (method === 'GET' && offerMatch) {
    const accessResult = await authorizeAdminOrAgent(headers, store, { method, pathname, query, body });
    if (accessResult.error) return accessResult.error;
    const offer = await store.getOffer(offerMatch[1]);
    if (!offer) return { status: 404, body: { error: 'offer_not_found' } };
    if (!accessResult.access.isAdmin && !isOfferParty(offer, accessResult.access.agentId)) {
      return { status: 403, body: { error: 'offer_party_required' } };
    }
    return { status: 200, body: { offer } };
  }

  if (method === 'POST' && pathname === '/v1/offers') {
    const authResult = await authenticateAgent(headers, store, { method, pathname, query, body });
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
    const authResult = await authenticateAgent(headers, store, { method, pathname, query, body });
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
    const authResult = await authenticateAgent(headers, store, { method, pathname, query, body });
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
    const accessResult = await authorizeAdminOrAgent(headers, store, { method, pathname, query, body });
    if (accessResult.error) return accessResult.error;
    const reservations = await store.listInventoryReservations();
    return {
      status: 200,
      body: {
        reservations: accessResult.access.isAdmin
          ? reservations
          : reservations.filter((reservation) => (
              reservation.buyerAgentId === accessResult.access.agentId ||
              reservation.sellerAgentId === accessResult.access.agentId
            ))
      }
    };
  }

  const tradeActionMatch = pathname.match(/^\/v1\/trades\/([^/]+)\/([^/]+)$/);
  if (method === 'POST' && tradeActionMatch) {
    const [, tradeId, rawAction] = tradeActionMatch;
    const action = rawAction === 'resolve' ? `resolve_${body.resolution}` : rawAction.replaceAll('-', '_');
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
    } else if ((rawAction === 'refund' || rawAction === 'refund-onchain') && body.actorRole === 'admin') {
      const adminError = requireAdmin(headers);
      if (adminError) return adminError;
      actor = 'admin';
    } else {
      const authResult = await authenticateAgent(headers, store, { method, pathname, query, body });
      if (authResult.error) return authResult.error;
      const actorError = requireBodyActorMatchesSession(body, authResult.auth);
      if (actorError) return actorError;
      actor = authResult.auth.agentId;
    }

    const authzError = authorizeTradeAction({ rawAction, trade, actor, body });
    if (authzError) {
      return { status: 403, body: authzError };
    }

    const paymentConfig = getConfig().payment;
    const usesSmartContractEscrow = transition.paymentProvider === 'smart_contract';
    if (transition.escrowType && !usesSmartContractEscrow && paymentConfig.provider !== 'sandbox') {
      return {
        status: 503,
        body: {
          error: 'trade_payment_provider_not_connected',
          provider: paymentConfig.provider,
          message:
            'Trade escrow actions still use the sandbox adapter. Use /v1/payments/x402/* for gateway connection tests until x402 escrow semantics are explicitly implemented.'
        }
      };
    }

    let escrowVerification = null;
    if (usesSmartContractEscrow) {
      const escrowContract = paymentConfig.escrowContract;
      if (!escrowContract.configured) {
        return { status: 503, body: { error: 'escrow_contract_not_configured' } };
      }
      const [buyerAgent, sellerAgent] = await Promise.all([
        store.getAgent(trade.buyerAgentId),
        store.getAgent(trade.sellerAgentId)
      ]);
      const verification = await verifyEscrowContractEvent({
        txHash: body.txHash,
        trade,
        action,
        contractAddress: escrowContract.address,
        network: escrowContract.network,
        amountUsdc: trade.priceUsdc,
        buyerAgent,
        sellerAgent,
        rpcUrl: escrowContract.rpcUrl
      });
      if (verification.error) return verification.error;
      escrowVerification = verification;
    }

    return await store.withIdempotency(
      {
        scope: `POST /v1/trades/${tradeId}/${rawAction}`,
        key: idempotencyKey(headers, body),
        input: { ...body, actorAgentId: actor }
      },
      async () => {
        const transitionResult = await store.transitionTrade(tradeId, {
          ...transition,
          to: transition.to,
          eventType: transition.eventType,
          actor,
          escrowAmountUsdc: trade.priceUsdc,
          paymentOutcome: body.sandboxPaymentOutcome ?? body.paymentOutcome ?? 'succeeded',
          paymentProvider: transition.paymentProvider ?? 'sandbox',
          paymentStatus: usesSmartContractEscrow ? paymentStatuses.succeeded : undefined,
          providerPaymentId: escrowVerification?.transaction,
          paymentIdempotencyKey: idempotencyKey(headers, body),
          paymentMetadata: {
            route: `POST /v1/trades/${tradeId}/${rawAction}`,
            sandbox: !usesSmartContractEscrow,
            smartContract: usesSmartContractEscrow,
            verification: escrowVerification
          },
          escrowPayload: {
            ...(usesSmartContractEscrow
              ? {
                  contractAddress: escrowVerification.contractAddress,
                  network: escrowVerification.network,
                  tradeIdHash: escrowVerification.tradeIdHash,
                  eventName: escrowVerification.eventName,
                  transaction: escrowVerification.transaction,
                  blockNumber: escrowVerification.blockNumber,
                  logIndex: escrowVerification.logIndex
                }
              : {
                  note: 'Sandbox payment adapter; replace with Commerce Payments integration after sandbox gates.'
                })
          },
          payload: {
            proof: body.proof ?? null,
            reason: body.reason ?? null,
            resolution: body.resolution ?? null,
            txHash: body.txHash ?? null,
            escrowContractEvent: escrowVerification
          }
        });

        if (transitionResult?.error) return transitionResult.error;
        if (!transitionResult) return { status: 404, body: { error: 'trade_not_found' } };

        return {
          status: 200,
          body: {
            trade: transitionResult.trade,
            escrowEvent: transitionResult.escrowEvent,
            paymentIntent: transitionResult.paymentIntent
          }
        };
      }
    );
  }

  if (method === 'GET' && pathname === '/v1/escrow/events') {
    const accessResult = await authorizeAdminOrAgent(headers, store, { method, pathname, query, body });
    if (accessResult.error) return accessResult.error;
    const escrowEvents = await store.listEscrowEvents();
    if (accessResult.access.isAdmin) {
      return { status: 200, body: { escrowEvents } };
    }
    const visibleEvents = [];
    for (const event of escrowEvents) {
      const trade = await store.getTrade(event.tradeId);
      if (isTradeParty(trade, accessResult.access.agentId)) visibleEvents.push(event);
    }
    return { status: 200, body: { escrowEvents: visibleEvents } };
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
      return json(res, result.status, result.body, { ...rateLimit.headers, ...(result.headers ?? {}) });
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
