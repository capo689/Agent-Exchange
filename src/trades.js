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
  fund_onchain: {
    from: ['OFFER_MADE'],
    to: 'FUNDED',
    eventType: 'ONCHAIN_FUNDED',
    escrowType: 'SMART_CONTRACT_FUND',
    paymentProvider: 'smart_contract'
  },
  release_onchain: {
    from: ['DELIVERED'],
    to: 'CAPTURED',
    eventType: 'ONCHAIN_RELEASED',
    escrowType: 'SMART_CONTRACT_RELEASE',
    paymentProvider: 'smart_contract'
  },
  refund_onchain: {
    from: ['FUNDED', 'DELIVERED', 'DISPUTED'],
    to: 'REFUNDED',
    eventType: 'ONCHAIN_REFUNDED',
    escrowType: 'SMART_CONTRACT_REFUND',
    paymentProvider: 'smart_contract'
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
