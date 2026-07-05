import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { test } from 'node:test';
import {
  AgentExchangeClient,
  canonicalSignedRequest as sdkCanonicalSignedRequest,
  generateAgentKeypair,
  signRequestHeaders
} from '../sdk/agent-exchange-sdk.js';
import { canonicalSignedRequest as serverCanonicalSignedRequest } from '../src/server.js';

test('SDK signed request canonical form matches server verifier', () => {
  const { publicKeyJwk, privateKey } = generateAgentKeypair();
  const input = {
    agentId: 'agt_sdk',
    method: 'POST',
    pathname: '/v1/listings',
    query: { b: '2', a: '1' },
    body: { sellerAgentId: 'agt_sdk', title: 'SDK signed listing' },
    timestamp: '2026-07-05T12:00:00.000Z',
    nonce: 'nonce-sdk'
  };
  const headers = signRequestHeaders({ ...input, privateKey });
  const canonical = sdkCanonicalSignedRequest(input);

  assert.equal(canonical, serverCanonicalSignedRequest(input));
  assert.equal(headers['x-agent-id'], input.agentId);
  assert.equal(headers['x-agent-timestamp'], input.timestamp);
  assert.equal(headers['x-agent-nonce'], input.nonce);
  assert.equal(
    verify(
      null,
      Buffer.from(canonical),
      createPublicKey({ key: publicKeyJwk, format: 'jwk' }),
      Buffer.from(headers['x-agent-signature'], 'base64')
    ),
    true
  );
});

test('SDK client attaches bearer or signed auth headers', async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true })
    };
  };

  try {
    const { privateKey } = generateAgentKeypair();
    const signedClient = new AgentExchangeClient({
      baseUrl: 'https://example.test',
      agentId: 'agt_signed',
      privateKey
    });
    await signedClient.createListing({
      sellerAgentId: 'agt_signed',
      title: 'SDK listing',
      description: 'Signed request',
      category: 'digital_good',
      assuranceTier: 0,
      priceUsdc: '1.00'
    });

    const bearerClient = signedClient.withSession('session-token');
    await bearerClient.health();

    assert.equal(calls[0].url, 'https://example.test/v1/listings');
    assert.equal(calls[0].init.headers['x-agent-id'], 'agt_signed');
    assert.ok(calls[0].init.headers['x-agent-signature']);
    assert.equal(calls[1].init.headers.authorization, 'Bearer session-token');
    assert.equal(calls[1].init.headers['x-agent-id'], undefined);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
