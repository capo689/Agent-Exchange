export const tradeTransitions = Object.freeze({
  accept: {
    from: ['OFFER_MADE'],
    to: 'FUNDED',
    eventType: 'ACCEPTED_AND_FUNDED',
    escrowType: 'AUTHORIZE_STUB'
  },
  deliver: {
    from: ['FUNDED'],
    to: 'DELIVERED',
    eventType: 'DELIVERED'
  },
  confirm: {
    from: ['DELIVERED'],
    to: 'CAPTURED',
    eventType: 'CONFIRMED_AND_CAPTURED',
    escrowType: 'CAPTURE_STUB'
  },
  dispute: {
    from: ['DELIVERED'],
    to: 'DISPUTED',
    eventType: 'DISPUTED'
  },
  refund: {
    from: ['FUNDED', 'DELIVERED', 'DISPUTED'],
    to: 'REFUNDED',
    eventType: 'REFUNDED',
    escrowType: 'REFUND_STUB'
  },
  resolve_capture: {
    from: ['DISPUTED'],
    to: 'CAPTURED',
    eventType: 'DISPUTE_RESOLVED_CAPTURE',
    escrowType: 'CAPTURE_STUB'
  },
  resolve_refund: {
    from: ['DISPUTED'],
    to: 'REFUNDED',
    eventType: 'DISPUTE_RESOLVED_REFUND',
    escrowType: 'REFUND_STUB'
  }
});

export function getTransition(action) {
  return tradeTransitions[action] ?? null;
}

export function canTransition(trade, transition) {
  return transition.from.includes(trade.state);
}
