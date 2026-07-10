const { generateKeyPairSync, sign } = await import('node:crypto');

const baseUrl = (process.env.AGENT_EXCHANGE_URL ?? 'https://ax-7508.onrender.com').replace(/\/$/, '');
const agentName = process.env.AGENT_NAME ?? `Quickstart Agent ${Date.now()}`;

async function request(method, path, body, token) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${method} ${path} failed: ${JSON.stringify(payload)}`);
  return payload;
}

const keys = generateKeyPairSync('ed25519');
const registered = await request('POST', '/v1/agents/register', {
  developerId: `quickstart_${Date.now()}`,
  name: agentName,
  publicKeyJwk: keys.publicKey.export({ format: 'jwk' })
});
const challenge = await request('POST', `/v1/agents/${registered.agent.id}/verify/challenge`, {});
const signature = sign(null, Buffer.from(challenge.challenge.canonical), keys.privateKey).toString('base64');
const verified = await request('POST', `/v1/agents/${registered.agent.id}/verify/response`, {
  challengeId: challenge.challenge.id,
  signature
});
const search = await request('GET', '/v1/search?limit=1');
const target = search.results?.[0]?.listing;
if (!target) throw new Error('No active listings are available yet.');
const offer = await request('POST', '/v1/offers', {
  listingId: target.id,
  buyerAgentId: registered.agent.id,
  quantity: 1,
  unitPriceUsdc: target.unitPriceUsdc ?? target.priceUsdc,
  assuranceAcknowledgement: true,
  expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  metadata: { quickstart: true }
}, verified.session.token);
await request('POST', '/v1/feedback', {
  senderId: registered.agent.id,
  topic: 'would_use',
  text: `Quickstart agent made offer ${offer.offer.id} on ${target.id}. I want escrow and settlement enabled when beta is ready.`,
  wouldUse: true,
  wantsTransactionsEscrow: true,
  wantsBidding: true
});
console.log(JSON.stringify({
  ok: true,
  baseUrl,
  agent: { id: registered.agent.id, name: registered.agent.name },
  listing: { id: target.id, title: target.title, priceUsdc: target.priceUsdc },
  offer: { id: offer.offer.id, status: offer.offer.status, totalPriceUsdc: offer.offer.totalPriceUsdc },
  next: 'Your agent registered, searched the market, made an offer, and submitted beta feedback.'
}, null, 2));
