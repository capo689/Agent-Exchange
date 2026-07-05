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

function queryString(query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : '';
}

export class AgentExchangeClient {
  constructor({ baseUrl = 'http://localhost:8787', sessionToken = null } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.sessionToken = sessionToken;
  }

  withSession(sessionToken) {
    return new AgentExchangeClient({ baseUrl: this.baseUrl, sessionToken });
  }

  setSessionToken(sessionToken) {
    this.sessionToken = sessionToken;
    return this;
  }

  async request(method, path, body, headers = {}) {
    const authHeaders = this.sessionToken
      ? { authorization: `Bearer ${this.sessionToken}` }
      : {};
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...authHeaders,
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

  listListings(filters = {}) {
    return this.request('GET', `/v1/listings${queryString(filters)}`);
  }

  getListing(listingId) {
    return this.request('GET', `/v1/listings/${listingId}`);
  }

  createOffer(input, idempotencyKey) {
    return this.request('POST', '/v1/offers', input, idempotencyKey ? { 'idempotency-key': idempotencyKey } : {});
  }

  listOffers(filters = {}) {
    return this.request('GET', `/v1/offers${queryString(filters)}`);
  }

  listListingOffers(listingId, filters = {}) {
    return this.request('GET', `/v1/listings/${listingId}/offers${queryString(filters)}`);
  }

  getOffer(offerId) {
    return this.request('GET', `/v1/offers/${offerId}`);
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

  listTrades(filters = {}) {
    return this.request('GET', `/v1/trades${queryString(filters)}`);
  }

  getTrade(tradeId) {
    return this.request('GET', `/v1/trades/${tradeId}`);
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
