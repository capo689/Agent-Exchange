import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { addUsdc, compareUsdc, multiplyUnitPrice, subtractUsdc } from './money.js';
import { isOfferOpen, offerStatuses, ruleMatchesOffer } from './negotiation.js';
import {
  isTerminalPaymentStatus,
  paymentActionForEscrowType,
  paymentStatuses,
  sandboxStatusForOutcome
} from './payments.js';
import { getConfig } from './config.js';

const { Pool } = pg;
const bundledSupabaseCaUrl = new URL('../certs/supabase-prod-ca-2021.crt', import.meta.url);

function nowIso() {
  return new Date().toISOString();
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function tokenDigest(token) {
  return createHash('sha256').update(token).digest('hex');
}

function currentSettlementType() {
  return getConfig().marketplace.settlementType;
}

function settlementTypeFromEvents(events) {
  return events?.[0]?.payload?.settlementType ?? currentSettlementType();
}

function clone(value) {
  return structuredClone(value);
}

function jsonb(value) {
  return JSON.stringify(value);
}

function clampReputation(value) {
  return Math.max(0, Math.min(100, Number(value)));
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : value;
}

function normalizePem(value) {
  return value?.replaceAll('\\n', '\n').trim();
}

function bundledSupabaseCaCertificate() {
  return normalizePem(readFileSync(bundledSupabaseCaUrl, 'utf8'));
}

function databaseCaCertificate({ useBundledSupabaseCa = false } = {}) {
  const inline = normalizePem(process.env.DATABASE_CA_CERT ?? process.env.SUPABASE_DB_CA_CERT ?? '');
  if (inline) return inline;

  const caPath = process.env.DATABASE_CA_CERT_PATH ?? process.env.SUPABASE_DB_CA_CERT_PATH ?? '';
  if (caPath) return normalizePem(readFileSync(caPath, 'utf8'));

  return useBundledSupabaseCa ? bundledSupabaseCaCertificate() : null;
}

function makePool(connectionString) {
  const isSupabase = connectionString.includes('supabase.com');
  const requiresSsl = isSupabase || connectionString.includes('sslmode=require');
  const ca = requiresSsl ? databaseCaCertificate({ useBundledSupabaseCa: isSupabase }) : null;
  const ssl = requiresSsl
    ? {
        rejectUnauthorized: true,
        ...(ca ? { ca } : {})
      }
    : undefined;
  return new Pool({ connectionString, ssl });
}

function addWhere(clauses, params, column, value) {
  if (value === undefined || value === null || value === '') return;
  params.push(value);
  clauses.push(`${column} = $${params.length}`);
}

async function selectFiltered({ query, table, columns, filters = {}, baseWhere = [] }) {
  const params = [];
  const clauses = [...baseWhere];
  for (const [filterKey, column] of Object.entries(columns)) {
    addWhere(clauses, params, column, filters[filterKey]);
  }
  const limit = Number(filters.limit ?? 50);
  const offset = Number(filters.offset ?? 0);
  params.push(limit, offset);
  const where = clauses.length ? ` where ${clauses.join(' and ')}` : '';
  return query(
    `select * from ${table}${where} order by created_at desc limit $${params.length - 1} offset $${params.length}`,
    params
  );
}

function reputationImpacts({ transition, trade }) {
  if (transition.to === 'DISPUTED') {
    return [
      { agentId: trade.buyerAgentId, role: 'buyer', delta: 0, reason: 'TRADE_DISPUTED' },
      { agentId: trade.sellerAgentId, role: 'seller', delta: 0, reason: 'TRADE_DISPUTED' }
    ];
  }

  if (transition.eventType === 'CONFIRMED_AND_CAPTURED') {
    return [
      { agentId: trade.buyerAgentId, role: 'buyer', delta: 1, reason: 'TRADE_CAPTURED' },
      { agentId: trade.sellerAgentId, role: 'seller', delta: 3, reason: 'TRADE_CAPTURED' }
    ];
  }

  if (transition.eventType === 'DISPUTE_RESOLVED_CAPTURE') {
    return [
      { agentId: trade.buyerAgentId, role: 'buyer', delta: -1, reason: 'DISPUTE_RESOLVED_CAPTURE' },
      { agentId: trade.sellerAgentId, role: 'seller', delta: 2, reason: 'DISPUTE_RESOLVED_CAPTURE' }
    ];
  }

  if (transition.eventType === 'REFUNDED') {
    return [
      { agentId: trade.buyerAgentId, role: 'buyer', delta: 1, reason: 'TRADE_REFUNDED' },
      { agentId: trade.sellerAgentId, role: 'seller', delta: -3, reason: 'TRADE_REFUNDED' }
    ];
  }

  if (transition.eventType === 'DISPUTE_RESOLVED_REFUND') {
    return [
      { agentId: trade.buyerAgentId, role: 'buyer', delta: 2, reason: 'DISPUTE_RESOLVED_REFUND' },
      { agentId: trade.sellerAgentId, role: 'seller', delta: -4, reason: 'DISPUTE_RESOLVED_REFUND' }
    ];
  }

  return [];
}

function agentFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    developerId: row.developer_id,
    name: row.name,
    walletAddress: row.wallet_address,
    publicKeyJwk: row.public_key_jwk,
    reputationScore: row.reputation_score,
    verificationTier: row.verification_tier,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function apiKeyFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    agentId: row.agent_id,
    name: row.name,
    scopes: row.scopes ?? [],
    status: row.status,
    expiresAt: iso(row.expires_at),
    lastUsedAt: iso(row.last_used_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function challengeFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    agentId: row.agent_id,
    nonce: row.nonce,
    canonical: row.canonical,
    expiresAt: iso(row.expires_at),
    usedAt: iso(row.used_at),
    createdAt: iso(row.created_at)
  };
}

function listingFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    sellerAgentId: row.seller_agent_id,
    title: row.title,
    description: row.description,
    category: row.category,
    assuranceTier: row.assurance_tier,
    priceUsdc: row.price_usdc,
    inventoryType: row.inventory_type,
    acceptsOffers: row.accepts_offers,
    askPriceUsdc: row.ask_price_usdc,
    unitPriceUsdc: row.unit_price_usdc,
    totalQuantity: row.total_quantity,
    availableQuantity: row.available_quantity,
    unit: row.unit,
    minFillQuantity: row.min_fill_quantity,
    maxFillQuantity: row.max_fill_quantity,
    metadata: row.metadata ?? {},
    status: row.status,
    screening: row.screening ?? {},
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function offerFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    listingId: row.listing_id,
    buyerAgentId: row.buyer_agent_id,
    sellerAgentId: row.seller_agent_id,
    parentOfferId: row.parent_offer_id,
    rootOfferId: row.root_offer_id,
    createdByAgentId: row.created_by_agent_id,
    status: row.status,
    unitPriceUsdc: row.unit_price_usdc,
    totalPriceUsdc: row.total_price_usdc,
    quantity: row.quantity,
    terms: row.terms ?? {},
    assuranceAcknowledgement: row.assurance_acknowledgement,
    expiresAt: iso(row.expires_at),
    acceptedAt: iso(row.accepted_at),
    acceptedByAgentId: row.accepted_by_agent_id,
    autoAcceptRuleId: row.auto_accept_rule_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function reservationFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    listingId: row.listing_id,
    offerId: row.offer_id,
    buyerAgentId: row.buyer_agent_id,
    sellerAgentId: row.seller_agent_id,
    quantity: row.quantity,
    unit: row.unit,
    unitPriceUsdc: row.unit_price_usdc,
    totalPriceUsdc: row.total_price_usdc,
    state: row.state,
    actorAgentId: row.actor_agent_id,
    createdAt: iso(row.created_at)
  };
}

function autoAcceptRuleFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    listingId: row.listing_id,
    sellerAgentId: row.seller_agent_id,
    minUnitPriceUsdc: row.min_unit_price_usdc,
    maxQuantityPerTrade: row.max_quantity_per_trade,
    maxDailyAutoAcceptedUsdc: row.max_daily_auto_accepted_usdc,
    minBuyerReputation: row.min_buyer_reputation,
    requiredAssuranceAcknowledgement: row.required_assurance_acknowledgement,
    offerExpiresWithinSeconds: row.offer_expires_within_seconds,
    dryRun: row.dry_run,
    enabled: row.enabled,
    disabledByAgentId: row.disabled_by_agent_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function tradeFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    listingId: row.listing_id,
    offerId: row.offer_id,
    reservationId: row.reservation_id,
    buyerAgentId: row.buyer_agent_id,
    sellerAgentId: row.seller_agent_id,
    assuranceTier: row.assurance_tier,
    buyerAcknowledgedAssurance: row.buyer_acknowledged_assurance,
    state: row.state,
    settlementType: settlementTypeFromEvents(row.events ?? []),
    priceUsdc: row.price_usdc,
    quantity: row.quantity,
    unit: row.unit,
    events: row.events ?? [],
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function escrowEventFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    tradeId: row.trade_id,
    type: row.type,
    amountUsdc: row.amount_usdc,
    actor: row.actor,
    adapter: row.adapter,
    payload: row.payload ?? {},
    createdAt: iso(row.created_at)
  };
}

function paymentIntentFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    tradeId: row.trade_id,
    escrowEventId: row.escrow_event_id,
    action: row.action,
    amountUsdc: row.amount_usdc,
    actor: row.actor,
    provider: row.provider,
    providerPaymentId: row.provider_payment_id,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    metadata: row.metadata ?? {},
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    completedAt: iso(row.completed_at)
  };
}

function paymentEventFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    paymentIntentId: row.payment_intent_id,
    provider: row.provider,
    type: row.type,
    status: row.status,
    payload: row.payload ?? {},
    createdAt: iso(row.created_at)
  };
}

function reputationEventFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    agentId: row.agent_id,
    tradeId: row.trade_id,
    role: row.role,
    delta: row.delta,
    reason: row.reason,
    previousScore: row.previous_score,
    newScore: row.new_score,
    metadata: row.metadata ?? {},
    createdAt: iso(row.created_at)
  };
}

function requestLogFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    requestId: row.request_id,
    method: row.method,
    path: row.path,
    route: row.route,
    status: row.status,
    latencyMs: Number(row.latency_ms),
    actorAgentId: row.actor_agent_id,
    sessionId: row.session_id,
    errorCode: row.error_code,
    ipHash: row.ip_hash,
    userAgent: row.user_agent,
    createdAt: iso(row.created_at)
  };
}

function auditEventFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    severity: row.severity,
    actorAgentId: row.actor_agent_id,
    sessionId: row.session_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    requestId: row.request_id,
    payload: row.payload ?? {},
    createdAt: iso(row.created_at)
  };
}

function eventActor(actor) {
  return actor && actor !== 'admin' && actor !== 'system' ? actor : null;
}

function normalizeListingInventory(input) {
  const inventoryType = input.inventoryType ?? 'unique';
  const totalQuantity = inventoryType === 'fungible' ? Number(input.totalQuantity) : 1;

  return {
    inventoryType,
    acceptsOffers: input.acceptsOffers ?? true,
    askPriceUsdc: input.askPriceUsdc ?? input.priceUsdc,
    unitPriceUsdc: input.unitPriceUsdc ?? input.priceUsdc,
    totalQuantity,
    availableQuantity: Number(input.availableQuantity ?? totalQuantity),
    unit: input.unit ?? (inventoryType === 'fungible' ? 'unit' : 'item'),
    minFillQuantity: Number(input.minFillQuantity ?? 1),
    maxFillQuantity: Number(input.maxFillQuantity ?? totalQuantity)
  };
}

function reservationError(error) {
  const message = String(error?.message ?? '');
  if (message.includes('below_min_fill')) return { error: 'below_min_fill', message: 'quantity is below minFillQuantity' };
  if (message.includes('above_max_fill')) return { error: 'above_max_fill', message: 'quantity is above maxFillQuantity' };
  if (message.includes('insufficient_inventory')) return { error: 'insufficient_inventory', message: 'Not enough inventory is available.' };
  if (message.includes('listing_not_found')) return { error: 'listing_not_found' };
  return null;
}

