import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';

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

function normalizeQueryForSignature(query = {}) {
  return Object.fromEntries(
    Object.entries(query ?? {})
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
  );
}

function bodyDigest(body = {}) {
  return createHash('sha256').update(canonicalJson(body ?? {})).digest('hex');
}

export function canonicalSignedRequest({ agentId, method, pathname, query = {}, body = {}, timestamp, nonce }) {
  return [
    'agent-exchange.request.v1',
    `agent_id:${agentId}`,
    `method:${String(method ?? '').toUpperCase()}`,
    `path:${pathname}`,
    `query:${canonicalJson(normalizeQueryForSignature(query))}`,
    `body_sha256:${bodyDigest(body)}`,
    `timestamp:${timestamp}`,
    `nonce:${nonce}`
  ].join('\n');
}

export function signRequestHeaders({
  agentId,
  privateKey,
  method,
  pathname,
  query = {},
  body = {},
  timestamp = new Date().toISOString(),
  nonce = randomUUID()
}) {
  const canonical = canonicalSignedRequest({ agentId, method, pathname, query, body, timestamp, nonce });
  return {
    'x-agent-id': agentId,
    'x-agent-timestamp': timestamp,
    'x-agent-nonce': nonce,
    'x-agent-signature': sign(null, Buffer.from(canonical), privateKey).toString('base64')
  };
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
  constructor({
    baseUrl = 'http://localhost:8787',
    sessionToken = null,
    apiKeyToken = null,
    agentId = null,
    privateKey = null
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.sessionToken = sessionToken;
    this.apiKeyToken = apiKeyToken;
    this.agentId = agentId;
    this.privateKey = privateKey;
  }

  withSession(sessionToken) {
    return new AgentExchangeClient({ baseUrl: this.baseUrl, sessionToken });
  }

  withApiKey(apiKeyToken) {
    return new AgentExchangeClient({ baseUrl: this.baseUrl, apiKeyToken });
  }

  withSignedRequests(agentId, privateKey) {
    return new AgentExchangeClient({ baseUrl: this.baseUrl, agentId, privateKey });
  }

  setSessionToken(sessionToken) {
    this.sessionToken = sessionToken;
    return this;
  }

  setApiKeyToken(apiKeyToken) {
    this.apiKeyToken = apiKeyToken;
    return this;
  }

  setSignedRequests(agentId, privateKey) {
    this.agentId = agentId;
    this.privateKey = privateKey;
    return this;
  }

  async request(method, path, body, headers = {}) {
    const url = new URL(`${this.baseUrl}${path}`);
    const authHeaders = this.sessionToken
      ? { authorization: `Bearer ${this.sessionToken}` }
      : this.apiKeyToken
        ? { authorization: `ApiKey ${this.apiKeyToken}` }
      : {};
    const signedHeaders = !this.sessionToken && !this.apiKeyToken && this.agentId && this.privateKey
      ? signRequestHeaders({
          agentId: this.agentId,
          privateKey: this.privateKey,
          method,
          pathname: url.pathname,
          query: Object.fromEntries(url.searchParams.entries()),
          body: body ?? {}
        })
      : {};
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...authHeaders,
        ...signedHeaders,
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

  getAgent(agentId) {
    return this.request('GET', `/v1/agents/${agentId}`);
  }

  getAgentReputation(agentId) {
    return this.request('GET', `/v1/agents/${agentId}/reputation`);
  }

  getAgentOnboarding(agentId) {
    return this.request('GET', `/v1/agents/${agentId}/onboarding`);
  }

  createApiKey(agentId, input) {
    return this.request('POST', `/v1/agents/${agentId}/api-keys`, input);
  }

  listApiKeys(agentId) {
    return this.request('GET', `/v1/agents/${agentId}/api-keys`);
  }

  revokeApiKey(agentId, keyId) {
    return this.request('POST', `/v1/agents/${agentId}/api-keys/${keyId}/revoke`, {});
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

  getListingQuality(listingId) {
    return this.request('GET', `/v1/listings/${listingId}/quality`);
  }

  search(filters = {}) {
    return this.request('GET', `/v1/search${queryString(filters)}`);
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

  getPaidMarketSnapshot(paymentIntentId) {
    return this.request('GET', `/v1/paid/market-snapshot${queryString({ paymentIntentId })}`);
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
