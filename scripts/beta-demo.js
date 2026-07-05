#!/usr/bin/env node
import {
  AgentExchangeClient,
  generateAgentKeypair,
  signChallenge
} from '../sdk/agent-exchange-sdk.js';

const baseUrl = (process.env.AGENT_EXCHANGE_URL ?? 'http://localhost:8787').replace(/\/$/, '');
const runId = `beta_demo_${Date.now()}`;
const client = new AgentExchangeClient({ baseUrl });

function futureIso(seconds = 600) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

async function registerVerifiedAgent(name, reputationScore = 0) {
  const keys = generateAgentKeypair();
  const { agent } = await client.registerAgent({
    developerId: `${runId}_${name.toLowerCase().replaceAll(' ', '_')}`,
    name: `${name} ${runId}`,
    reputationScore,
    publicKeyJwk: keys.publicKeyJwk,
    walletAddress: '0x0000000000000000000000000000000000000000'
  });
  const { challenge } = await client.requestChallenge(agent.id);
  const { session } = await client.submitChallenge(agent.id, {
    challengeId: challenge.id,
    signature: signChallenge(keys.privateKey, challenge.canonical)
  });
  return {
    agent,
    keys,
    client: client.withSession(session.token),
    signedClient: client.withSignedRequests(agent.id, keys.privateKey)
  };
}

async function paidGateStatus() {
  try {
    await client.getPaidMarketSnapshot();
    return { status: 'unexpected_open' };
  } catch (error) {
    return {
      status: error.status,
      error: error.payload?.error ?? error.message
    };
  }
}

