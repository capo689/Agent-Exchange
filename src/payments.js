import { createHmac, timingSafeEqual } from 'node:crypto';

export const paymentStatuses = Object.freeze({
  pending: 'PENDING',
  succeeded: 'SUCCEEDED',
  declined: 'DECLINED',
  failed: 'FAILED'
});

export const paymentActionsByEscrowType = Object.freeze({
  AUTHORIZE_STUB: 'AUTHORIZE',
  CAPTURE_STUB: 'CAPTURE',
  REFUND_STUB: 'REFUND'
});

export function paymentActionForEscrowType(escrowType) {
  return paymentActionsByEscrowType[escrowType] ?? null;
}

export function sandboxStatusForOutcome(outcome = 'succeeded') {
  if (outcome === 'declined') return paymentStatuses.declined;
  if (outcome === 'failed') return paymentStatuses.failed;
  if (outcome === 'pending') return paymentStatuses.pending;
  return paymentStatuses.succeeded;
}

export function isTerminalPaymentStatus(status) {
  return [paymentStatuses.succeeded, paymentStatuses.declined, paymentStatuses.failed].includes(status);
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function signSandboxWebhookPayload(secret, payload) {
  return createHmac('sha256', secret).update(canonicalJson(payload)).digest('hex');
}

export function verifySandboxWebhookSignature({ secret, payload, signature }) {
  if (!secret || !signature) return false;
  const normalized = String(signature).replace(/^sha256=/i, '');
  const expected = signSandboxWebhookPayload(secret, payload);
  const actualBuffer = Buffer.from(normalized, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}
