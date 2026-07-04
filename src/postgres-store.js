import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { addUsdc, compareUsdc, multiplyUnitPrice, subtractUsdc } from './money.js';
import { isOfferOpen, offerStatuses, ruleMatchesOffer } from './negotiation.js';

const { Pool } = pg;

function nowIso() {
  return new Date().toISOString();
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function tokenDigest(token) {
  return createHash('sha256').update(token).digest('hex');
}

function clone(value) {
  return structuredClone(value);
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : value;
}

function makePool(connectionString) {
  const ssl = connectionString.includes('supabase.com') || connectionString.includes('sslmode=require')
    ? { rejectUnauthorized: false }
    : undefined;
  return new Pool({ connectionString, ssl });
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
       values ($1, $2, $3, $4, $5)
       returning *`,
      [`ofe_${randomUUID()}`, offerId, type, actorAgentId, payload]
    );
    return rows[0];
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
          reservationId: reservation.id
        }
      ]
    };
    const { rows } = await client.query(
      `insert into trades (
        id, listing_id, offer_id, reservation_id, buyer_agent_id, seller_agent_id,
        assurance_tier, buyer_acknowledged_assurance, state, price_usdc, quantity, unit, events
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
        trade.events
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
        ) values ($1, $2, $3, $4, $5, $6, $7, $8)
        returning *`,
        [
          `agt_${randomUUID()}`,
          input.developerId,
          input.name,
          input.walletAddress ?? null,
          input.publicKeyJwk ?? null,
          Number(input.reputationScore ?? 0),
          input.publicKeyJwk ? 2 : 0,
          'active'
        ]
      );
      return agentFromRow(rows[0]);
    },

    async getAgent(id) {
      const { rows } = await query('select * from agents where id = $1', [id]);
      return agentFromRow(rows[0]);
    },

    async listAgents() {
      const { rows } = await query('select * from agents order by created_at desc');
      return rows.map(agentFromRow);
    },

    async cleanupExpired(now = new Date()) {
      const removedChallenges = await query(
        'delete from challenges where used_at is not null or expires_at <= $1',
        [now]
      );
      const removedSessions = await query('delete from sessions where expires_at <= $1', [now]);
      const removedIdempotencyRecords = await query(
        `delete from idempotency_records where created_at + interval '24 hours' <= $1`,
        [now]
      );
      return {
        removedChallenges: removedChallenges.rowCount,
        removedSessions: removedSessions.rowCount,
        removedIdempotencyRecords: removedIdempotencyRecords.rowCount
      };
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

    async listListings() {
      const { rows } = await query("select * from listings where status <> 'blocked' order by created_at desc");
      return rows.map(listingFromRow);
    },

    async getListing(id) {
      const { rows } = await query('select * from listings where id = $1', [id]);
      return listingFromRow(rows[0]);
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
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19
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
            input.metadata ?? {},
            'active',
            screening
          ]
        );
        await client.query(
          `insert into inventory_lots (id, listing_id, total_quantity, available_quantity, unit)
           values ($1, $2, $3, $4, $5)`,
          [`lot_${listingId}`, listingId, inventory.totalQuantity, inventory.availableQuantity, inventory.unit]
        );
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
         values ($1, $2, $3, $4, $5)
         returning *`,
        [
          `mod_${randomUUID()}`,
          'blocked_listing_attempt',
          screening.reportable,
          {
            sellerAgentId: input.sellerAgentId,
            category: input.category,
            assuranceTier: input.assuranceTier
          },
          screening.matches
        ]
      );
      return rows[0];
    },

    async saveIdempotencyRecord(key, fingerprint, response) {
      const { rows } = await query(
        `insert into idempotency_records (key, fingerprint, response)
         values ($1, $2, $3)
         returning *`,
        [key, fingerprint, response]
      );
      return rows[0];
    },

    async withIdempotency({ scope, key, input }, fn) {
      if (!key) return fn();

      const recordKey = `${scope}:${key}`;
      const fingerprint = digest(input);
      const existing = await query('select * from idempotency_records where key = $1', [recordKey]);
      if (existing.rows[0]) {
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
      await this.saveIdempotencyRecord(recordKey, fingerprint, clone(response));
      return response;
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
            reservationId: reservationResult.reservation.id
          }
        ];
        const { rows } = await client.query(
          `insert into trades (
            id, listing_id, offer_id, reservation_id, buyer_agent_id, seller_agent_id,
            assurance_tier, buyer_acknowledged_assurance, state, price_usdc, quantity, unit, events
          ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
            events
          ]
        );
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
          ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
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
            input.terms ?? {},
            Boolean(input.assuranceAcknowledgement),
            input.expiresAt
          ]
        );
        await addOfferEvent(offerId, input.parentOfferId ? 'COUNTERED' : 'OFFER_RECEIVED', input.actorAgentId ?? input.buyerAgentId, {
          parentOfferId: input.parentOfferId ?? null
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

    async listOffers({ listingId } = {}) {
      const result = listingId
        ? await query('select * from offers where listing_id = $1 order by created_at desc', [listingId])
        : await query('select * from offers order by created_at desc');
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
      return offerFromRow(rows[0]);
    },

    async withdrawOffer(offerId, actorAgentId) {
      const { rows } = await query(
        'update offers set status = $2, updated_at = now() where id = $1 returning *',
        [offerId, offerStatuses.withdrawn]
      );
      await addOfferEvent(offerId, 'WITHDRAWN', actorAgentId);
      return offerFromRow(rows[0]);
    },

    async expireOffer(offerId, actorAgentId = 'system') {
      const { rows } = await query(
        'update offers set status = $2, updated_at = now() where id = $1 returning *',
        [offerId, offerStatuses.expired]
      );
      await addOfferEvent(offerId, 'EXPIRED', actorAgentId);
      return offerFromRow(rows[0]);
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
      return autoAcceptRuleFromRow(rows[0]);
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

    async listTrades() {
      const { rows } = await query('select * from trades order by created_at desc');
      return rows.map(tradeFromRow);
    },

    async transitionTrade(tradeId, transition) {
      const trade = await this.getTrade(tradeId);
      if (!trade) return null;

      const event = {
        at: nowIso(),
        type: transition.eventType,
        actor: transition.actor,
        from: trade.state,
        to: transition.to,
        payload: transition.payload ?? {}
      };
      const events = [...trade.events, event];
      const { rows } = await query(
        `update trades
         set state = $2, events = $3, updated_at = now()
         where id = $1
         returning *`,
        [tradeId, transition.to, events]
      );
      return tradeFromRow(rows[0]);
    },

    async createEscrowEvent({ tradeId, type, amountUsdc, actor, payload = {} }) {
      const { rows } = await query(
        `insert into escrow_events (id, trade_id, type, amount_usdc, actor, adapter, payload)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning *`,
        [`esc_${randomUUID()}`, tradeId, type, amountUsdc, actor, 'stub', payload]
      );
      return escrowEventFromRow(rows[0]);
    },

    async listEscrowEvents() {
      const { rows } = await query('select * from escrow_events order by created_at desc');
      return rows.map(escrowEventFromRow);
    },

    async listModerationEvents() {
      const { rows } = await query('select * from moderation_events order by created_at desc');
      return rows;
    }
  };

  return methods;
}
