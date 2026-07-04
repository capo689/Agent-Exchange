import { generateKeyPairSync, sign } from 'node:crypto';

export function generateAgentKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyJwk: publicKey.export({ format: 'jwk' }),
    privateKey
  };
}

export function signChallenge(privateKey, canonicalChallenge) {
  return sign(null, Buffer.from(canonicalChallenge), privateKey).toString('base64');
}

export class AgentExchangeClient {
  constructor({ baseUrl = 'http://localhost:8787' } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async request(method, path, body, headers = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...headers
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const payload = await response.json();

    if (!response.ok) {
      const error = new Error(payload.message ?? payload.error ?? 'Agent Exchange request failed');
      error.status = response.status;
      error.payload = payload;
      throw error;
    }

    return payload;
  }

  health() {
    return this.request('GET', '/v1/health');
  }

  registerAgent(input) {
    return this.request('POST', '/v1/agents/register', input);
  }

  requestChallenge(agentId) {
    return this.request('POST', `/v1/agents/${agentId}/verify/challenge`, {});
  }

  submitChallenge(agentId, body) {
    return this.request('POST', `/v1/agents/${agentId}/verify/response`, body);
  }

  createListing(input) {
    return this.request('POST', '/v1/listings', input);
  }

  createOffer(input, idempotencyKey) {
    return this.request('POST', '/v1/offers', input, idempotencyKey ? { 'idempotency-key': idempotencyKey } : {});
  }

  counterOffer(offerId, input, idempotencyKey) {
    return this.request(
      'POST',
      `/v1/offers/${offerId}/counter`,
      input,
      idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}
    );
  }

  acceptOffer(offerId, input, idempotencyKey) {
    return this.request(
      'POST',
      `/v1/offers/${offerId}/accept`,
      input,
      idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}
    );
  }

  rejectOffer(offerId, input) {
    return this.request('POST', `/v1/offers/${offerId}/reject`, input);
  }

  withdrawOffer(offerId, input) {
    return this.request('POST', `/v1/offers/${offerId}/withdraw`, input);
  }

  getMarket(listingId) {
    return this.request('GET', `/v1/listings/${listingId}/market`);
  }

  createAutoAcceptRule(listingId, input, idempotencyKey) {
    return this.request(
      'POST',
      `/v1/listings/${listingId}/auto-accept-rules`,
      input,
      idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}
    );
  }

  createTrade(input, idempotencyKey) {
    return this.request('POST', '/v1/trades', input, idempotencyKey ? { 'idempotency-key': idempotencyKey } : {});
  }

  tradeAction(tradeId, action, body, idempotencyKey) {
    return this.request(
      'POST',
      `/v1/trades/${tradeId}/${action}`,
      body,
      idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}
    );
  }
}
