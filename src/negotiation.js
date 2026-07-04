import { compareUsdc } from './money.js';

export const offerStatuses = Object.freeze({
  open: 'OPEN',
  countered: 'COUNTERED',
  accepted: 'ACCEPTED',
  rejected: 'REJECTED',
  withdrawn: 'WITHDRAWN',
  expired: 'EXPIRED'
});

export function isOfferOpen(offer, now = new Date()) {
  return offer.status === offerStatuses.open && Date.parse(offer.expiresAt) > now.getTime();
}

export function actorCanCounter({ offer, actorAgentId }) {
  return (
    (actorAgentId === offer.buyerAgentId || actorAgentId === offer.sellerAgentId) &&
    actorAgentId !== offer.createdByAgentId
  );
}

export function actorCanAccept({ offer, actorAgentId }) {
  return actorCanCounter({ offer, actorAgentId });
}

export function actorCanReject({ offer, actorAgentId }) {
  return actorCanCounter({ offer, actorAgentId });
}

export function actorCanWithdraw({ offer, actorAgentId }) {
  return actorAgentId === offer.createdByAgentId;
}

export function ruleMatchesOffer({ rule, offer, buyer }) {
  const reasons = [];

  if (!rule.enabled) reasons.push('rule_disabled');
  if (compareUsdc(offer.unitPriceUsdc, rule.minUnitPriceUsdc) < 0) reasons.push('unit_price_below_min');
  if (offer.quantity > rule.maxQuantityPerTrade) reasons.push('quantity_above_max');
  if (rule.requiredAssuranceAcknowledgement && !offer.assuranceAcknowledgement) {
    reasons.push('assurance_acknowledgement_required');
  }
  if ((buyer?.reputationScore ?? 0) < rule.minBuyerReputation) {
    reasons.push('buyer_reputation_below_min');
  }

  const secondsUntilExpiry = Math.floor((Date.parse(offer.expiresAt) - Date.now()) / 1000);
  if (secondsUntilExpiry > rule.offerExpiresWithinSeconds) {
    reasons.push('offer_expiry_too_far');
  }

  return {
    matched: reasons.length === 0,
    reasons
  };
}
