import { isTerminalPaymentStatus } from './payments.js';

function ageMinutes(value, now) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.round((now.getTime() - parsed) / 60000));
}

function addFinding(findings, { severity = 'warn', code, resourceType, resourceId, message, details = {} }) {
  findings.push({ severity, code, resourceType, resourceId, message, details });
}

export async function buildReconciliationReport(store, { now = new Date(), stuckAfterMinutes = 30 } = {}) {
  const [paymentIntents, paymentEvents, escrowEvents, trades] = await Promise.all([
    store.listPaymentIntents({ limit: 10000, offset: 0 }),
    store.listPaymentEvents({ limit: 10000, offset: 0 }),
    store.listEscrowEvents(),
    store.listTrades({ limit: 10000, offset: 0 })
  ]);

  const tradesById = new Map(trades.map((trade) => [trade.id, trade]));
  const escrowById = new Map(escrowEvents.map((event) => [event.id, event]));
  const paymentById = new Map(paymentIntents.map((intent) => [intent.id, intent]));
  const paymentEventsByIntent = paymentEvents.reduce((groups, event) => {
    const values = groups.get(event.paymentIntentId) ?? [];
    values.push(event);
    groups.set(event.paymentIntentId, values);
    return groups;
  }, new Map());
  const escrowByTrade = escrowEvents.reduce((groups, event) => {
    const values = groups.get(event.tradeId) ?? [];
    values.push(event);
    groups.set(event.tradeId, values);
    return groups;
  }, new Map());

  const findings = [];

  for (const intent of paymentIntents) {
    const minutesOld = ageMinutes(intent.createdAt, now);
    if (!isTerminalPaymentStatus(intent.status) && minutesOld !== null && minutesOld >= stuckAfterMinutes) {
      addFinding(findings, {
        severity: 'warn',
        code: 'payment_intent_stuck',
        resourceType: 'payment_intent',
        resourceId: intent.id,
        message: `Payment intent is ${intent.status} after ${minutesOld} minutes.`,
        details: { status: intent.status, provider: intent.provider, minutesOld }
      });
    }

    if (intent.provider !== 'sandbox' && intent.providerPaymentId && !/^0x[a-fA-F0-9]{64}$/.test(intent.providerPaymentId)) {
      addFinding(findings, {
        severity: 'warn',
        code: 'real_payment_missing_tx_hash',
        resourceType: 'payment_intent',
        resourceId: intent.id,
        message: 'Real-rail payment intent does not have a canonical transaction hash.',
        details: { provider: intent.provider, providerPaymentId: intent.providerPaymentId }
      });
    }

    if (intent.tradeId && !tradesById.has(intent.tradeId)) {
      addFinding(findings, {
        severity: 'error',
        code: 'payment_trade_missing',
        resourceType: 'payment_intent',
        resourceId: intent.id,
        message: 'Payment intent references a missing trade.',
        details: { tradeId: intent.tradeId }
      });
    }

    if (intent.escrowEventId && !escrowById.has(intent.escrowEventId)) {
      addFinding(findings, {
        severity: 'error',
        code: 'payment_escrow_event_missing',
        resourceType: 'payment_intent',
        resourceId: intent.id,
        message: 'Payment intent references a missing escrow event.',
        details: { escrowEventId: intent.escrowEventId }
      });
    }

    if (intent.tradeId && intent.provider === 'smart_contract' && !intent.escrowEventId) {
      addFinding(findings, {
        severity: 'error',
        code: 'smart_contract_payment_unlinked',
        resourceType: 'payment_intent',
        resourceId: intent.id,
        message: 'Smart-contract payment intent is not linked to an escrow event.',
        details: { tradeId: intent.tradeId }
      });
    }

    if (intent.status === 'SUCCEEDED' && (paymentEventsByIntent.get(intent.id) ?? []).length === 0) {
      addFinding(findings, {
        severity: 'warn',
        code: 'succeeded_payment_without_event',
        resourceType: 'payment_intent',
        resourceId: intent.id,
        message: 'Succeeded payment intent has no payment event history.',
        details: { provider: intent.provider }
      });
    }
  }

  for (const event of escrowEvents) {
    if (!tradesById.has(event.tradeId)) {
      addFinding(findings, {
        severity: 'error',
        code: 'escrow_trade_missing',
        resourceType: 'escrow_event',
        resourceId: event.id,
        message: 'Escrow event references a missing trade.',
        details: { tradeId: event.tradeId }
      });
    }

    const paymentIntentId = event.payload?.paymentIntentId;
    if (paymentIntentId && !paymentById.has(paymentIntentId)) {
      addFinding(findings, {
        severity: 'error',
        code: 'escrow_payment_missing',
        resourceType: 'escrow_event',
        resourceId: event.id,
        message: 'Escrow event references a missing payment intent.',
        details: { paymentIntentId }
      });
    }
  }

  for (const trade of trades) {
    const events = escrowByTrade.get(trade.id) ?? [];
    if (['FUNDED', 'DELIVERED', 'CAPTURED', 'REFUNDED'].includes(trade.state) && events.length === 0) {
      addFinding(findings, {
        severity: 'warn',
        code: 'settled_trade_without_escrow_event',
        resourceType: 'trade',
        resourceId: trade.id,
        message: 'Trade is past offer state but has no escrow event.',
        details: { state: trade.state }
      });
    }
  }

  return {
    generatedAt: now.toISOString(),
    ok: findings.filter((finding) => finding.severity === 'error').length === 0,
    counts: {
      paymentIntents: paymentIntents.length,
      paymentEvents: paymentEvents.length,
      escrowEvents: escrowEvents.length,
      trades: trades.length,
      findings: findings.length,
      errors: findings.filter((finding) => finding.severity === 'error').length,
      warnings: findings.filter((finding) => finding.severity === 'warn').length
    },
    findings
  };
}
