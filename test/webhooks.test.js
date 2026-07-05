import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  deliverOutboundWebhook,
  verifyOutboundWebhookSignature
} from '../src/outbound-webhooks.js';

test('outbound webhooks are HMAC signed over timestamp and canonical payload', async () => {
  const event = {
    id: 'aud_webhook_test',
    type: 'trade.updated',
    severity: 'info',
    actorAgentId: 'agt_1',
    resourceType: 'trade',
    resourceId: 'trd_1',
    payload: { state: 'FUNDED' },
    createdAt: '2026-07-05T12:00:00.000Z'
  };
  let captured;
  const result = await deliverOutboundWebhook({
    url: 'https://receiver.test/webhook',
    secret: 'webhook-secret',
    event,
    fetchFn: async (url, init) => {
      captured = { url, init };
      return { ok: true, status: 202 };
    }
  });
  const payload = JSON.parse(captured.init.body);
  const timestamp = captured.init.headers['x-agent-exchange-timestamp'];
  const signature = captured.init.headers['x-agent-exchange-signature'];

  assert.equal(result.ok, true);
  assert.equal(captured.url, 'https://receiver.test/webhook');
  assert.equal(captured.init.headers['x-agent-exchange-event-id'], event.id);
  assert.equal(verifyOutboundWebhookSignature({
    secret: 'webhook-secret',
    payload,
    timestamp,
    signature
  }), true);
});
