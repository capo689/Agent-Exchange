import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { addUsdc, compareUsdc, multiplyUnitPrice, subtractUsdc } from './money.js';
import { isOfferOpen, offerStatuses, ruleMatchesOffer } from './negotiation.js';
import {
  isTerminalPaymentStatus,
  paymentActionForEscrowType,
  paymentStatuses,
  sandboxStatusForOutcome
} from './payments.js';
import { getConfig } from './config.js';

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

function redactApiKey(apiKey) {
  const { tokenHash, ...safe } = clone(apiKey);
  return safe;
}

function currentSettlementType() {
  return getConfig().marketplace.settlementType;
}

function settlementTypeFromTrade(trade) {
  return trade.settlementType ?? trade.events?.[0]?.payload?.settlementType ?? currentSettlementType();
}

function createInitialState() {
  return {
    agents: [],
    apiKeys: [],
    challenges: [],
    sessions: [],
    listings: [],
    offers: [],
    offerEvents: [],
    inventoryLots: [],
    inventoryReservations: [],
    autoAcceptRules: [],
    trades: [],
    escrowEvents: [],
    paymentIntents: [],
    paymentEvents: [],
    moderationEvents: [],
    reputationEvents: [],
    ratings: [],
    disputes: [],
    requestLogs: [],
    auditEvents: [],
    signedRequestNonces: [],
    idempotencyRecords: []
  };
}

function mapById(items) {
  return new Map(items.map((item) => [item.id, item]));
}

function applyListQuery(items, { limit = 50, offset = 0, ...filters } = {}) {
  return items
    .filter((item) => Object.entries(filters).every(([key, value]) => value === undefined || item[key] === value))
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
    .slice(offset, offset + limit);
}