async function main() {
  const health = await client.health();
  const [seller, buyer] = await Promise.all([
    registerVerifiedAgent('Beta Seller Bot', 85),
    registerVerifiedAgent('Beta Buyer Bot', 90)
  ]);

  const sellerApiKey = await seller.client.createApiKey(seller.agent.id, {
    name: 'beta demo listing writer',
    scopes: ['listings:write']
  });
  const sellerApiClient = client.withApiKey(sellerApiKey.token);

  const apiKeyListing = await sellerApiClient.createListing({
    sellerAgentId: seller.agent.id,
    title: `Beta demo compute credits ${runId}`,
    description: 'Demo-only fungible compute credits. Tier 0 buyer-beware inventory.',
    category: 'digital_good',
    assuranceTier: 0,
    priceUsdc: '100.00',
    inventoryType: 'fungible',
    totalQuantity: 10000,
    unit: 'compute_credit',
    unitPriceUsdc: '0.010',
    minFillQuantity: 100,
    maxFillQuantity: 5000,
    acceptsOffers: true,
    metadata: {
      runId,
      demo: true,
      authMode: 'api_key'
    }
  });

  const signedListing = await seller.signedClient.createListing({
    sellerAgentId: seller.agent.id,
    title: `Beta demo auto-accept credits ${runId}`,
    description: 'Demo-only auto-accept listing created with signed request auth.',
    category: 'digital_good',
    assuranceTier: 0,
    priceUsdc: '50.00',
    inventoryType: 'fungible',
    totalQuantity: 5000,
    unit: 'api_call',
    unitPriceUsdc: '0.010',
    minFillQuantity: 100,
    maxFillQuantity: 2000,
    acceptsOffers: true,
    metadata: {
      runId,
      demo: true,
      authMode: 'signed_request'
    }
  });

  const offer = await buyer.client.createOffer({
    listingId: apiKeyListing.listing.id,
    buyerAgentId: buyer.agent.id,
    quantity: 2000,
    unitPriceUsdc: '0.008',
    assuranceAcknowledgement: true,
    expiresAt: futureIso()
  }, `${runId}:offer`);

  const counter = await seller.client.counterOffer(offer.offer.id, {
    actorAgentId: seller.agent.id,
    quantity: 1500,
    unitPriceUsdc: '0.009',
    assuranceAcknowledgement: true,
    expiresAt: futureIso()
  }, `${runId}:counter`);

  const acceptedCounter = await buyer.client.acceptOffer(counter.offer.id, {
    actorAgentId: buyer.agent.id
  }, `${runId}:accept-counter`);

  const funded = await seller.client.tradeAction(acceptedCounter.trade.id, 'accept', {
    actorAgentId: seller.agent.id
  }, `${runId}:fund`);

  await seller.client.tradeAction(acceptedCounter.trade.id, 'deliver', {
    actorAgentId: seller.agent.id,
    proof: {
      note: 'Demo delivery claim. Tier 0 means Agent Exchange does not verify delivery.'
    }
  }, `${runId}:deliver`);

  const completed = await buyer.client.tradeAction(acceptedCounter.trade.id, 'confirm', {
    actorAgentId: buyer.agent.id
  }, `${runId}:confirm`);

  const autoRule = await seller.client.createAutoAcceptRule(signedListing.listing.id, {
    actorAgentId: seller.agent.id,
    minUnitPriceUsdc: '0.009',
    maxQuantityPerTrade: 2000,
    maxDailyAutoAcceptedUsdc: '100.00',
    minBuyerReputation: 80,
    requiredAssuranceAcknowledgement: true,
    offerExpiresWithinSeconds: 600,
    dryRun: false,
    enabled: true
  }, `${runId}:auto-rule`);

  const autoOffer = await buyer.client.createOffer({
    listingId: signedListing.listing.id,
    buyerAgentId: buyer.agent.id,
    quantity: 1000,
    unitPriceUsdc: '0.010',
    assuranceAcknowledgement: true,
    expiresAt: futureIso()
  }, `${runId}:auto-offer`);
  const autoAcceptTrade = autoOffer.autoAccept?.result?.body?.trade ?? null;
  const autoAcceptOffer = autoOffer.autoAccept?.result?.body?.offer ?? autoOffer.offer;

  const [quality, market, search, sellerOnboarding, buyerReputation, paidGate] = await Promise.all([
    client.getListingQuality(apiKeyListing.listing.id),
    client.getMarket(apiKeyListing.listing.id),
    client.search({ q: 'Beta demo', limit: 5 }),
    seller.client.getAgentOnboarding(seller.agent.id),
    buyer.client.getAgentReputation(buyer.agent.id),
    paidGateStatus()
  ]);

  const summary = {
    ok: true,
    baseUrl,
    runId,
    runtime: health.runtime,
    agents: {
      seller: seller.agent.id,
      buyer: buyer.agent.id
    },
    authModes: {
      sellerApiKeyId: sellerApiKey.apiKey.id,
      apiKeyTokenReturnedOnce: Boolean(sellerApiKey.token),
      signedListingId: signedListing.listing.id
    },
    negotiation: {
      listingId: apiKeyListing.listing.id,
      originalOfferId: offer.offer.id,
      counterOfferId: counter.offer.id,
      tradeId: acceptedCounter.trade.id,
      fundedState: funded.trade.state,
      completedState: completed.trade.state,
      completedPaymentIntentId: completed.paymentIntent?.id ?? null
    },
    autoAccept: {
      listingId: signedListing.listing.id,
      ruleId: autoRule.autoAcceptRule.id,
      offerId: autoOffer.offer.id,
      responseOfferStatus: autoOffer.offer.status,
      acceptedOfferStatus: autoAcceptOffer?.status ?? null,
      tradeId: autoAcceptTrade?.id ?? null,
      tradeState: autoAcceptTrade?.state ?? null
    },
    discovery: {
      listingQualityScore: quality.quality.score,
      bestAsk: market.market.bestAsk,
      bestBid: market.market.bestBid,
      searchResults: search.results.length,
      sellerOnboardingReady: sellerOnboarding.onboarding.ready,
      buyerReputationScore: buyerReputation.agent.reputationScore
    },
    paidGate
  };

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    baseUrl,
    runId,
    error: error.message,
    status: error.status ?? null,
    payload: error.payload ?? null
  }, null, 2));
  process.exitCode = 1;
});
