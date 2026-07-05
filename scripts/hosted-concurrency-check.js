#!/usr/bin/env node
import { AgentExchangeClient, generateAgentKeypair, signChallenge } from '../sdk/agent-exchange-sdk.js';

const baseUrl = (process.env.AGENT_EXCHANGE_URL ?? 'https://ax-7508.onrender.com').replace(/\/$/, '');
const parallelBuyers = Number(process.env.CONCURRENCY_BUYERS ?? 8);
const quantityAvailable = Number(process.env.CONCURRENCY_QUANTITY ?? 5);
const registerDelayMs = Number(process.env.CONCURRENCY_REGISTER_DELAY_MS ?? 150);
const runId = `concurrency_${Date.now()}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function registerVerifiedAgent(client, name) {
  const { publicKeyJwk, privateKey } = generateAgentKeypair();
  const registered = await client.registerAgent({
    developerId: `drill_${runId}_${name}`,
    name: `Drill ${name} ${runId}`,
    publicKeyJwk
  });
  const challenge = await client.requestChallenge(registered.agent.id);
  const verified = await client.submitChallenge(registered.agent.id, {
    challengeId: challenge.challenge.id,
    signature: signChallenge(privateKey, challenge.challenge.canonical)
  });
  return {
    agent: registered.agent,
    client: client.withSession(verified.session.token)
  };
}

async function main() {
  const client = new AgentExchangeClient({ baseUrl });
  const seller = await registerVerifiedAgent(client, 'seller');
  const buyers = [];
  for (let index = 0; index < parallelBuyers; index += 1) {
    if (registerDelayMs > 0) await sleep(registerDelayMs);
    buyers.push(await registerVerifiedAgent(client, `buyer_${index}`));
  }

  const listing = await seller.client.createListing({
    sellerAgentId: seller.agent.id,
    title: `Concurrency Drill ${runId}`,
    description: 'Operational drill listing. Safe to ignore.',
    category: 'digital_good',
    assuranceTier: 0,
    priceUsdc: '0.000001',
    inventoryType: 'fungible',
    totalQuantity: quantityAvailable,
    unit: 'drill_credit',
    unitPriceUsdc: '0.000001',
    minFillQuantity: 1,
    maxFillQuantity: 1,
    acceptsOffers: true,
    metadata: { runId, drill: true }
  });

  const attempts = await Promise.allSettled(
    buyers.map((buyer, index) => buyer.client.createTrade({
      listingId: listing.listing.id,
      buyerAgentId: buyer.agent.id,
      quantity: 1,
      unitPriceUsdc: '0.000001',
      assuranceAcknowledgement: true,
      metadata: { runId, buyerIndex: index }
    }, `${runId}:trade:${index}`))
  );

  const successes = attempts.filter((attempt) => attempt.status === 'fulfilled');
  const failures = attempts.filter((attempt) => attempt.status === 'rejected');
  const finalListing = await client.getListing(listing.listing.id);

  const result = {
    ok: successes.length <= quantityAvailable && finalListing.listing.availableQuantity >= 0,
    baseUrl,
    runId,
    listingId: listing.listing.id,
    parallelBuyers,
    quantityAvailable,
    successfulTrades: successes.length,
    rejectedTrades: failures.length,
    finalAvailableQuantity: finalListing.listing.availableQuantity,
    failureErrors: failures.map((failure) => failure.reason?.payload?.error ?? failure.reason?.message)
  };

  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error.message,
    payload: error.payload ?? null
  }, null, 2));
  process.exitCode = 1;
});
