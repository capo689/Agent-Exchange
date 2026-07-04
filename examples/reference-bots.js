import {
  AgentExchangeClient,
  generateAgentKeypair,
  signChallenge
} from '../sdk/agent-exchange-sdk.js';

const client = new AgentExchangeClient({
  baseUrl: process.env.AGENT_EXCHANGE_URL ?? 'http://localhost:8787'
});

const runId = `reference-${Date.now()}`;

async function registerVerifiedAgent({ developerId, name }) {
  const keys = generateAgentKeypair();
  const { agent } = await client.registerAgent({
    developerId,
    name,
    publicKeyJwk: keys.publicKeyJwk
  });

  const { challenge } = await client.requestChallenge(agent.id);
  const signature = signChallenge(keys.privateKey, challenge.canonical);
  const { session } = await client.submitChallenge(agent.id, {
    challengeId: challenge.id,
    signature
  });

  return { agent, session, keys };
}

const seller = await registerVerifiedAgent({
  developerId: 'dev_reference_seller',
  name: 'Reference Seller Bot'
});

const buyer = await registerVerifiedAgent({
  developerId: 'dev_reference_buyer',
  name: 'Reference Buyer Bot'
});

const { listing } = await client.createListing({
  sellerAgentId: seller.agent.id,
  title: 'Tier 0 sample API credit inventory',
  description: 'A buyer-beware fungible listing for the reference flow.',
  category: 'digital_good',
  assuranceTier: 0,
  priceUsdc: '100.00',
  inventoryType: 'fungible',
  totalQuantity: 10000,
  unit: 'api_call',
  unitPriceUsdc: '0.010',
  minFillQuantity: 100,
  maxFillQuantity: 5000,
  acceptsOffers: true,
  metadata: {
    delivery: 'seller-provided'
  }
});

const { offer } = await client.createOffer(
  {
    listingId: listing.id,
    buyerAgentId: buyer.agent.id,
    quantity: 1000,
    unitPriceUsdc: '0.008',
    assuranceAcknowledgement: true,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString()
  },
  `${runId}-create-offer`
);

const { offer: counterOffer } = await client.counterOffer(
  offer.id,
  {
    actorAgentId: seller.agent.id,
    quantity: 1000,
    unitPriceUsdc: '0.009',
    assuranceAcknowledgement: true,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString()
  },
  `${runId}-counter`
);

const accepted = await client.acceptOffer(
  counterOffer.id,
  {
    actorAgentId: buyer.agent.id
  },
  `${runId}-accept-counter`
);

const { trade } = accepted;

await client.tradeAction(
  trade.id,
  'accept',
  {
    actorAgentId: seller.agent.id
  },
  `${runId}-fund-trade`
);

await client.tradeAction(
  trade.id,
  'deliver',
  {
    actorAgentId: seller.agent.id,
    proof: {
      note: 'Reference seller claims delivery. Tier 0 means platform does not verify it.'
    }
  },
  `${runId}-deliver`
);

const completed = await client.tradeAction(
  trade.id,
  'confirm',
  {
    actorAgentId: buyer.agent.id
  },
  `${runId}-confirm`
);

console.log(JSON.stringify(completed, null, 2));
