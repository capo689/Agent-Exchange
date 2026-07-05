import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from './payments.js';

export function signOutboundWebhookPayload({ secret, payload, timestamp }) {
  const body = canonicalJson(payload);
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function verifyOutboundWebhookSignature({ secret, payload, timestamp, signature }) {
  if (!secret || !timestamp || !signature) return false;
  const normalized = String(signature).replace(/^sha256=/i, '');
  const expected = signOutboundWebhookPayload({ secret, payload, timestamp });
  const actualBuffer = Buffer.from(normalized, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export async function deliverOutboundWebhook({ url, secret, event, fetchFn = globalThis.fetch }) {
  if (!url || !secret || typeof fetchFn !== 'function') return { skipped: true };

  const timestamp = new Date().toISOString();
  const payload = {
    id: event.id,
    type: event.type,
    severity: event.severity,
    actorAgentId: event.actorAgentId ?? null,
    sessionId: event.sessionId ?? null,
    resourceType: event.resourceType ?? null,
    resourceId: event.resourceId ?? null,
    requestId: event.requestId ?? null,
    payload: event.payload ?? {},
    createdAt: event.createdAt
  };
  const body = canonicalJson(payload);
  const signature = signOutboundWebhookPayload({ secret, payload, timestamp });

  const response = await fetchFn(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'agent-exchange-webhook/0.1.0',
      'x-agent-exchange-event-id': event.id,
      'x-agent-exchange-timestamp': timestamp,
      'x-agent-exchange-signature': `sha256=${signature}`
    },
    body
  });

  return {
    skipped: false,
    ok: response.ok,
    status: response.status
  };
}