export function createPostgresStore({ connectionString }) {
  const pool = makePool(connectionString);

  async function query(text, params = []) {
    return pool.query(text, params);
  }

  async function addOfferEvent(offerId, type, actorAgentId, payload = {}, client = null) {
    const executor = client ?? pool;
    const { rows } = await executor.query(
      `insert into offer_events (id, offer_id, type, actor_agent_id, payload)
       values ($1, $2, $3, $4, $5::jsonb)
       returning *`,
      [`ofe_${randomUUID()}`, offerId, type, actorAgentId, jsonb(payload)]
    );
    return rows[0];
  }

  async function insertAuditEvent(input, client = null) {
    const executor = client ?? pool;
    const { rows } = await executor.query(
      `insert into audit_events (
        id, type, severity, actor_agent_id, session_id, resource_type, resource_id, request_id, payload
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
      on conflict (id) do update set id = audit_events.id
      returning *`,
      [
        input.id ?? `aud_${randomUUID()}`,
        input.type,
        input.severity ?? 'info',
        input.actorAgentId ?? null,
        input.sessionId ?? null,
        input.resourceType ?? null,
        input.resourceId ?? null,
        input.requestId ?? null,
        jsonb(input.payload ?? {})
      ]
    );
    return auditEventFromRow(rows[0]);
  }

  async function reserveInventory({ listing, offer, actorAgentId }, client = null) {
    const executor = client ?? pool;
    try {
      const { rows } = await executor.query(
        `select * from reserve_listing_inventory($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          `res_${randomUUID()}`,
          listing.id,
          offer.id,
          offer.buyerAgentId,
          actorAgentId,
          offer.quantity,
          offer.unitPriceUsdc,
          offer.totalPriceUsdc
        ]
      );
      return { reservation: reservationFromRow(rows[0]) };
    } catch (error) {
      const mapped = reservationError(error);
      if (mapped) return { error: mapped };
      throw error;
    }
  }

  async function createTradeFromAcceptedOffer({ offer, listing, reservation, actorAgentId }, client) {
    const now = nowIso();
    const settlementType = currentSettlementType();
    const trade = {
      id: `trd_${randomUUID()}`,
      listingId: listing.id,
      offerId: offer.id,
      reservationId: reservation.id,
      buyerAgentId: offer.buyerAgentId,
      sellerAgentId: offer.sellerAgentId,
      assuranceTier: listing.assuranceTier,
      buyerAcknowledgedAssurance: Boolean(offer.assuranceAcknowledgement),
      state: 'OFFER_MADE',
      priceUsdc: offer.totalPriceUsdc,
      quantity: offer.quantity,
      unit: listing.unit,
      events: [
        {
          type: 'OFFER_ACCEPTED',
          at: now,
          actor: actorAgentId,
          offerId: offer.id,
          reservationId: reservation.id,
          payload: { settlementType }
        }
      ]
    };
    const { rows } = await client.query(
      `insert into trades (
        id, listing_id, offer_id, reservation_id, buyer_agent_id, seller_agent_id,
        assurance_tier, buyer_acknowledged_assurance, state, price_usdc, quantity, unit, events
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
      returning *`,
      [
        trade.id,
        trade.listingId,
        trade.offerId,
        trade.reservationId,
        trade.buyerAgentId,
        trade.sellerAgentId,
        trade.assuranceTier,
        trade.buyerAcknowledgedAssurance,
        trade.state,
        trade.priceUsdc,
        trade.quantity,
        trade.unit,
        jsonb(trade.events)
      ]
    );
    return tradeFromRow(rows[0]);
  }

  async function acceptOfferInternal({ offer, actorAgentId, autoAcceptRuleId = null }) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const listingResult = await client.query('select * from listings where id = $1 for update', [offer.listingId]);
      const listing = listingFromRow(listingResult.rows[0]);
      if (!listing) {
        await client.query('rollback');
        return { status: 404, body: { error: 'listing_not_found' } };
      }
      if (!isOfferOpen(offer)) {
        const status = Date.parse(offer.expiresAt) <= Date.now() ? offerStatuses.expired : offer.status;
        await client.query('update offers set status = $2, updated_at = now() where id = $1', [offer.id, status]);
        await addOfferEvent(offer.id, 'OFFER_NOT_OPEN', actorAgentId, { status }, client);
        await client.query('commit');
        return { status: 409, body: { error: 'offer_not_open', status } };
      }

      const reservationResult = await reserveInventory({ listing, offer, actorAgentId }, client);
      if (reservationResult.error) {
        await addOfferEvent(offer.id, 'INVENTORY_RESERVATION_FAILED', actorAgentId, reservationResult.error, client);
        await client.query('commit');
        return { status: 409, body: reservationResult.error };
      }

      const updatedOfferResult = await client.query(
        `update offers
         set status = $2, accepted_at = now(), accepted_by_agent_id = $3,
             auto_accept_rule_id = $4, updated_at = now()
         where id = $1
         returning *`,
        [offer.id, offerStatuses.accepted, actorAgentId, autoAcceptRuleId]
      );
      const updatedOffer = offerFromRow(updatedOfferResult.rows[0]);
      const trade = await createTradeFromAcceptedOffer({
        offer: updatedOffer,
        listing,
        reservation: reservationResult.reservation,
        actorAgentId
      }, client);
      await addOfferEvent(offer.id, autoAcceptRuleId ? 'AUTO_ACCEPTED' : 'ACCEPTED', actorAgentId, {
        tradeId: trade.id,
        reservationId: reservationResult.reservation.id,
        autoAcceptRuleId
      }, client);
      await insertAuditEvent({
        type: autoAcceptRuleId ? 'offer.auto_accepted' : 'offer.accepted',
        severity: 'info',
        actorAgentId,
        resourceType: 'offer',
        resourceId: offer.id,
        payload: {
          listingId: offer.listingId,
          tradeId: trade.id,
          reservationId: reservationResult.reservation.id,
          autoAcceptRuleId
        }
      }, client);
      await insertAuditEvent({
        type: 'trade.created',
        severity: 'info',
        actorAgentId,
        resourceType: 'trade',
        resourceId: trade.id,
        payload: {
          listingId: trade.listingId,
          offerId: offer.id,
          buyerAgentId: trade.buyerAgentId,
          sellerAgentId: trade.sellerAgentId,
          state: trade.state,
          priceUsdc: trade.priceUsdc,
          quantity: trade.quantity
        }
      }, client);

      await client.query('commit');
      return {
        status: 200,
        body: {
          offer: updatedOffer,
          reservation: reservationResult.reservation,
          trade
        }
      };
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async function marketForListing(listing) {
    const offersResult = await query(
      `select * from offers where listing_id = $1 and status = $2 and expires_at > now()`,
      [listing.id, offerStatuses.open]
    );
    const activeOffers = offersResult.rows.map(offerFromRow);
    const bestBid = activeOffers
      .filter((offer) => offer.createdByAgentId === offer.buyerAgentId)
      .sort((a, b) => compareUsdc(b.unitPriceUsdc, a.unitPriceUsdc))[0] ?? null;
    const bestAsk = listing.inventoryType === 'fungible' && listing.availableQuantity > 0
      ? {
          listingId: listing.id,
          unitPriceUsdc: listing.unitPriceUsdc,
          availableQuantity: listing.availableQuantity,
          unit: listing.unit
        }
      : null;

    return {
      listingId: listing.id,
      inventoryType: listing.inventoryType,
      bestBid: bestBid
        ? {
            offerId: bestBid.id,
            unitPriceUsdc: bestBid.unitPriceUsdc,
            quantity: bestBid.quantity
          }
        : null,
      bestAsk,
      spreadUsdc: bestAsk && bestBid ? subtractUsdc(bestAsk.unitPriceUsdc, bestBid.unitPriceUsdc) : null
    };
  }

  const methods = {
    async close() {
      await pool.end();
    },

    async createAgent(input) {
      const { rows } = await query(
        `insert into agents (
          id, developer_id, name, wallet_address, public_key_jwk,
          reputation_score, verification_tier, status
        ) values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
        returning *`,
        [
          `agt_${randomUUID()}`,
          input.developerId,
          input.name,
          input.walletAddress ?? null,
          input.publicKeyJwk ? jsonb(input.publicKeyJwk) : null,
          clampReputation(input.reputationScore ?? 0),
          input.publicKeyJwk ? 2 : 0,
          'active'
        ]
      );
      const agent = agentFromRow(rows[0]);
      await insertAuditEvent({
        type: 'agent.created',
        severity: 'info',
        actorAgentId: agent.id,
        resourceType: 'agent',
        resourceId: agent.id,
        payload: {
          developerId: agent.developerId,
          verificationTier: agent.verificationTier
        }
      });
      return agent;
    },

    async getAgent(id) {
      const { rows } = await query('select * from agents where id = $1', [id]);
      return agentFromRow(rows[0]);
    },

    async flagAgent(id, { reason = null, actor = 'admin' } = {}) {
      const { rows } = await query(
        `update agents
         set status = 'flagged', updated_at = now()
         where id = $1
         returning *`,
        [id]
      );
      const agent = agentFromRow(rows[0]);
      if (!agent) return null;
      await insertAuditEvent({
        type: 'agent.flagged',
        severity: 'warn',
        actorAgentId: eventActor(actor),
        resourceType: 'agent',
        resourceId: agent.id,
        payload: { reason }
      });
      return agent;
    },

    async listAgents() {
      const { rows } = await query('select * from agents order by created_at desc');
      return rows.map(agentFromRow);
    },

    async recordRequestLog(input) {
      const { rows } = await query(
        `insert into request_logs (
          id, request_id, method, path, route, status, latency_ms, actor_agent_id,
          session_id, error_code, ip_hash, user_agent
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        returning *`,
        [
          input.id ?? `reqlog_${randomUUID()}`,
          input.requestId,
          input.method,
          input.path,
          input.route ?? input.path,
          input.status,
          input.latencyMs,
          input.actorAgentId ?? null,
          input.sessionId ?? null,
          input.errorCode ?? null,
          input.ipHash ?? null,
          input.userAgent ?? null
        ]
      );
      return requestLogFromRow(rows[0]);
    },

    async recordAuditEvent(input) {
      return insertAuditEvent(input);
    },

    async listRequestLogs({ limit = 100, offset = 0, status } = {}) {
      const filters = { limit, offset };
      if (status !== undefined) filters.status = Number(status);
      const { rows } = await selectFiltered({
        query,
        table: 'request_logs',
        columns: { status: 'status' },
        filters
      });
      return rows.map(requestLogFromRow);
    },

    async listAuditEvents({ limit = 100, offset = 0, type, severity, resourceType, resourceId, actorAgentId } = {}) {
      const { rows } = await selectFiltered({
        query,
        table: 'audit_events',
        columns: {
          type: 'type',
          severity: 'severity',
          resourceType: 'resource_type',
          resourceId: 'resource_id',
          actorAgentId: 'actor_agent_id'
        },
        filters: { limit, offset, type, severity, resourceType, resourceId, actorAgentId }
      });
      return rows.map(auditEventFromRow);
    },

    async listReputationEvents(agentId = null) {
      const { rows } = agentId
        ? await query('select * from reputation_events where agent_id = $1 order by created_at desc', [agentId])
        : await query('select * from reputation_events order by created_at desc');
      return rows.map(reputationEventFromRow);
    },

    async cleanupExpired(now = new Date()) {
      const removedChallenges = await query(
        'delete from challenges where used_at is not null or expires_at <= $1',
        [now]
      );
      const removedSessions = await query('delete from sessions where expires_at <= $1', [now]);
      const removedSignedRequestNonces = await query(
        'delete from signed_request_nonces where expires_at <= $1',
        [now]
      ).catch(() => ({ rowCount: 0 }));
      const removedIdempotencyRecords = await query(
        `delete from idempotency_records where created_at + interval '24 hours' <= $1`,
        [now]
      );
      return {
        removedChallenges: removedChallenges.rowCount,
        removedSessions: removedSessions.rowCount,
        removedSignedRequestNonces: removedSignedRequestNonces.rowCount,
        removedIdempotencyRecords: removedIdempotencyRecords.rowCount
      };
    },

    async recordSignedRequestNonce({ agentId, nonce, expiresAt }) {
      try {
        const { rows } = await query(
          `insert into signed_request_nonces (id, agent_id, nonce, expires_at)
           values ($1, $2, $3, $4)
           on conflict (agent_id, nonce) do nothing
           returning *`,
          [`srn_${randomUUID()}`, agentId, nonce, expiresAt]
        );
        if (!rows[0]) {
          return { error: { status: 409, body: { error: 'signed_request_replay' } } };
        }
        return { record: rows[0] };
      } catch (error) {
        if (error.code === '42P01') {
          return {
            error: {
              status: 503,
              body: {
                error: 'signed_request_nonce_store_missing',
                message: 'Run the signed request nonce migration before enabling signed request auth.'
              }
            }
          };
        }
        throw error;
      }
    },

    async createApiKey({ agentId, name, scopes = ['read'], expiresAt = null }) {
      if (!name || typeof name !== 'string') {
        return { error: { status: 400, body: { error: 'api_key_name_required' } } };
      }
      if (!Array.isArray(scopes) || scopes.length === 0 || scopes.some((scope) => typeof scope !== 'string')) {
        return { error: { status: 400, body: { error: 'invalid_api_key_scopes' } } };
      }
      if (expiresAt && Number.isNaN(Date.parse(expiresAt))) {
        return { error: { status: 400, body: { error: 'invalid_api_key_expiry' } } };
      }

      const agent = await methods.getAgent(agentId);
      if (!agent) {
        return { error: { status: 404, body: { error: 'agent_not_found' } } };
      }
      const token = `axk_${randomBytes(32).toString('base64url')}`;
      const sanitizedScopes = [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))];
      const { rows } = await query(
        `insert into agent_api_keys (id, agent_id, name, token_hash, scopes, expires_at)
         values ($1, $2, $3, $4, $5::jsonb, $6)
         returning *`,
        [
          `key_${randomUUID()}`,
          agentId,
          name,
          tokenDigest(token),
          jsonb(sanitizedScopes),
          expiresAt
        ]
      );
      const apiKey = apiKeyFromRow(rows[0]);
      await insertAuditEvent({
        type: 'api_key.created',
        severity: 'info',
        actorAgentId: agentId,
        resourceType: 'api_key',
        resourceId: apiKey.id,
        payload: {
          name: apiKey.name,
          scopes: apiKey.scopes,
          expiresAt: apiKey.expiresAt
        }
      });
      return { apiKey, token };
    },

    async listApiKeys(agentId) {
      const { rows } = await query(
        'select * from agent_api_keys where agent_id = $1 order by created_at desc',
        [agentId]
      );
      return rows.map(apiKeyFromRow);
    },

    async revokeApiKey({ agentId, keyId }) {
      const { rows } = await query(
        `update agent_api_keys
         set status = 'revoked', updated_at = now()
         where id = $1 and agent_id = $2
         returning *`,
        [keyId, agentId]
      );
      const apiKey = apiKeyFromRow(rows[0]);
      if (!apiKey) return null;
      await insertAuditEvent({
        type: 'api_key.revoked',
        severity: 'warn',
        actorAgentId: agentId,
        resourceType: 'api_key',
        resourceId: apiKey.id,
        payload: { name: apiKey.name }
      });
      return apiKey;
    },

    async getApiKeyByToken(token, now = new Date()) {
      const { rows } = await query(
        `update agent_api_keys
         set last_used_at = now(), updated_at = updated_at
         where token_hash = $1
           and status = 'active'
           and (expires_at is null or expires_at > $2)
         returning *`,
        [tokenDigest(token), now]
      );
      return apiKeyFromRow(rows[0]);
    },

    async createChallenge(agentId) {
      const challenge = {
        id: `chg_${randomUUID()}`,
        agentId,
        nonce: randomBytes(16).toString('hex'),
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString()
      };
      challenge.canonical = [
        'agent-exchange.verify',
        `agent_id:${challenge.agentId}`,
        `challenge_id:${challenge.id}`,
        `nonce:${challenge.nonce}`,
        `expires_at:${challenge.expiresAt}`
      ].join('\n');

      const { rows } = await query(
        `insert into challenges (id, agent_id, nonce, canonical, expires_at)
         values ($1, $2, $3, $4, $5)
         returning *`,
        [challenge.id, challenge.agentId, challenge.nonce, challenge.canonical, challenge.expiresAt]
      );
      return challengeFromRow(rows[0]);
    },

    async getChallenge(id) {
      const { rows } = await query('select * from challenges where id = $1', [id]);
      return challengeFromRow(rows[0]);
    },

    async markChallengeUsed(id) {
      const { rows } = await query(
        'update challenges set used_at = now() where id = $1 returning *',
        [id]
      );
      return challengeFromRow(rows[0]);
    },

    async createSession(agentId) {
      const token = randomBytes(32).toString('base64url');
      const { rows } = await query(
        `insert into sessions (id, token_hash, agent_id, expires_at)
         values ($1, $2, $3, $4)
         returning *`,
        [
          `ses_${randomUUID()}`,
          tokenDigest(token),
          agentId,
          new Date(Date.now() + 15 * 60 * 1000).toISOString()
        ]
      );
      return {
        id: rows[0].id,
        token,
        agentId: rows[0].agent_id,
        expiresAt: iso(rows[0].expires_at),
        createdAt: iso(rows[0].created_at)
      };
    },

    async getSessionByToken(token, now = new Date()) {
      const { rows } = await query(
        'select * from sessions where token_hash = $1 and expires_at > $2',
        [tokenDigest(token), now]
      );
      if (!rows[0]) return null;
      return {
        id: rows[0].id,
        agentId: rows[0].agent_id,
        expiresAt: iso(rows[0].expires_at),
        createdAt: iso(rows[0].created_at)
      };
    },

    async listListings(filters = {}) {
      const { rows } = await selectFiltered({
        query,
        table: 'listings',
        baseWhere: ["status <> 'blocked'"],
        columns: {
          sellerAgentId: 'seller_agent_id',
          category: 'category',
          assuranceTier: 'assurance_tier',
          status: 'status',
          inventoryType: 'inventory_type'
        },
        filters
      });
      return rows.map(listingFromRow);
    },

    async getListing(id) {
      const { rows } = await query('select * from listings where id = $1', [id]);
      return listingFromRow(rows[0]);
    },

    async pauseListing(id, { reason = null, actor = 'admin' } = {}) {
      const { rows } = await query(
        `update listings
         set status = 'paused', updated_at = now()
         where id = $1
         returning *`,
        [id]
      );
      const listing = listingFromRow(rows[0]);
      if (!listing) return null;
      await insertAuditEvent({
        type: 'listing.paused',
        severity: 'warn',
        actorAgentId: eventActor(actor),
        resourceType: 'listing',
        resourceId: listing.id,
        payload: {
          sellerAgentId: listing.sellerAgentId,
          reason
        }
      });
      return listing;
    },

    async createListing(input, screening) {
      const inventory = normalizeListingInventory(input);
      const listingId = `lst_${randomUUID()}`;
      const client = await pool.connect();
      try {
        await client.query('begin');
        const { rows } = await client.query(
          `insert into listings (
            id, seller_agent_id, title, description, category, assurance_tier, price_usdc,
            inventory_type, accepts_offers, ask_price_usdc, unit_price_usdc,
            total_quantity, available_quantity, unit, min_fill_quantity, max_fill_quantity,
            metadata, status, screening
          ) values (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18, $19::jsonb
          ) returning *`,
          [
            listingId,
            input.sellerAgentId,
            input.title,
            input.description ?? '',
            input.category,
            input.assuranceTier,
            input.priceUsdc,
            inventory.inventoryType,
            inventory.acceptsOffers,
            inventory.askPriceUsdc,
            inventory.unitPriceUsdc,
            inventory.totalQuantity,
            inventory.availableQuantity,
            inventory.unit,
            inventory.minFillQuantity,
            inventory.maxFillQuantity,
            jsonb(input.metadata ?? {}),
            'active',
            jsonb(screening)
          ]
        );
        await client.query(
          `insert into inventory_lots (id, listing_id, total_quantity, available_quantity, unit)
           values ($1, $2, $3, $4, $5)`,
          [`lot_${listingId}`, listingId, inventory.totalQuantity, inventory.availableQuantity, inventory.unit]
        );
        await insertAuditEvent({
          type: 'listing.created',
          severity: 'info',
          actorAgentId: input.sellerAgentId,
          resourceType: 'listing',
          resourceId: listingId,
          payload: {
            category: input.category,
            assuranceTier: input.assuranceTier,
            inventoryType: inventory.inventoryType
          }
        }, client);
        await client.query('commit');
        return listingFromRow(rows[0]);
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async recordBlockedListingAttempt(input, screening) {
      const { rows } = await query(
        `insert into moderation_events (id, type, reportable, input, matches)
         values ($1, $2, $3, $4::jsonb, $5::jsonb)
         returning *`,
        [
          `mod_${randomUUID()}`,
          'blocked_listing_attempt',
          screening.reportable,
          jsonb({
            sellerAgentId: input.sellerAgentId,
            category: input.category,
            assuranceTier: input.assuranceTier
          }),
          jsonb(screening.matches)
        ]
      );
      await insertAuditEvent({
        type: 'policy.blocked_listing',
        severity: screening.reportable ? 'critical' : 'warn',
        actorAgentId: input.sellerAgentId ?? null,
        resourceType: 'moderation_event',
        resourceId: rows[0].id,
        payload: {
          reportable: screening.reportable,
          matches: screening.matches.map((match) => match.id),
          category: input.category,
          assuranceTier: input.assuranceTier
        }
      });
      return rows[0];
    },

    async saveIdempotencyRecord(key, fingerprint, response) {
      const { rows } = await query(
        `insert into idempotency_records (key, fingerprint, response)
         values ($1, $2, $3::jsonb)
         returning *`,
        [key, fingerprint, jsonb(response)]
      );
      return rows[0];
    },

    async withIdempotency({ scope, key, input }, fn) {
      if (!key) return fn();

      const recordKey = `${scope}:${key}`;
      const fingerprint = digest(input);
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [recordKey]);
        const existing = await client.query('select * from idempotency_records where key = $1', [recordKey]);
        if (existing.rows[0]) {
          await client.query('commit');
          if (existing.rows[0].fingerprint !== fingerprint) {
            return {
              status: 409,
              body: {
                error: 'idempotency_key_reuse',
                message: 'This Idempotency-Key was already used with a different request body.'
              }
            };
          }
          return clone(existing.rows[0].response);
        }

        const response = await fn();
        await client.query(
          `insert into idempotency_records (key, fingerprint, response)
           values ($1, $2, $3::jsonb)`,
          [recordKey, fingerprint, jsonb(clone(response))]
        );
        await client.query('commit');
        return response;
      } catch (error) {
        await client.query('rollback');
        if (error.code === '23505') {
          const existing = await query('select * from idempotency_records where key = $1', [recordKey]);
          if (existing.rows[0]?.fingerprint === fingerprint) return clone(existing.rows[0].response);
          return {
            status: 409,
            body: {
              error: 'idempotency_key_reuse',
              message: 'This Idempotency-Key was already used with a different request body.'
            }
          };
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async createTrade(input, listing) {
      const quantity = Number(input.quantity ?? 1);
      const unitPriceUsdc = input.unitPriceUsdc ?? listing.unitPriceUsdc ?? listing.priceUsdc;
      const totalPriceUsdc = input.priceUsdc ?? multiplyUnitPrice(unitPriceUsdc, quantity);
      const pseudoOffer = {
        id: null,
        buyerAgentId: input.buyerAgentId,
        sellerAgentId: listing.sellerAgentId,
        quantity,
        unitPriceUsdc,
        totalPriceUsdc
      };
      const client = await pool.connect();
      try {
        await client.query('begin');
        const reservationResult = await reserveInventory({ listing, offer: pseudoOffer, actorAgentId: input.buyerAgentId }, client);
        if (reservationResult.error) {
          await client.query('rollback');
          return { error: reservationResult.error };
        }

        const events = [
          {
            type: 'OFFER_MADE',
            at: nowIso(),
            actor: input.buyerAgentId,
            reservationId: reservationResult.reservation.id,
            payload: { settlementType: currentSettlementType() }
          }
        ];
        const { rows } = await client.query(
          `insert into trades (
            id, listing_id, offer_id, reservation_id, buyer_agent_id, seller_agent_id,
            assurance_tier, buyer_acknowledged_assurance, state, price_usdc, quantity, unit, events
          ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
          returning *`,
          [
            `trd_${randomUUID()}`,
            listing.id,
            null,
            reservationResult.reservation.id,
            input.buyerAgentId,
            listing.sellerAgentId,
            listing.assuranceTier,
            Boolean(input.assuranceAcknowledgement),
            'OFFER_MADE',
            totalPriceUsdc,
            quantity,
            listing.unit ?? 'item',
            jsonb(events)
          ]
        );
        await insertAuditEvent({
          type: 'trade.created',
          severity: 'info',
          actorAgentId: input.buyerAgentId,
          resourceType: 'trade',
          resourceId: rows[0].id,
          payload: {
            listingId: listing.id,
            buyerAgentId: input.buyerAgentId,
            sellerAgentId: listing.sellerAgentId,
            state: 'OFFER_MADE',
            priceUsdc: totalPriceUsdc,
            quantity
          }
        }, client);
        await client.query('commit');
        return { trade: tradeFromRow(rows[0]), reservation: reservationResult.reservation };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async createOffer(input, listing) {
      const quantity = Number(input.quantity ?? 1);
      const unitPriceUsdc = input.unitPriceUsdc ?? input.priceUsdc ?? listing.unitPriceUsdc;
      const totalPriceUsdc = input.totalPriceUsdc ?? multiplyUnitPrice(unitPriceUsdc, quantity);
      const offerId = `off_${randomUUID()}`;
      const rootOfferId = input.rootOfferId ?? offerId;
      const client = await pool.connect();
      try {
        await client.query('begin');
        const { rows } = await client.query(
          `insert into offers (
            id, listing_id, buyer_agent_id, seller_agent_id, parent_offer_id, root_offer_id,
            created_by_agent_id, status, unit_price_usdc, total_price_usdc, quantity, terms,
            assurance_acknowledgement, expires_at
          ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14)
          returning *`,
          [
            offerId,
            listing.id,
            input.buyerAgentId,
            listing.sellerAgentId,
            input.parentOfferId ?? null,
            rootOfferId,
            input.actorAgentId ?? input.buyerAgentId,
            offerStatuses.open,
            unitPriceUsdc,
            totalPriceUsdc,
            quantity,
            jsonb(input.terms ?? {}),
            Boolean(input.assuranceAcknowledgement),
            input.expiresAt
          ]
        );
        await addOfferEvent(offerId, input.parentOfferId ? 'COUNTERED' : 'OFFER_RECEIVED', input.actorAgentId ?? input.buyerAgentId, {
          parentOfferId: input.parentOfferId ?? null
        }, client);
        await insertAuditEvent({
          type: input.parentOfferId ? 'offer.countered' : 'offer.created',
          severity: 'info',
          actorAgentId: input.actorAgentId ?? input.buyerAgentId,
          resourceType: 'offer',
          resourceId: offerId,
          payload: {
            listingId: listing.id,
            buyerAgentId: input.buyerAgentId,
            sellerAgentId: listing.sellerAgentId,
            quantity,
            unitPriceUsdc,
            totalPriceUsdc,
            parentOfferId: input.parentOfferId ?? null
          }
        }, client);
        await client.query('commit');
        return offerFromRow(rows[0]);
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async getOffer(id) {
      const { rows } = await query('select * from offers where id = $1', [id]);
      return offerFromRow(rows[0]);
    },

    async listOffers(filters = {}) {
      const result = await selectFiltered({
        query,
        table: 'offers',
        columns: {
          listingId: 'listing_id',
          buyerAgentId: 'buyer_agent_id',
          sellerAgentId: 'seller_agent_id',
          status: 'status'
        },
        filters
      });
      return result.rows.map(offerFromRow);
    },

    async listOfferEvents(offerId) {
      const { rows } = await query('select * from offer_events where offer_id = $1 order by created_at', [offerId]);
      return rows;
    },

    async counterOffer(parentOffer, input) {
      const listing = await this.getListing(parentOffer.listingId);
      await query('update offers set status = $2, updated_at = now() where id = $1', [
        parentOffer.id,
        offerStatuses.countered
      ]);
      await addOfferEvent(parentOffer.id, 'COUNTERED_BY_NEW_OFFER', input.actorAgentId, {
        counterActorAgentId: input.actorAgentId
      });
      return this.createOffer({
        ...input,
        listingId: parentOffer.listingId,
        buyerAgentId: parentOffer.buyerAgentId,
        parentOfferId: parentOffer.id,
        rootOfferId: parentOffer.rootOfferId,
        assuranceAcknowledgement: input.assuranceAcknowledgement ?? parentOffer.assuranceAcknowledgement
      }, listing);
    },

    async acceptOffer(offerId, actorAgentId) {
      const offer = await this.getOffer(offerId);
      if (!offer) return { status: 404, body: { error: 'offer_not_found' } };
      return acceptOfferInternal({ offer, actorAgentId });
    },

    async rejectOffer(offerId, actorAgentId) {
      const { rows } = await query(
        'update offers set status = $2, updated_at = now() where id = $1 returning *',
        [offerId, offerStatuses.rejected]
      );
      await addOfferEvent(offerId, 'REJECTED', actorAgentId);
      const offer = offerFromRow(rows[0]);
      if (offer) {
        await insertAuditEvent({
          type: 'offer.rejected',
          severity: 'info',
          actorAgentId,
          resourceType: 'offer',
          resourceId: offer.id,
          payload: { listingId: offer.listingId }
        });
      }
      return offer;
    },

    async withdrawOffer(offerId, actorAgentId) {
      const { rows } = await query(
        'update offers set status = $2, updated_at = now() where id = $1 returning *',
        [offerId, offerStatuses.withdrawn]
      );
      await addOfferEvent(offerId, 'WITHDRAWN', actorAgentId);
      const offer = offerFromRow(rows[0]);
      if (offer) {
        await insertAuditEvent({
          type: 'offer.withdrawn',
          severity: 'info',
          actorAgentId,
          resourceType: 'offer',
          resourceId: offer.id,
          payload: { listingId: offer.listingId }
        });
      }
      return offer;
    },

    async expireOffer(offerId, actorAgentId = 'system') {
      const { rows } = await query(
        'update offers set status = $2, updated_at = now() where id = $1 returning *',
        [offerId, offerStatuses.expired]
      );
      await addOfferEvent(offerId, 'EXPIRED', actorAgentId);
      const offer = offerFromRow(rows[0]);
      if (offer) {
        await insertAuditEvent({
          type: 'offer.expired',
          severity: 'info',
          actorAgentId: eventActor(actorAgentId),
          resourceType: 'offer',
          resourceId: offer.id,
          payload: { listingId: offer.listingId }
        });
      }
      return offer;
    },

    async evaluateAutoAccept(offer) {
      const listing = await this.getListing(offer.listingId);
      const buyer = await this.getAgent(offer.buyerAgentId);
      const rules = await this.listAutoAcceptRules(offer.listingId);
      const matches = [];

      for (const rule of rules.filter((candidate) => candidate.enabled)) {
        const match = ruleMatchesOffer({ rule, offer, buyer });
        await addOfferEvent(offer.id, 'AUTO_ACCEPT_RULE_EVALUATED', 'system', {
          ruleId: rule.id,
          matched: match.matched,
          reasons: match.reasons,
          dryRun: rule.dryRun
        });
        if (!match.matched) continue;
        matches.push(rule);
        if (rule.dryRun) continue;

        const accepted = await query(
          `select coalesce(json_agg(total_price_usdc), '[]'::json) as totals
           from offers
           where auto_accept_rule_id = $1 and accepted_at::date = now()::date`,
          [rule.id]
        );
        const acceptedToday = accepted.rows[0].totals.reduce((sum, value) => addUsdc(sum, value), '0.00');
        if (compareUsdc(addUsdc(acceptedToday, offer.totalPriceUsdc), rule.maxDailyAutoAcceptedUsdc) > 0) {
          await addOfferEvent(offer.id, 'AUTO_ACCEPT_DAILY_CAP_BLOCKED', 'system', {
            ruleId: rule.id,
            maxDailyAutoAcceptedUsdc: rule.maxDailyAutoAcceptedUsdc
          });
          continue;
        }

        const result = await acceptOfferInternal({
          offer,
          actorAgentId: listing.sellerAgentId,
          autoAcceptRuleId: rule.id
        });
        return { matches, result };
      }
      return { matches, result: null };
    },

    async createAutoAcceptRule(listing, input) {
      const { rows } = await query(
        `insert into auto_accept_rules (
          id, listing_id, seller_agent_id, min_unit_price_usdc, max_quantity_per_trade,
          max_daily_auto_accepted_usdc, min_buyer_reputation, required_assurance_acknowledgement,
          offer_expires_within_seconds, dry_run, enabled
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        returning *`,
        [
          `aar_${randomUUID()}`,
          listing.id,
          listing.sellerAgentId,
          input.minUnitPriceUsdc,
          Number(input.maxQuantityPerTrade),
          input.maxDailyAutoAcceptedUsdc,
          Number(input.minBuyerReputation ?? 0),
          Boolean(input.requiredAssuranceAcknowledgement),
          Number(input.offerExpiresWithinSeconds),
          input.dryRun ?? true,
          input.enabled ?? true
        ]
      );
      return autoAcceptRuleFromRow(rows[0]);
    },

    async listAutoAcceptRules(listingId) {
      const { rows } = await query(
        'select * from auto_accept_rules where listing_id = $1 order by created_at desc',
        [listingId]
      );
      return rows.map(autoAcceptRuleFromRow);
    },

    async getAutoAcceptRule(ruleId) {
      const { rows } = await query('select * from auto_accept_rules where id = $1', [ruleId]);
      return autoAcceptRuleFromRow(rows[0]);
    },

    async disableAutoAcceptRule(ruleId, actorAgentId) {
      const { rows } = await query(
        `update auto_accept_rules
         set enabled = false, disabled_by_agent_id = $2, updated_at = now()
         where id = $1
         returning *`,
        [ruleId, actorAgentId]
      );
      const rule = autoAcceptRuleFromRow(rows[0]);
      if (rule) {
        await insertAuditEvent({
          type: 'auto_accept_rule.disabled',
          severity: 'warn',
          actorAgentId,
          resourceType: 'auto_accept_rule',
          resourceId: rule.id,
          payload: { listingId: rule.listingId }
        });
      }
      return rule;
    },

    async listInventoryReservations({ listingId } = {}) {
      const result = listingId
        ? await query('select * from inventory_reservations where listing_id = $1 order by created_at desc', [listingId])
        : await query('select * from inventory_reservations order by created_at desc');
      return result.rows.map(reservationFromRow);
    },

    async getMarket(listingId) {
      const listing = await this.getListing(listingId);
      return listing ? marketForListing(listing) : null;
    },

    async listMarkets() {
      const { rows } = await query("select * from listings where inventory_type = 'fungible' order by created_at desc");
      return Promise.all(rows.map((row) => marketForListing(listingFromRow(row))));
    },

    async getTrade(id) {
      const { rows } = await query('select * from trades where id = $1', [id]);
      return tradeFromRow(rows[0]);
    },

    async listTrades(filters = {}) {
      const { rows } = await selectFiltered({
        query,
        table: 'trades',
        columns: {
          listingId: 'listing_id',
          buyerAgentId: 'buyer_agent_id',
          sellerAgentId: 'seller_agent_id',
          state: 'state'
        },
        filters
      });
      return rows.map(tradeFromRow);
    },

    async transitionTrade(tradeId, transition) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const tradeResult = await client.query('select * from trades where id = $1 for update', [tradeId]);
        const trade = tradeFromRow(tradeResult.rows[0]);
        if (!trade) {
          await client.query('rollback');
          return null;
        }
        if (!transition.from.includes(trade.state)) {
          await client.query('rollback');
          return {
            error: {
              status: 409,
              body: {
                error: 'invalid_trade_transition',
                state: trade.state,
                allowedFrom: transition.from
              }
            }
          };
        }

        let paymentIntent = null;
        let escrowEvent = null;
        if (transition.escrowType) {
          const action = paymentActionForEscrowType(transition.escrowType);
          const paymentProvider = transition.paymentProvider ?? 'sandbox';
          const paymentStatus = transition.paymentStatus ?? sandboxStatusForOutcome(transition.paymentOutcome);
          const paymentIntentResult = await client.query(
            `insert into payment_intents (
              id, trade_id, action, amount_usdc, actor, provider, provider_payment_id,
              status, idempotency_key, metadata, completed_at
            ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
            returning *`,
            [
              `pay_${randomUUID()}`,
              tradeId,
              action,
              transition.escrowAmountUsdc ?? trade.priceUsdc,
              transition.actor,
              paymentProvider,
              transition.providerPaymentId ?? `${paymentProvider}_${randomUUID()}`,
              paymentStatus,
              transition.paymentIdempotencyKey ?? null,
              jsonb(transition.paymentMetadata ?? transition.escrowPayload ?? {}),
              isTerminalPaymentStatus(paymentStatus) ? nowIso() : null
            ]
          );
          paymentIntent = paymentIntentFromRow(paymentIntentResult.rows[0]);
          await insertAuditEvent({
            type: 'payment.intent_created',
            severity: paymentIntent.status === paymentStatuses.succeeded ? 'info' : 'warn',
            actorAgentId: eventActor(transition.actor),
            resourceType: 'payment_intent',
            resourceId: paymentIntent.id,
            payload: {
              tradeId: paymentIntent.tradeId,
              action: paymentIntent.action,
              amountUsdc: paymentIntent.amountUsdc,
              provider: paymentIntent.provider,
              status: paymentIntent.status
            }
          }, client);
          if (paymentIntent.status !== paymentStatuses.succeeded) {
            await client.query('commit');
            return {
              error: {
                status: paymentIntent.status === paymentStatuses.declined ? 402 : 502,
                body: {
                  error: 'sandbox_payment_not_settled',
                  paymentStatus: paymentIntent.status,
                  paymentIntent
                }
              }
            };
          }

          const escrowResult = await client.query(
            `insert into escrow_events (id, trade_id, type, amount_usdc, actor, adapter, payload)
             values ($1, $2, $3, $4, $5, $6, $7::jsonb)
             returning *`,
            [
              `esc_${randomUUID()}`,
              tradeId,
              transition.escrowType,
              transition.escrowAmountUsdc ?? trade.priceUsdc,
              transition.actor,
              paymentProvider,
              jsonb({
                ...(transition.escrowPayload ?? {}),
                paymentIntentId: paymentIntent.id,
                providerPaymentId: paymentIntent.providerPaymentId
              })
            ]
          );
          escrowEvent = escrowEventFromRow(escrowResult.rows[0]);
          const updatedPaymentIntent = await client.query(
            `update payment_intents
             set escrow_event_id = $2, updated_at = now()
             where id = $1
             returning *`,
            [paymentIntent.id, escrowEvent.id]
          );
          paymentIntent = paymentIntentFromRow(updatedPaymentIntent.rows[0]);
          await insertAuditEvent({
            type: 'escrow.event_created',
            severity: 'info',
            actorAgentId: eventActor(transition.actor),
            resourceType: 'trade',
            resourceId: tradeId,
            payload: {
              escrowEventId: escrowEvent.id,
              escrowType: escrowEvent.type,
              amountUsdc: escrowEvent.amountUsdc,
              adapter: escrowEvent.adapter,
              paymentIntentId: paymentIntent.id
            }
          }, client);
        }

        const event = {
          at: nowIso(),
          type: transition.eventType,
          actor: transition.actor,
          from: trade.state,
          to: transition.to,
          payload: {
            ...(transition.payload ?? {}),
            escrowEventId: escrowEvent?.id ?? transition.payload?.escrowEventId ?? null,
            paymentIntentId: paymentIntent?.id ?? transition.payload?.paymentIntentId ?? null
          }
        };
        const events = [...trade.events, event];
        const updatedTradeResult = await client.query(
          `update trades
           set state = $2, events = $3::jsonb, updated_at = now()
           where id = $1
           returning *`,
          [tradeId, transition.to, jsonb(events)]
        );
        const updatedTrade = tradeFromRow(updatedTradeResult.rows[0]);

        for (const impact of reputationImpacts({ transition, trade: updatedTrade })) {
          const agentResult = await client.query('select * from agents where id = $1 for update', [impact.agentId]);
          const agent = agentFromRow(agentResult.rows[0]);
          if (!agent) continue;

          const previousScore = agent.reputationScore;
          const newScore = clampReputation(previousScore + impact.delta);
          await client.query(
            `update agents
             set reputation_score = $2, updated_at = now()
             where id = $1`,
            [impact.agentId, newScore]
          );
          await client.query(
            `insert into reputation_events (
              id, agent_id, trade_id, role, delta, reason, previous_score, new_score, metadata
            ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
            [
              `rep_${randomUUID()}`,
              impact.agentId,
              updatedTrade.id,
              impact.role,
              impact.delta,
              impact.reason,
              previousScore,
              newScore,
              jsonb({
                transition: transition.eventType,
                tradeState: transition.to
              })
            ]
          );
          await insertAuditEvent({
            type: 'reputation.changed',
            severity: impact.delta < 0 ? 'warn' : 'info',
            actorAgentId: impact.agentId,
            resourceType: 'agent',
            resourceId: impact.agentId,
            payload: {
              tradeId: updatedTrade.id,
              role: impact.role,
              delta: impact.delta,
              reason: impact.reason,
              previousScore,
              newScore
            }
          }, client);
        }

        await insertAuditEvent({
          type: 'trade.transitioned',
          severity: transition.to === 'DISPUTED' ? 'warn' : 'info',
          actorAgentId: eventActor(transition.actor),
          resourceType: 'trade',
          resourceId: updatedTrade.id,
          payload: {
            from: trade.state,
            to: transition.to,
            eventType: transition.eventType
          }
        }, client);

        await client.query('commit');
        return { trade: updatedTrade, escrowEvent, paymentIntent };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async listEscrowEvents() {
      const { rows } = await query('select * from escrow_events order by created_at desc');
      return rows.map(escrowEventFromRow);
    },

    async getPaymentIntent(id) {
      const { rows } = await query('select * from payment_intents where id = $1', [id]);
      return paymentIntentFromRow(rows[0]);
    },

    async listPaymentIntents(filters = {}) {
      const { rows } = await selectFiltered({
        query,
        table: 'payment_intents',
        columns: {
          tradeId: 'trade_id',
          action: 'action',
          provider: 'provider',
          status: 'status'
        },
        filters
      });
      return rows.map(paymentIntentFromRow);
    },

    async listPaymentEvents(filters = {}) {
      const { rows } = await selectFiltered({
        query,
        table: 'payment_events',
        columns: {
          paymentIntentId: 'payment_intent_id',
          provider: 'provider',
          status: 'status'
        },
        filters
      });
      return rows.map(paymentEventFromRow);
    },

    async recordExternalPaymentSettlement(input) {
      if (!Object.values(paymentStatuses).includes(input.status)) {
        return { error: { status: 400, body: { error: 'invalid_payment_status' } } };
      }

      const client = await pool.connect();
      try {
        await client.query('begin');

        const paymentIntentResult = await client.query(
          `insert into payment_intents (
            id, trade_id, escrow_event_id, action, amount_usdc, actor, provider,
            provider_payment_id, status, idempotency_key, metadata, completed_at
          ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
          on conflict (provider_payment_id) do nothing
          returning *`,
          [
            input.paymentIntentId ?? `pay_${randomUUID()}`,
            input.tradeId ?? null,
            input.escrowEventId ?? null,
            input.action ?? 'CAPTURE',
            input.amountUsdc,
            input.actor ?? 'external',
            input.provider,
            input.providerPaymentId,
            input.status,
            input.idempotencyKey ?? null,
            jsonb(input.metadata ?? {}),
            isTerminalPaymentStatus(input.status) ? nowIso() : null
          ]
        );

        if (!paymentIntentResult.rows[0]) {
          const existingIntentResult = await client.query(
            `select * from payment_intents
             where provider_payment_id = $1`,
            [input.providerPaymentId]
          );
          const existingIntent = paymentIntentFromRow(existingIntentResult.rows[0]);
          const existingEventResult = await client.query(
            `select * from payment_events
             where payment_intent_id = $1
             order by created_at desc
             limit 1`,
            [existingIntent.id]
          );
          await client.query('commit');
          return {
            duplicate: true,
            paymentIntent: existingIntent,
            paymentEvent: paymentEventFromRow(existingEventResult.rows[0])
          };
        }

        const paymentIntent = paymentIntentFromRow(paymentIntentResult.rows[0]);
        const paymentEventResult = await client.query(
          `insert into payment_events (id, payment_intent_id, provider, type, status, payload)
           values ($1, $2, $3, $4, $5, $6::jsonb)
           returning *`,
          [
            input.eventId ?? `evt_${randomUUID()}`,
            paymentIntent.id,
            input.provider,
            input.eventType ?? `${input.provider}.payment_settled`,
            input.status,
            jsonb(input.payload ?? {})
          ]
        );
        const paymentEvent = paymentEventFromRow(paymentEventResult.rows[0]);
        await insertAuditEvent({
          type: 'payment.external_settled',
          severity: input.status === paymentStatuses.succeeded ? 'info' : 'warn',
          actorAgentId: eventActor(input.actor),
          resourceType: 'payment_intent',
          resourceId: paymentIntent.id,
          payload: {
            eventId: paymentEvent.id,
            provider: paymentIntent.provider,
            providerPaymentId: paymentIntent.providerPaymentId,
            status: paymentIntent.status,
            duplicate: false
          }
        }, client);
        await client.query('commit');
        return { duplicate: false, paymentIntent, paymentEvent };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async recordPaymentWebhookEvent(input) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const existingEvent = await client.query('select * from payment_events where id = $1', [input.eventId]);
        if (existingEvent.rows[0]) {
          const paymentIntent = await client.query(
            'select * from payment_intents where id = $1',
            [existingEvent.rows[0].payment_intent_id]
          );
          await client.query('commit');
          return {
            duplicate: true,
            event: paymentEventFromRow(existingEvent.rows[0]),
            paymentIntent: paymentIntentFromRow(paymentIntent.rows[0])
          };
        }

        const paymentIntentResult = await client.query(
          'select * from payment_intents where id = $1 for update',
          [input.paymentIntentId]
        );
        const paymentIntent = paymentIntentFromRow(paymentIntentResult.rows[0]);
        if (!paymentIntent) {
          await client.query('rollback');
          return { error: { status: 404, body: { error: 'payment_intent_not_found' } } };
        }
        if (!Object.values(paymentStatuses).includes(input.status)) {
          await client.query('rollback');
          return { error: { status: 400, body: { error: 'invalid_payment_status' } } };
        }
        if (
          isTerminalPaymentStatus(paymentIntent.status) &&
          paymentIntent.status !== input.status
        ) {
          await client.query('rollback');
          return {
            error: {
              status: 409,
              body: {
                error: 'payment_status_conflict',
                currentStatus: paymentIntent.status,
                requestedStatus: input.status
              }
            }
          };
        }

        const eventResult = await client.query(
          `insert into payment_events (id, payment_intent_id, provider, type, status, payload)
           values ($1, $2, $3, $4, $5, $6::jsonb)
           returning *`,
          [
            input.eventId,
            paymentIntent.id,
            'sandbox',
            input.type ?? 'sandbox.payment_status',
            input.status,
            jsonb(input.payload ?? {})
          ]
        );
        const updatedPaymentIntentResult = await client.query(
          `update payment_intents
           set status = $2, updated_at = now(),
               completed_at = case when $3 then now() else completed_at end
           where id = $1
           returning *`,
          [paymentIntent.id, input.status, isTerminalPaymentStatus(input.status)]
        );
        const updatedPaymentIntent = paymentIntentFromRow(updatedPaymentIntentResult.rows[0]);
        await insertAuditEvent({
          type: 'payment.webhook_received',
          severity: input.status === paymentStatuses.succeeded ? 'info' : 'warn',
          resourceType: 'payment_intent',
          resourceId: updatedPaymentIntent.id,
          payload: {
            eventId: input.eventId,
            status: input.status,
            provider: 'sandbox',
            duplicate: false
          }
        }, client);
        await client.query('commit');
        return {
          duplicate: false,
          event: paymentEventFromRow(eventResult.rows[0]),
          paymentIntent: updatedPaymentIntent
        };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async adminRepairPaymentIntent(input) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const paymentIntentResult = await client.query(
          'select * from payment_intents where id = $1 for update',
          [input.paymentIntentId]
        );
        const paymentIntent = paymentIntentFromRow(paymentIntentResult.rows[0]);
        if (!paymentIntent) {
          await client.query('rollback');
          return { error: { status: 404, body: { error: 'payment_intent_not_found' } } };
        }
        if (!Object.values(paymentStatuses).includes(input.status)) {
          await client.query('rollback');
          return { error: { status: 400, body: { error: 'invalid_payment_status' } } };
        }
        if (!input.reason || typeof input.reason !== 'string') {
          await client.query('rollback');
          return { error: { status: 400, body: { error: 'repair_reason_required' } } };
        }
        if (
          isTerminalPaymentStatus(paymentIntent.status) &&
          paymentIntent.status !== input.status &&
          input.force !== true
        ) {
          await client.query('rollback');
          return {
            error: {
              status: 409,
              body: {
                error: 'terminal_payment_repair_requires_force',
                currentStatus: paymentIntent.status,
                requestedStatus: input.status
              }
            }
          };
        }

        const eventId = input.eventId ?? `pevt_${randomUUID()}`;
        const eventPayload = {
          previousStatus: paymentIntent.status,
          repairedBy: input.actor ?? 'admin',
          reason: input.reason,
          force: input.force === true,
          metadata: input.metadata ?? {}
        };
        const eventResult = await client.query(
          `insert into payment_events (id, payment_intent_id, provider, type, status, payload)
           values ($1, $2, $3, $4, $5, $6::jsonb)
           returning *`,
          [
            eventId,
            paymentIntent.id,
            paymentIntent.provider,
            'admin.payment_status_repaired',
            input.status,
            jsonb(eventPayload)
          ]
        );
        const updatedPaymentIntentResult = await client.query(
          `update payment_intents
           set status = $2, updated_at = now(),
               completed_at = case when $3 then now() else completed_at end
           where id = $1
           returning *`,
          [paymentIntent.id, input.status, isTerminalPaymentStatus(input.status)]
        );
        const updatedPaymentIntent = paymentIntentFromRow(updatedPaymentIntentResult.rows[0]);
        await insertAuditEvent({
          type: 'payment.intent_repaired',
          severity: 'warn',
          resourceType: 'payment_intent',
          resourceId: updatedPaymentIntent.id,
          payload: {
            eventId,
            previousStatus: paymentIntent.status,
            status: input.status,
            force: input.force === true,
            reason: input.reason
          }
        }, client);
        await client.query('commit');
        return {
          event: paymentEventFromRow(eventResult.rows[0]),
          paymentIntent: updatedPaymentIntent
        };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async listModerationEvents() {
      const { rows } = await query('select * from moderation_events order by created_at desc');
      return rows;
    }
  };

  return methods;
}