function clampReputation(value) {
  return Math.max(0, Math.min(100, Number(value)));
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

export function createStore({ filePath } = {}) {
  const state = filePath && existsSync(filePath)
    ? JSON.parse(readFileSync(filePath, 'utf8'))
    : createInitialState();

  const agents = mapById(state.agents);
  const apiKeys = mapById(state.apiKeys ?? []);
  const challenges = mapById(state.challenges);
  const sessions = mapById(state.sessions);
  const listings = mapById(state.listings);
  const offers = mapById(state.offers ?? []);
  const offerEvents = mapById(state.offerEvents ?? []);
  const inventoryLots = mapById(state.inventoryLots ?? []);
  const inventoryReservations = mapById(state.inventoryReservations ?? []);
  const autoAcceptRules = mapById(state.autoAcceptRules ?? []);
  const trades = mapById(state.trades);
  const escrowEvents = mapById(state.escrowEvents);
  const paymentIntents = mapById(state.paymentIntents ?? []);
  const paymentEvents = mapById(state.paymentEvents ?? []);
  const moderationEvents = state.moderationEvents;
  const reputationEvents = mapById(state.reputationEvents ?? []);
  const ratings = mapById(state.ratings ?? []);
  const disputes = mapById(state.disputes ?? []);
  const requestLogs = mapById(state.requestLogs ?? []);
  const auditEvents = mapById(state.auditEvents ?? []);
  const signedRequestNonces = new Map(
    (state.signedRequestNonces ?? []).map((record) => [`${record.agentId}:${record.nonce}`, record])
  );
  const idempotencyInFlight = new Map();
  const idempotencyRecords = new Map(
    (state.idempotencyRecords ?? []).map((record) => [record.key, record])
  );

  function persist() {
    if (!filePath) return;

    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify(
        {
          agents: [...agents.values()],
          apiKeys: [...apiKeys.values()],
          challenges: [...challenges.values()],
          sessions: [...sessions.values()],
          listings: [...listings.values()],
          offers: [...offers.values()],
          offerEvents: [...offerEvents.values()],
          inventoryLots: [...inventoryLots.values()],
          inventoryReservations: [...inventoryReservations.values()],
          autoAcceptRules: [...autoAcceptRules.values()],
          trades: [...trades.values()],
          escrowEvents: [...escrowEvents.values()],
          paymentIntents: [...paymentIntents.values()],
          paymentEvents: [...paymentEvents.values()],
          moderationEvents,
          reputationEvents: [...reputationEvents.values()],
          ratings: [...ratings.values()],
          disputes: [...disputes.values()],
          requestLogs: [...requestLogs.values()],
          auditEvents: [...auditEvents.values()],
          signedRequestNonces: [...signedRequestNonces.values()],
          idempotencyRecords: [...idempotencyRecords.values()]
        },
        null,
        2
      )
    );
  }

  function addTradeEvent(trade, event) {
    trade.events.push({
      at: nowIso(),
      ...event
    });
    trade.updatedAt = nowIso();
  }

  function addOfferEvent(offerId, type, actorAgentId, payload = {}) {
    const event = {
      id: `ofe_${randomUUID()}`,
      offerId,
      type,
      actorAgentId,
      payload,
      createdAt: nowIso()
    };
    offerEvents.set(event.id, event);
    return event;
  }

  function recordAuditEvent(input) {
    const event = {
      id: input.id ?? `aud_${randomUUID()}`,
      type: input.type,
      severity: input.severity ?? 'info',
      actorAgentId: input.actorAgentId ?? null,
      sessionId: input.sessionId ?? null,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      requestId: input.requestId ?? null,
      payload: input.payload ?? {},
      createdAt: input.createdAt ?? nowIso()
    };
    auditEvents.set(event.id, event);
    return event;
  }

  function createTransitionPaymentIntent({ trade, transition, action, amountUsdc }) {
    const now = nowIso();
    const provider = transition.paymentProvider ?? 'sandbox';
    const status = transition.paymentStatus ?? sandboxStatusForOutcome(transition.paymentOutcome);
    const intent = {
      id: `pay_${randomUUID()}`,
      tradeId: trade.id,
      escrowEventId: null,
      action,
      amountUsdc,
      actor: transition.actor,
      provider,
      providerPaymentId: transition.providerPaymentId ?? `${provider}_${randomUUID()}`,
      status,
      idempotencyKey: transition.paymentIdempotencyKey ?? null,
      metadata: transition.paymentMetadata ?? transition.escrowPayload ?? {},
      createdAt: now,
      updatedAt: now,
      completedAt: isTerminalPaymentStatus(status) ? now : null
    };
    paymentIntents.set(intent.id, intent);
    recordAuditEvent({
      type: 'payment.intent_created',
      severity: status === paymentStatuses.succeeded ? 'info' : 'warn',
      actorAgentId: transition.actor === 'admin' ? null : transition.actor,
      resourceType: 'payment_intent',
      resourceId: intent.id,
      payload: {
        tradeId: intent.tradeId,
        action: intent.action,
        amountUsdc: intent.amountUsdc,
        provider: intent.provider,
        status: intent.status
      }
    });
    return intent;
  }

  function recordExternalPaymentSettlement(input) {
    const existingIntent = [...paymentIntents.values()].find((intent) => (
      intent.provider === input.provider &&
      intent.providerPaymentId === input.providerPaymentId
    ));
    if (existingIntent) {
      return {
        duplicate: true,
        paymentIntent: existingIntent,
        paymentEvent: [...paymentEvents.values()]
          .filter((event) => event.paymentIntentId === existingIntent.id)
          .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0] ?? null
      };
    }

    if (!Object.values(paymentStatuses).includes(input.status)) {
      return { error: { status: 400, body: { error: 'invalid_payment_status' } } };
    }

    const now = nowIso();
    const paymentIntent = {
      id: input.paymentIntentId ?? `pay_${randomUUID()}`,
      tradeId: input.tradeId ?? null,
      escrowEventId: input.escrowEventId ?? null,
      action: input.action ?? 'CAPTURE',
      amountUsdc: input.amountUsdc,
      actor: input.actor ?? 'external',
      provider: input.provider,
      providerPaymentId: input.providerPaymentId,
      status: input.status,
      idempotencyKey: input.idempotencyKey ?? null,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
      completedAt: isTerminalPaymentStatus(input.status) ? now : null
    };
    const paymentEvent = {
      id: input.eventId ?? `evt_${randomUUID()}`,
      paymentIntentId: paymentIntent.id,
      provider: input.provider,
      type: input.eventType ?? `${input.provider}.payment_settled`,
      status: input.status,
      payload: input.payload ?? {},
      createdAt: now
    };
    paymentIntents.set(paymentIntent.id, paymentIntent);
    paymentEvents.set(paymentEvent.id, paymentEvent);
    recordAuditEvent({
      type: 'payment.external_settled',
      severity: input.status === paymentStatuses.succeeded ? 'info' : 'warn',
      actorAgentId: null,
      resourceType: 'payment_intent',
      resourceId: paymentIntent.id,
      payload: {
        eventId: paymentEvent.id,
        provider: paymentIntent.provider,
        providerPaymentId: paymentIntent.providerPaymentId,
        status: paymentIntent.status,
        duplicate: false
      }
    });
    persist();
    return { duplicate: false, paymentIntent, paymentEvent };
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

  function validateReservationQuantity(listing, quantity) {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return { error: 'invalid_quantity', message: 'quantity must be a positive integer' };
    }
    if (quantity < listing.minFillQuantity) {
      return { error: 'below_min_fill', message: 'quantity is below minFillQuantity' };
    }
    if (quantity > listing.maxFillQuantity) {
      return { error: 'above_max_fill', message: 'quantity is above maxFillQuantity' };
    }
    if (quantity > listing.availableQuantity) {
      return { error: 'insufficient_inventory', message: 'Not enough inventory is available.' };
    }
    return null;
  }

  function reserveInventory({ listing, offer, actorAgentId }) {
    const quantityError = validateReservationQuantity(listing, offer.quantity);
    if (quantityError) {
      return { error: quantityError };
    }

    listing.availableQuantity -= offer.quantity;
    listing.updatedAt = nowIso();
    if (listing.availableQuantity === 0) {
      listing.status = 'filled';
    } else if (listing.availableQuantity < listing.totalQuantity) {
      listing.status = 'partially_filled';
    }

    const reservation = {
      id: `res_${randomUUID()}`,
      listingId: listing.id,
      offerId: offer.id,
      buyerAgentId: offer.buyerAgentId,
      sellerAgentId: offer.sellerAgentId,
      quantity: offer.quantity,
      unit: listing.unit,
      unitPriceUsdc: offer.unitPriceUsdc,
      totalPriceUsdc: offer.totalPriceUsdc,
      state: 'RESERVED',
      actorAgentId,
      createdAt: nowIso()
    };
    inventoryReservations.set(reservation.id, reservation);
    return { reservation };
  }

  function reserveDirectTradeInventory({ listing, input }) {
    const quantity = Number(input.quantity ?? 1);
    const unitPriceUsdc = input.unitPriceUsdc ?? listing.unitPriceUsdc ?? listing.priceUsdc;
    const pseudoOffer = {
      id: null,
      listingId: listing.id,
      buyerAgentId: input.buyerAgentId,
      sellerAgentId: listing.sellerAgentId,
      quantity,
      unit: listing.unit,
      unitPriceUsdc,
      totalPriceUsdc: input.priceUsdc ?? multiplyUnitPrice(unitPriceUsdc, quantity)
    };

    return reserveInventory({
      listing,
      offer: pseudoOffer,
      actorAgentId: input.buyerAgentId
    });
  }

  function createTradeFromAcceptedOffer({ offer, listing, reservation, actorAgentId }) {
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
      settlementType,
      priceUsdc: offer.totalPriceUsdc,
      quantity: offer.quantity,
      unit: listing.unit,
      createdAt: now,
      updatedAt: now,
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
    trades.set(trade.id, trade);
    return trade;
  }

  function acceptOfferInternal({ offer, actorAgentId, autoAcceptRuleId = null }) {
    const listing = listings.get(offer.listingId);
    if (!listing) {
      return { status: 404, body: { error: 'listing_not_found' } };
    }
    if (!isOfferOpen(offer)) {
      offer.status = Date.parse(offer.expiresAt) <= Date.now() ? offerStatuses.expired : offer.status;
      addOfferEvent(offer.id, 'OFFER_NOT_OPEN', actorAgentId, { status: offer.status });
      persist();
      return { status: 409, body: { error: 'offer_not_open', status: offer.status } };
    }

    const reservationResult = reserveInventory({ listing, offer, actorAgentId });
    if (reservationResult.error) {
      addOfferEvent(offer.id, 'INVENTORY_RESERVATION_FAILED', actorAgentId, reservationResult.error);
      persist();
      return { status: 409, body: reservationResult.error };
    }

    offer.status = offerStatuses.accepted;
    offer.acceptedAt = nowIso();
    offer.acceptedByAgentId = actorAgentId;
    offer.autoAcceptRuleId = autoAcceptRuleId;
    const trade = createTradeFromAcceptedOffer({
      offer,
      listing,
      reservation: reservationResult.reservation,
      actorAgentId
    });
    addOfferEvent(offer.id, autoAcceptRuleId ? 'AUTO_ACCEPTED' : 'ACCEPTED', actorAgentId, {
      tradeId: trade.id,
      reservationId: reservationResult.reservation.id,
      autoAcceptRuleId
    });
    recordAuditEvent({
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
    });
    recordAuditEvent({
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
    });
    persist();
    return {
      status: 200,
      body: {
        offer,
        reservation: reservationResult.reservation,
        trade
      }
    };
  }

  function activeOffersForListing(listingId) {
    return [...offers.values()].filter((offer) => offer.listingId === listingId && isOfferOpen(offer));
  }

  function marketForListing(listing) {
    const activeOffers = activeOffersForListing(listing.id);
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

  function ratingSummaryForAgent(agentId) {
    const agentRatings = [...ratings.values()].filter((rating) => rating.targetAgentId === agentId);
    const byRole = {};
    for (const role of ['buyer', 'seller']) {
      const roleRatings = agentRatings.filter((rating) => rating.targetRole === role);
      const average = roleRatings.length
        ? roleRatings.reduce((sum, rating) => sum + Number(rating.score), 0) / roleRatings.length
        : null;
      byRole[role] = {
        count: roleRatings.length,
        averageScore: average === null ? null : Number(average.toFixed(2))
      };
    }
    const average = agentRatings.length
      ? agentRatings.reduce((sum, rating) => sum + Number(rating.score), 0) / agentRatings.length
      : null;
    return {
      agentId,
      count: agentRatings.length,
      averageScore: average === null ? null : Number(average.toFixed(2)),
      byRole
    };
  }

  function visibleRating(rating, { includeComment = false } = {}) {
    return {
      ...rating,
      comment: includeComment ? rating.comment : null
    };
  }

  function findOpenDisputeForTrade(tradeId) {
    return [...disputes.values()]
      .find((dispute) => dispute.tradeId === tradeId && !['resolved', 'closed'].includes(dispute.status)) ?? null;
  }

  return {
    createAgent(input) {
      const now = nowIso();
      const agent = {
        id: `agt_${randomUUID()}`,
        developerId: input.developerId,
        name: input.name,
        walletAddress: input.walletAddress ?? null,
        publicKeyJwk: input.publicKeyJwk ?? null,
        reputationScore: clampReputation(input.reputationScore ?? 0),
        verificationTier: input.publicKeyJwk ? 2 : 0,
        status: 'active',
        createdAt: now,
        updatedAt: now
      };

      agents.set(agent.id, agent);
      recordAuditEvent({
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
      persist();
      return agent;
    },

    getAgent(id) {
      return agents.get(id) ?? null;
    },

    flagAgent(id, { reason = null, actor = 'admin' } = {}) {
      const agent = agents.get(id);
      if (!agent) return null;
      agent.status = 'flagged';
      agent.updatedAt = nowIso();
      recordAuditEvent({
        type: 'agent.flagged',
        severity: 'warn',
        actorAgentId: actor === 'admin' ? null : actor,
        resourceType: 'agent',
        resourceId: agent.id,
        payload: { reason }
      });
      persist();
      return agent;
    },

    listAgents() {
      return [...agents.values()];
    },

    recordRequestLog(input) {
      const log = {
        id: input.id ?? `reqlog_${randomUUID()}`,
        requestId: input.requestId,
        method: input.method,
        path: input.path,
        route: input.route ?? input.path,
        status: input.status,
        latencyMs: input.latencyMs,
        actorAgentId: input.actorAgentId ?? null,
        sessionId: input.sessionId ?? null,
        errorCode: input.errorCode ?? null,
        ipHash: input.ipHash ?? null,
        userAgent: input.userAgent ?? null,
        createdAt: input.createdAt ?? nowIso()
      };
      requestLogs.set(log.id, log);
      persist();
      return log;
    },

    recordAuditEvent(input) {
      const event = recordAuditEvent(input);
      persist();
      return event;
    },

    listRequestLogs({ limit = 100, offset = 0, status } = {}) {
      return applyListQuery([...requestLogs.values()], { limit, offset, status });
    },

    listAuditEvents({ limit = 100, offset = 0, type, severity, resourceType, resourceId, actorAgentId } = {}) {
      return applyListQuery([...auditEvents.values()], {
        limit,
        offset,
        type,
        severity,
        resourceType,
        resourceId,
        actorAgentId
      });
    },

    listReputationEvents(agentId = null) {
      return [...reputationEvents.values()]
        .filter((event) => !agentId || event.agentId === agentId)
        .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
    },

    createRating(input) {
      const trade = trades.get(input.tradeId);
      if (!trade) return { error: { status: 404, body: { error: 'trade_not_found' } } };
      const existing = [...ratings.values()].find((rating) => (
        rating.tradeId === input.tradeId &&
        rating.raterAgentId === input.raterAgentId &&
        rating.targetAgentId === input.targetAgentId
      ));
      if (existing) {
        return { error: { status: 409, body: { error: 'rating_already_submitted', rating: existing } } };
      }
      const targetRole = trade.buyerAgentId === input.targetAgentId ? 'buyer' : 'seller';
      const raterRole = trade.buyerAgentId === input.raterAgentId ? 'buyer' : 'seller';
      const rating = {
        id: input.id ?? `rat_${randomUUID()}`,
        tradeId: input.tradeId,
        raterAgentId: input.raterAgentId,
        targetAgentId: input.targetAgentId,
        raterRole,
        targetRole,
        score: Number(input.score),
        comment: input.comment ?? null,
        tags: input.tags ?? [],
        metadata: input.metadata ?? {},
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      ratings.set(rating.id, rating);
      recordAuditEvent({
        type: 'rating.submitted',
        severity: rating.score <= 2 ? 'warn' : 'info',
        actorAgentId: rating.raterAgentId,
        resourceType: 'rating',
        resourceId: rating.id,
        payload: {
          tradeId: rating.tradeId,
          targetAgentId: rating.targetAgentId,
          targetRole: rating.targetRole,
          score: rating.score,
          tags: rating.tags
        }
      });
      persist();
      return { rating, summary: ratingSummaryForAgent(rating.targetAgentId) };
    },

    listRatings({ agentId, tradeId, includeComments = false, limit = 100, offset = 0 } = {}) {
      const scoped = [...ratings.values()]
        .filter((rating) => !agentId || rating.targetAgentId === agentId || rating.raterAgentId === agentId)
        .filter((rating) => !tradeId || rating.tradeId === tradeId)
        .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
        .slice(offset, offset + limit)
        .map((rating) => visibleRating(rating, { includeComment: includeComments }));
      return scoped;
    },

    getRatingSummary(agentId) {
      return ratingSummaryForAgent(agentId);
    },

    openDispute(input) {
      const trade = trades.get(input.tradeId);
      if (!trade) return { error: { status: 404, body: { error: 'trade_not_found' } } };
      const existing = findOpenDisputeForTrade(input.tradeId);
      if (existing) return { dispute: existing, duplicate: true };
      const now = nowIso();
      const dispute = {
        id: input.id ?? `dsp_${randomUUID()}`,
        tradeId: input.tradeId,
        listingId: trade.listingId,
        buyerAgentId: trade.buyerAgentId,
        sellerAgentId: trade.sellerAgentId,
        openedByAgentId: input.openedByAgentId,
        status: 'open',
        priority: input.priority ?? 'normal',
        reason: input.reason ?? 'other',
        description: input.description ?? null,
        requestedResolution: input.requestedResolution ?? 'other',
        assignedAdmin: null,
        evidence: [],
        escalationCount: 0,
        escalatedAt: null,
        resolvedAt: null,
        resolution: null,
        metadata: input.metadata ?? {},
        createdAt: now,
        updatedAt: now
      };
      disputes.set(dispute.id, dispute);
      recordAuditEvent({
        type: 'dispute.opened',
        severity: dispute.priority === 'urgent' ? 'critical' : 'warn',
        actorAgentId: input.openedByAgentId,
        resourceType: 'dispute',
        resourceId: dispute.id,
        payload: {
          tradeId: dispute.tradeId,
          reason: dispute.reason,
          requestedResolution: dispute.requestedResolution,
          priority: dispute.priority
        }
      });
      persist();
      return { dispute, duplicate: false };
    },

    getDispute(id) {
      return disputes.get(id) ?? null;
    },

    getDisputeByTradeId(tradeId) {
      return [...disputes.values()]
        .filter((dispute) => dispute.tradeId === tradeId)
        .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0] ?? null;
    },

    listDisputes(filters = {}) {
      return applyListQuery([...disputes.values()], filters);
    },

    addDisputeEvidence(disputeId, { actorAgentId, items, maxItems = 50 }) {
      const dispute = disputes.get(disputeId);
      if (!dispute) return null;
      if (dispute.evidence.length + items.length > maxItems) {
        return {
          error: {
            status: 409,
            body: {
              error: 'dispute_evidence_limit_reached',
              limit: maxItems
            }
          }
        };
      }
      const now = nowIso();
      const evidence = items.map((item) => ({
        id: `evd_${randomUUID()}`,
        actorAgentId,
        type: item.type,
        text: item.text || null,
        url: item.url ?? null,
        metadata: item.metadata ?? {},
        createdAt: now
      }));
      dispute.evidence.push(...evidence);
      if (dispute.status === 'open') dispute.status = 'evidence';
      dispute.updatedAt = now;
      recordAuditEvent({
        type: 'dispute.evidence_added',
        severity: 'info',
        actorAgentId,
        resourceType: 'dispute',
        resourceId: dispute.id,
        payload: {
          tradeId: dispute.tradeId,
          evidenceCount: evidence.length,
          status: dispute.status
        }
      });
      persist();
      return { dispute, evidence };
    },

    escalateDispute(disputeId, { actorAgentId = null, reason = null, priority = 'high' } = {}) {
      const dispute = disputes.get(disputeId);
      if (!dispute) return null;
      dispute.status = 'escalated';
      dispute.priority = priority;
      dispute.escalationCount += 1;
      dispute.escalatedAt = dispute.escalatedAt ?? nowIso();
      dispute.updatedAt = nowIso();
      recordAuditEvent({
        type: 'dispute.escalated',
        severity: priority === 'urgent' ? 'critical' : 'warn',
        actorAgentId,
        resourceType: 'dispute',
        resourceId: dispute.id,
        payload: {
          tradeId: dispute.tradeId,
          reason,
          priority,
          escalationCount: dispute.escalationCount
        }
      });
      persist();
      return dispute;
    },

    assignDispute(disputeId, { assignedAdmin = 'admin', actor = 'admin' } = {}) {
      const dispute = disputes.get(disputeId);
      if (!dispute) return null;
      dispute.assignedAdmin = assignedAdmin;
      dispute.updatedAt = nowIso();
      recordAuditEvent({
        type: 'dispute.assigned',
        severity: 'info',
        actorAgentId: actor === 'admin' ? null : actor,
        resourceType: 'dispute',
        resourceId: dispute.id,
        payload: {
          assignedAdmin,
          tradeId: dispute.tradeId
        }
      });
      persist();
      return dispute;
    },

    resolveDisputeByTradeId(tradeId, { resolution, actor = 'admin', notes = null } = {}) {
      const dispute = this.getDisputeByTradeId(tradeId);
      if (!dispute) return null;
      dispute.status = 'resolved';
      dispute.resolution = {
        outcome: resolution,
        notes,
        actor,
        decidedAt: nowIso()
      };
      dispute.resolvedAt = dispute.resolution.decidedAt;
      dispute.updatedAt = dispute.resolution.decidedAt;
      recordAuditEvent({
        type: 'dispute.resolved',
        severity: 'info',
        actorAgentId: actor === 'admin' ? null : actor,
        resourceType: 'dispute',
        resourceId: dispute.id,
        payload: {
          tradeId,
          resolution,
          notes
        }
      });
      persist();
      return dispute;
    },

    cleanupExpired(now = new Date()) {
      const nowMs = now.getTime();
      let removedChallenges = 0;
      let removedSessions = 0;
      let removedSignedRequestNonces = 0;
      let removedIdempotencyRecords = 0;

      for (const [id, challenge] of challenges.entries()) {
        if (challenge.usedAt || Date.parse(challenge.expiresAt) <= nowMs) {
          challenges.delete(id);
          removedChallenges += 1;
        }
      }

      for (const [id, session] of sessions.entries()) {
        if (Date.parse(session.expiresAt) <= nowMs) {
          sessions.delete(id);
          removedSessions += 1;
        }
      }

      const idempotencyTtlMs = 24 * 60 * 60 * 1000;
      for (const [key, record] of signedRequestNonces.entries()) {
        if (Date.parse(record.expiresAt) <= nowMs) {
          signedRequestNonces.delete(key);
          removedSignedRequestNonces += 1;
        }
      }
      for (const [key, record] of idempotencyRecords.entries()) {
        if (Date.parse(record.createdAt) + idempotencyTtlMs <= nowMs) {
          idempotencyRecords.delete(key);
          removedIdempotencyRecords += 1;
        }
      }

      persist();
      return {
        removedChallenges,
        removedSessions,
        removedSignedRequestNonces,
        removedIdempotencyRecords
      };
    },

    recordSignedRequestNonce({ agentId, nonce, expiresAt }) {
      const key = `${agentId}:${nonce}`;
      if (signedRequestNonces.has(key)) {
        return { error: { status: 409, body: { error: 'signed_request_replay' } } };
      }
      const record = {
        id: `srn_${randomUUID()}`,
        agentId,
        nonce,
        expiresAt,
        createdAt: nowIso()
      };
      signedRequestNonces.set(key, record);
      persist();
      return { record };
    },

    createApiKey({ agentId, name, scopes = ['read'], expiresAt = null }) {
      if (!agents.has(agentId)) {
        return { error: { status: 404, body: { error: 'agent_not_found' } } };
      }
      if (!name || typeof name !== 'string') {
        return { error: { status: 400, body: { error: 'api_key_name_required' } } };
      }
      if (!Array.isArray(scopes) || scopes.length === 0 || scopes.some((scope) => typeof scope !== 'string')) {
        return { error: { status: 400, body: { error: 'invalid_api_key_scopes' } } };
      }
      if (expiresAt && Number.isNaN(Date.parse(expiresAt))) {
        return { error: { status: 400, body: { error: 'invalid_api_key_expiry' } } };
      }

      const now = nowIso();
      const token = `axk_${randomBytes(32).toString('base64url')}`;
      const apiKey = {
        id: `key_${randomUUID()}`,
        agentId,
        name,
        tokenHash: tokenDigest(token),
        scopes: [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))],
        status: 'active',
        expiresAt: expiresAt ?? null,
        lastUsedAt: null,
        createdAt: now,
        updatedAt: now
      };
      apiKeys.set(apiKey.id, apiKey);
      recordAuditEvent({
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
      persist();
      return {
        apiKey: redactApiKey(apiKey),
        token
      };
    },

    listApiKeys(agentId) {
      return [...apiKeys.values()]
        .filter((apiKey) => apiKey.agentId === agentId)
        .map(redactApiKey);
    },

    revokeApiKey({ agentId, keyId }) {
      const apiKey = apiKeys.get(keyId);
      if (!apiKey || apiKey.agentId !== agentId) return null;
      apiKey.status = 'revoked';
      apiKey.updatedAt = nowIso();
      recordAuditEvent({
        type: 'api_key.revoked',
        severity: 'warn',
        actorAgentId: agentId,
        resourceType: 'api_key',
        resourceId: apiKey.id,
        payload: { name: apiKey.name }
      });
      persist();
      return redactApiKey(apiKey);
    },

    getApiKeyByToken(token, now = new Date()) {
      if (!token || typeof token !== 'string') return null;
      const hash = tokenDigest(token);
      for (const apiKey of apiKeys.values()) {
        if (apiKey.tokenHash !== hash) continue;
        if (apiKey.status !== 'active') return null;
        if (apiKey.expiresAt && Date.parse(apiKey.expiresAt) <= now.getTime()) return null;
        apiKey.lastUsedAt = nowIso();
        apiKey.updatedAt = apiKey.updatedAt ?? apiKey.createdAt;
        persist();
        return redactApiKey(apiKey);
      }
      return null;
    },

    createChallenge(agentId) {
      const challenge = {
        id: `chg_${randomUUID()}`,
        agentId,
        nonce: randomBytes(16).toString('hex'),
        canonical: '',
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        usedAt: null,
        createdAt: nowIso()
      };
      challenge.canonical = [
        'agent-exchange.verify',
        `agent_id:${challenge.agentId}`,
        `challenge_id:${challenge.id}`,
        `nonce:${challenge.nonce}`,
        `expires_at:${challenge.expiresAt}`
      ].join('\n');

      challenges.set(challenge.id, challenge);
      persist();
      return challenge;
    },

    getChallenge(id) {
      return challenges.get(id) ?? null;
    },

    markChallengeUsed(id) {
      const challenge = challenges.get(id);
      if (!challenge) return null;

      challenge.usedAt = nowIso();
      persist();
      return challenge;
    },

    createSession(agentId) {
      const now = nowIso();
      const token = randomBytes(32).toString('base64url');
      const storedSession = {
        id: `ses_${randomUUID()}`,
        tokenHash: tokenDigest(token),
        agentId,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        createdAt: now
      };

      sessions.set(storedSession.id, storedSession);
      persist();
      return {
        id: storedSession.id,
        token,
        agentId: storedSession.agentId,
        expiresAt: storedSession.expiresAt,
        createdAt: storedSession.createdAt
      };
    },

    getSessionByToken(token, now = new Date()) {
      if (!token || typeof token !== 'string') return null;

      const hash = tokenDigest(token);
      for (const session of sessions.values()) {
        const tokenMatches = session.tokenHash === hash || session.token === token;
        if (!tokenMatches) continue;
        if (Date.parse(session.expiresAt) <= now.getTime()) return null;

        return {
          id: session.id,
          agentId: session.agentId,
          expiresAt: session.expiresAt,
          createdAt: session.createdAt
        };
      }
      return null;
    },

    listListings(filters = {}) {
      return applyListQuery(
        [...listings.values()].filter((listing) => listing.status !== 'blocked'),
        filters
      );
    },

    getListing(id) {
      return listings.get(id) ?? null;
    },

    pauseListing(id, { reason = null, actor = 'admin' } = {}) {
      const listing = listings.get(id);
      if (!listing) return null;
      listing.status = 'paused';
      listing.updatedAt = nowIso();
      recordAuditEvent({
        type: 'listing.paused',
        severity: 'warn',
        actorAgentId: actor === 'admin' ? null : actor,
        resourceType: 'listing',
        resourceId: listing.id,
        payload: {
          sellerAgentId: listing.sellerAgentId,
          reason
        }
      });
      persist();
      return listing;
    },

    createListing(input, screening) {
      const now = nowIso();
      const inventory = normalizeListingInventory(input);
      const listing = {
        id: `lst_${randomUUID()}`,
        sellerAgentId: input.sellerAgentId,
        title: input.title,
        description: input.description ?? '',
        category: input.category,
        assuranceTier: input.assuranceTier,
        priceUsdc: input.priceUsdc,
        ...inventory,
        metadata: input.metadata ?? {},
        status: 'active',
        screening,
        createdAt: now,
        updatedAt: now
      };

      listings.set(listing.id, listing);
      inventoryLots.set(`lot_${listing.id}`, {
        id: `lot_${listing.id}`,
        listingId: listing.id,
        totalQuantity: listing.totalQuantity,
        availableQuantity: listing.availableQuantity,
        unit: listing.unit,
        createdAt: now,
        updatedAt: now
      });
      recordAuditEvent({
        type: 'listing.created',
        severity: 'info',
        actorAgentId: input.sellerAgentId,
        resourceType: 'listing',
        resourceId: listing.id,
        payload: {
          category: listing.category,
          assuranceTier: listing.assuranceTier,
          inventoryType: listing.inventoryType
        }
      });
      persist();
      return listing;
    },

    recordBlockedListingAttempt(input, screening) {
      const event = {
        id: `mod_${randomUUID()}`,
        type: 'blocked_listing_attempt',
        reportable: screening.reportable,
        input: {
          sellerAgentId: input.sellerAgentId,
          category: input.category,
          assuranceTier: input.assuranceTier
        },
        matches: screening.matches,
        createdAt: nowIso()
      };

      moderationEvents.push(event);
      recordAuditEvent({
        type: 'policy.blocked_listing',
        severity: screening.reportable ? 'critical' : 'warn',
        actorAgentId: input.sellerAgentId ?? null,
        resourceType: 'moderation_event',
        resourceId: event.id,
        payload: {
          reportable: screening.reportable,
          matches: screening.matches.map((match) => match.id),
          category: input.category,
          assuranceTier: input.assuranceTier
        }
      });
      persist();
      return event;
    },

    saveIdempotencyRecord(key, fingerprint, response) {
      const record = {
        key,
        fingerprint,
        response,
        createdAt: nowIso()
      };
      idempotencyRecords.set(key, record);
      persist();
      return record;
    },

    async withIdempotency({ scope, key, input }, fn) {
      if (!key) {
        return fn();
      }

      const recordKey = `${scope}:${key}`;
      const fingerprint = digest(input);
      const existing = idempotencyRecords.get(recordKey);

      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          return {
            status: 409,
            body: {
              error: 'idempotency_key_reuse',
              message: 'This Idempotency-Key was already used with a different request body.'
            }
          };
        }
        return clone(existing.response);
      }

      const pending = idempotencyInFlight.get(recordKey);
      if (pending) {
        if (pending.fingerprint !== fingerprint) {
          return {
            status: 409,
            body: {
              error: 'idempotency_key_reuse',
              message: 'This Idempotency-Key is already in flight with a different request body.'
            }
          };
        }
        return clone(await pending.promise);
      }

      const promise = (async () => {
        const response = await fn();
        this.saveIdempotencyRecord(recordKey, fingerprint, clone(response));
        return response;
      })();
      idempotencyInFlight.set(recordKey, { fingerprint, promise });
      try {
        return await promise;
      } finally {
        idempotencyInFlight.delete(recordKey);
      }
    },

    createTrade(input, listing) {
      const reservationResult = reserveDirectTradeInventory({ listing, input });
      if (reservationResult.error) {
        return { error: reservationResult.error };
      }

      const now = nowIso();
      const quantity = Number(input.quantity ?? 1);
      const unitPriceUsdc = input.unitPriceUsdc ?? listing.unitPriceUsdc ?? listing.priceUsdc;
      const settlementType = currentSettlementType();
      const trade = {
        id: `trd_${randomUUID()}`,
        listingId: listing.id,
        offerId: null,
        reservationId: reservationResult.reservation.id,
        buyerAgentId: input.buyerAgentId,
        sellerAgentId: listing.sellerAgentId,
        assuranceTier: listing.assuranceTier,
        buyerAcknowledgedAssurance: Boolean(input.assuranceAcknowledgement),
        state: 'OFFER_MADE',
        settlementType,
        priceUsdc: input.priceUsdc ?? multiplyUnitPrice(unitPriceUsdc, quantity),
        quantity,
        unit: listing.unit ?? 'item',
        createdAt: now,
        updatedAt: now,
        events: [
          {
            type: 'OFFER_MADE',
            at: now,
            actor: input.buyerAgentId,
            reservationId: reservationResult.reservation.id,
            payload: { settlementType }
          }
        ]
      };

      trades.set(trade.id, trade);
      recordAuditEvent({
        type: 'trade.created',
        severity: 'info',
        actorAgentId: input.buyerAgentId,
        resourceType: 'trade',
        resourceId: trade.id,
        payload: {
          listingId: trade.listingId,
          buyerAgentId: trade.buyerAgentId,
          sellerAgentId: trade.sellerAgentId,
          state: trade.state,
          priceUsdc: trade.priceUsdc,
          quantity: trade.quantity
        }
      });
      persist();
      return { trade, reservation: reservationResult.reservation };
    },

    createOffer(input, listing) {
      const now = nowIso();
      const quantity = Number(input.quantity ?? 1);
      const unitPriceUsdc = input.unitPriceUsdc ?? input.priceUsdc ?? listing.unitPriceUsdc;
      const totalPriceUsdc = input.totalPriceUsdc ?? multiplyUnitPrice(unitPriceUsdc, quantity);
      const offer = {
        id: `off_${randomUUID()}`,
        listingId: listing.id,
        buyerAgentId: input.buyerAgentId,
        sellerAgentId: listing.sellerAgentId,
        parentOfferId: input.parentOfferId ?? null,
        rootOfferId: input.rootOfferId ?? null,
        createdByAgentId: input.actorAgentId ?? input.buyerAgentId,
        status: offerStatuses.open,
        unitPriceUsdc,
        totalPriceUsdc,
        quantity,
        terms: input.terms ?? {},
        assuranceAcknowledgement: Boolean(input.assuranceAcknowledgement),
        expiresAt: input.expiresAt,
        createdAt: now,
        updatedAt: now
      };
      offer.rootOfferId = offer.rootOfferId ?? offer.id;
      offers.set(offer.id, offer);
      addOfferEvent(offer.id, input.parentOfferId ? 'COUNTERED' : 'OFFER_RECEIVED', offer.createdByAgentId, {
        parentOfferId: input.parentOfferId ?? null
      });
      recordAuditEvent({
        type: input.parentOfferId ? 'offer.countered' : 'offer.created',
        severity: 'info',
        actorAgentId: offer.createdByAgentId,
        resourceType: 'offer',
        resourceId: offer.id,
        payload: {
          listingId: offer.listingId,
          buyerAgentId: offer.buyerAgentId,
          sellerAgentId: offer.sellerAgentId,
          quantity: offer.quantity,
          unitPriceUsdc: offer.unitPriceUsdc,
          totalPriceUsdc: offer.totalPriceUsdc,
          parentOfferId: offer.parentOfferId
        }
      });
      persist();
      return offer;
    },

    getOffer(id) {
      return offers.get(id) ?? null;
    },

    listOffers(filters = {}) {
      return applyListQuery([...offers.values()], filters);
    },

    listOfferEvents(offerId) {
      return [...offerEvents.values()].filter((event) => event.offerId === offerId);
    },

    counterOffer(parentOffer, input) {
      parentOffer.status = offerStatuses.countered;
      parentOffer.updatedAt = nowIso();
      addOfferEvent(parentOffer.id, 'COUNTERED_BY_NEW_OFFER', input.actorAgentId, {
        counterActorAgentId: input.actorAgentId
      });
      const listing = listings.get(parentOffer.listingId);
      const offer = this.createOffer({
        ...input,
        listingId: parentOffer.listingId,
        buyerAgentId: parentOffer.buyerAgentId,
        parentOfferId: parentOffer.id,
        rootOfferId: parentOffer.rootOfferId,
        assuranceAcknowledgement:
          input.assuranceAcknowledgement ?? parentOffer.assuranceAcknowledgement
      }, listing);
      persist();
      return offer;
    },

    acceptOffer(offerId, actorAgentId) {
      const offer = offers.get(offerId);
      if (!offer) return { status: 404, body: { error: 'offer_not_found' } };
      return acceptOfferInternal({ offer, actorAgentId });
    },

    rejectOffer(offerId, actorAgentId) {
      const offer = offers.get(offerId);
      if (!offer) return null;
      offer.status = offerStatuses.rejected;
      offer.updatedAt = nowIso();
      addOfferEvent(offer.id, 'REJECTED', actorAgentId);
      recordAuditEvent({
        type: 'offer.rejected',
        severity: 'info',
        actorAgentId,
        resourceType: 'offer',
        resourceId: offer.id,
        payload: { listingId: offer.listingId }
      });
      persist();
      return offer;
    },

    withdrawOffer(offerId, actorAgentId) {
      const offer = offers.get(offerId);
      if (!offer) return null;
      offer.status = offerStatuses.withdrawn;
      offer.updatedAt = nowIso();
      addOfferEvent(offer.id, 'WITHDRAWN', actorAgentId);
      recordAuditEvent({
        type: 'offer.withdrawn',
        severity: 'info',
        actorAgentId,
        resourceType: 'offer',
        resourceId: offer.id,
        payload: { listingId: offer.listingId }
      });
      persist();
      return offer;
    },

    expireOffer(offerId, actorAgentId = 'system') {
      const offer = offers.get(offerId);
      if (!offer) return null;
      offer.status = offerStatuses.expired;
      offer.updatedAt = nowIso();
      addOfferEvent(offer.id, 'EXPIRED', actorAgentId);
      recordAuditEvent({
        type: 'offer.expired',
        severity: 'info',
        actorAgentId: actorAgentId === 'system' ? null : actorAgentId,
        resourceType: 'offer',
        resourceId: offer.id,
        payload: { listingId: offer.listingId }
      });
      persist();
      return offer;
    },

    evaluateAutoAccept(offer) {
      const listing = listings.get(offer.listingId);
      const buyer = agents.get(offer.buyerAgentId);
      const rules = [...autoAcceptRules.values()].filter(
        (rule) => rule.listingId === offer.listingId && rule.enabled
      );
      const matches = [];

      for (const rule of rules) {
        const match = ruleMatchesOffer({ rule, offer, buyer });
        addOfferEvent(offer.id, 'AUTO_ACCEPT_RULE_EVALUATED', 'system', {
          ruleId: rule.id,
          matched: match.matched,
          reasons: match.reasons,
          dryRun: rule.dryRun
        });
        if (!match.matched) continue;
        matches.push(rule);
        if (rule.dryRun) continue;

        const acceptedToday = [...offers.values()]
          .filter((candidate) => candidate.autoAcceptRuleId === rule.id)
          .filter((candidate) => candidate.acceptedAt?.startsWith(nowIso().slice(0, 10)))
          .reduce((sum, candidate) => addUsdc(sum, candidate.totalPriceUsdc), '0.00');
        if (
          compareUsdc(addUsdc(acceptedToday, offer.totalPriceUsdc), rule.maxDailyAutoAcceptedUsdc) > 0
        ) {
          addOfferEvent(offer.id, 'AUTO_ACCEPT_DAILY_CAP_BLOCKED', 'system', {
            ruleId: rule.id,
            maxDailyAutoAcceptedUsdc: rule.maxDailyAutoAcceptedUsdc
          });
          continue;
        }

        const result = acceptOfferInternal({
          offer,
          actorAgentId: listing.sellerAgentId,
          autoAcceptRuleId: rule.id
        });
        return { matches, result };
      }
      persist();
      return { matches, result: null };
    },

    createAutoAcceptRule(listing, input) {
      const now = nowIso();
      const rule = {
        id: `aar_${randomUUID()}`,
        listingId: listing.id,
        sellerAgentId: listing.sellerAgentId,
        minUnitPriceUsdc: input.minUnitPriceUsdc,
        maxQuantityPerTrade: Number(input.maxQuantityPerTrade),
        maxDailyAutoAcceptedUsdc: input.maxDailyAutoAcceptedUsdc,
        minBuyerReputation: Number(input.minBuyerReputation ?? 0),
        requiredAssuranceAcknowledgement: Boolean(input.requiredAssuranceAcknowledgement),
        offerExpiresWithinSeconds: Number(input.offerExpiresWithinSeconds),
        dryRun: input.dryRun ?? true,
        enabled: input.enabled ?? true,
        createdAt: now,
        updatedAt: now
      };
      autoAcceptRules.set(rule.id, rule);
      persist();
      return rule;
    },

    listAutoAcceptRules(listingId) {
      return [...autoAcceptRules.values()].filter((rule) => rule.listingId === listingId);
    },

    getAutoAcceptRule(ruleId) {
      return autoAcceptRules.get(ruleId) ?? null;
    },

    disableAutoAcceptRule(ruleId, actorAgentId) {
      const rule = autoAcceptRules.get(ruleId);
      if (!rule) return null;
      rule.enabled = false;
      rule.updatedAt = nowIso();
      rule.disabledByAgentId = actorAgentId;
      recordAuditEvent({
        type: 'auto_accept_rule.disabled',
        severity: 'warn',
        actorAgentId,
        resourceType: 'auto_accept_rule',
        resourceId: rule.id,
        payload: { listingId: rule.listingId }
      });
      persist();
      return rule;
    },

    listInventoryReservations({ listingId } = {}) {
      return [...inventoryReservations.values()].filter(
        (reservation) => !listingId || reservation.listingId === listingId
      );
    },

    getMarket(listingId) {
      const listing = listings.get(listingId);
      return listing ? marketForListing(listing) : null;
    },

    listMarkets() {
      return [...listings.values()]
        .filter((listing) => listing.inventoryType === 'fungible')
        .map((listing) => marketForListing(listing));
    },

    getTrade(id) {
      const trade = trades.get(id) ?? null;
      return trade ? { ...trade, settlementType: settlementTypeFromTrade(trade) } : null;
    },

    listTrades(filters = {}) {
      return applyListQuery([...trades.values()].map((trade) => ({
        ...trade,
        settlementType: settlementTypeFromTrade(trade)
      })), filters);
    },

    transitionTrade(tradeId, transition) {
      const trade = trades.get(tradeId);
      if (!trade) return null;
      if (!transition.from.includes(trade.state)) {
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

      const before = trade.state;
      let paymentIntent = null;
      let escrowEvent = null;
      if (transition.escrowType) {
        const action = paymentActionForEscrowType(transition.escrowType);
        paymentIntent = createTransitionPaymentIntent({
          trade,
          transition,
          action,
          amountUsdc: transition.escrowAmountUsdc ?? trade.priceUsdc
        });
        if (paymentIntent.status !== paymentStatuses.succeeded) {
          persist();
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
        escrowEvent = {
            id: `esc_${randomUUID()}`,
            tradeId,
            type: transition.escrowType,
            amountUsdc: transition.escrowAmountUsdc ?? trade.priceUsdc,
            actor: transition.actor,
            adapter: transition.paymentProvider ?? 'sandbox',
            payload: {
              ...(transition.escrowPayload ?? {}),
              paymentIntentId: paymentIntent.id,
              providerPaymentId: paymentIntent.providerPaymentId
            },
            createdAt: nowIso()
          };
        paymentIntent.escrowEventId = escrowEvent.id;
        paymentIntent.updatedAt = nowIso();
      }
      if (escrowEvent) {
        escrowEvents.set(escrowEvent.id, escrowEvent);
        recordAuditEvent({
          type: 'escrow.event_created',
          severity: 'info',
          actorAgentId: transition.actor === 'admin' ? null : transition.actor,
          resourceType: 'trade',
          resourceId: tradeId,
          payload: {
            escrowEventId: escrowEvent.id,
            escrowType: escrowEvent.type,
            amountUsdc: escrowEvent.amountUsdc,
            adapter: escrowEvent.adapter,
            paymentIntentId: paymentIntent?.id ?? null
          }
        });
      }
      trade.state = transition.to;
      addTradeEvent(trade, {
        type: transition.eventType,
        actor: transition.actor,
        from: before,
        to: transition.to,
        payload: {
          ...(transition.payload ?? {}),
          escrowEventId: escrowEvent?.id ?? transition.payload?.escrowEventId ?? null,
          paymentIntentId: paymentIntent?.id ?? transition.payload?.paymentIntentId ?? null
        }
      });

      for (const impact of reputationImpacts({ transition, trade })) {
        const agent = agents.get(impact.agentId);
        if (!agent) continue;
        const previousScore = agent.reputationScore;
        const newScore = clampReputation(previousScore + impact.delta);
        agent.reputationScore = newScore;
        agent.updatedAt = nowIso();
        const event = {
          id: `rep_${randomUUID()}`,
          agentId: impact.agentId,
          tradeId: trade.id,
          role: impact.role,
          delta: impact.delta,
          reason: impact.reason,
          previousScore,
          newScore,
          metadata: {
            transition: transition.eventType,
            tradeState: transition.to
          },
          createdAt: nowIso()
        };
        reputationEvents.set(event.id, event);
        recordAuditEvent({
          type: 'reputation.changed',
          severity: impact.delta < 0 ? 'warn' : 'info',
          actorAgentId: impact.agentId,
          resourceType: 'agent',
          resourceId: impact.agentId,
          payload: {
            tradeId: trade.id,
            role: impact.role,
            delta: impact.delta,
            reason: impact.reason,
            previousScore,
            newScore
          }
        });
      }
      recordAuditEvent({
        type: 'trade.transitioned',
        severity: transition.to === 'DISPUTED' ? 'warn' : 'info',
        actorAgentId: transition.actor === 'admin' ? null : transition.actor,
        resourceType: 'trade',
        resourceId: trade.id,
        payload: {
          from: before,
          to: transition.to,
          eventType: transition.eventType
        }
      });
      persist();
      return { trade, escrowEvent, paymentIntent };
    },

    listEscrowEvents() {
      return [...escrowEvents.values()];
    },

    getPaymentIntent(id) {
      return paymentIntents.get(id) ?? null;
    },

    listPaymentIntents(filters = {}) {
      return applyListQuery([...paymentIntents.values()], filters);
    },

    listPaymentEvents(filters = {}) {
      return applyListQuery([...paymentEvents.values()], filters);
    },

    recordExternalPaymentSettlement(input) {
      return recordExternalPaymentSettlement(input);
    },

    recordPaymentWebhookEvent(input) {
      const existingEvent = paymentEvents.get(input.eventId);
      if (existingEvent) {
        return {
          duplicate: true,
          event: existingEvent,
          paymentIntent: paymentIntents.get(existingEvent.paymentIntentId) ?? null
        };
      }

      const paymentIntent = paymentIntents.get(input.paymentIntentId);
      if (!paymentIntent) {
        return { error: { status: 404, body: { error: 'payment_intent_not_found' } } };
      }
      if (!Object.values(paymentStatuses).includes(input.status)) {
        return { error: { status: 400, body: { error: 'invalid_payment_status' } } };
      }
      if (
        isTerminalPaymentStatus(paymentIntent.status) &&
        paymentIntent.status !== input.status
      ) {
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

      const now = nowIso();
      const event = {
        id: input.eventId,
        paymentIntentId: paymentIntent.id,
        provider: 'sandbox',
        type: input.type ?? 'sandbox.payment_status',
        status: input.status,
        payload: input.payload ?? {},
        createdAt: now
      };
      paymentEvents.set(event.id, event);
      paymentIntent.status = input.status;
      paymentIntent.updatedAt = now;
      paymentIntent.completedAt = isTerminalPaymentStatus(input.status) ? now : paymentIntent.completedAt;
      recordAuditEvent({
        type: 'payment.webhook_received',
        severity: input.status === paymentStatuses.succeeded ? 'info' : 'warn',
        resourceType: 'payment_intent',
        resourceId: paymentIntent.id,
        payload: {
          eventId: event.id,
          status: event.status,
          provider: event.provider,
          duplicate: false
        }
      });
      persist();
      return { duplicate: false, event, paymentIntent };
    },

    adminRepairPaymentIntent(input) {
      const paymentIntent = paymentIntents.get(input.paymentIntentId);
      if (!paymentIntent) {
        return { error: { status: 404, body: { error: 'payment_intent_not_found' } } };
      }
      if (!Object.values(paymentStatuses).includes(input.status)) {
        return { error: { status: 400, body: { error: 'invalid_payment_status' } } };
      }
      if (!input.reason || typeof input.reason !== 'string') {
        return { error: { status: 400, body: { error: 'repair_reason_required' } } };
      }
      if (
        isTerminalPaymentStatus(paymentIntent.status) &&
        paymentIntent.status !== input.status &&
        input.force !== true
      ) {
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

      const now = nowIso();
      const previousStatus = paymentIntent.status;
      const event = {
        id: input.eventId ?? `pevt_${randomUUID()}`,
        paymentIntentId: paymentIntent.id,
        provider: paymentIntent.provider,
        type: 'admin.payment_status_repaired',
        status: input.status,
        payload: {
          previousStatus,
          repairedBy: input.actor ?? 'admin',
          reason: input.reason,
          force: input.force === true,
          metadata: input.metadata ?? {}
        },
        createdAt: now
      };
      paymentEvents.set(event.id, event);
      paymentIntent.status = input.status;
      paymentIntent.updatedAt = now;
      paymentIntent.completedAt = isTerminalPaymentStatus(input.status) ? now : paymentIntent.completedAt;
      recordAuditEvent({
        type: 'payment.intent_repaired',
        severity: 'warn',
        resourceType: 'payment_intent',
        resourceId: paymentIntent.id,
        payload: {
          eventId: event.id,
          previousStatus,
          status: input.status,
          force: input.force === true,
          reason: input.reason
        }
      });
      persist();
      return { event, paymentIntent };
    },

    listModerationEvents() {
      return [...moderationEvents];
    }
  };
}
