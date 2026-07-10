#!/usr/bin/env node
import { AgentExchangeClient, generateAgentKeypair, signChallenge } from '../sdk/agent-exchange-sdk.js';

const baseUrl = (process.env.AGENT_EXCHANGE_URL ?? 'https://ax-7508.onrender.com').replace(/\/$/, '');
const sellerWallet = process.env.SELLER_WALLET;
const dryRun = process.argv.includes('--dry-run');

const products = [
  {
    title: 'Agent Exchange Launch Signal',
    description:
      'Launch-day digital graphic for agents that want to mark the first live Agent Exchange beta. Buyer sends 1 USDC externally to the seller wallet, then seller manually delivers the image file.',
    priceUsdc: '1.00',
    imageUrl: '/assets/launch/launch-signal.svg',
    edition: 'AX-LAUNCH-001'
  },
  {
    title: 'Genesis Buyer Badge',
    description:
      'A small commemorative buyer badge for early agents. Free-beta external settlement only: buyer sends 1 USDC to the seller wallet, then seller manually delivers the graphic.',
    priceUsdc: '1.00',
    imageUrl: '/assets/launch/genesis-badge.svg',
    edition: 'AX-LAUNCH-002'
  },
  {
    title: 'First Market Grid',
    description:
      'A launch graphic showing the first bid and ask paths of the exchange. Manual delivery after external 1 USDC payment to the listed seller wallet.',
    priceUsdc: '1.00',
    imageUrl: '/assets/launch/market-grid.svg',
    edition: 'AX-LAUNCH-003'
  },
  {
    title: 'Agent Confetti Receipt',
    description:
      'A deliberately light, celebratory receipt graphic for first-wave agents. Buyer agrees to external USDC settlement and seller-provided delivery.',
    priceUsdc: '1.00',
    imageUrl: '/assets/launch/agent-confetti.svg',
    edition: 'AX-LAUNCH-004'
  }
];

function requireSellerWallet() {
  if (!sellerWallet || !/^0x[a-fA-F0-9]{40}$/.test(sellerWallet)) {
    throw new Error('Set SELLER_WALLET to the public 0x receive wallet for external USDC settlement.');
  }
}

async function registerVerifiedSeller(client) {
  const { publicKeyJwk, privateKey } = generateAgentKeypair();
  const registered = await client.registerAgent({
    developerId: `launch_products_${Date.now()}`,
    name: 'Agent Exchange Launch Seller',
    walletAddress: sellerWallet,
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

async function existingTitles(client) {
  const titles = new Set();
  for (const product of products) {
    const result = await client.request('GET', `/v1/search?q=${encodeURIComponent(product.title)}&limit=20`);
    for (const item of result.results ?? []) {
      if (item.listing?.title === product.title) titles.add(product.title);
    }
  }
  return titles;
}

async function main() {
  requireSellerWallet();
  const client = new AgentExchangeClient({ baseUrl });
  const titles = await existingTitles(client);
  const missing = products.filter((product) => !titles.has(product.title));

  if (dryRun) {
    console.log(JSON.stringify({
      ok: true,
      dryRun,
      baseUrl,
      sellerWallet,
      existing: [...titles],
      wouldCreate: missing.map((product) => product.title)
    }, null, 2));
    return;
  }

  const seller = missing.length ? await registerVerifiedSeller(client) : null;
  const created = [];
  for (const product of missing) {
    const response = await seller.client.createListing({
      sellerAgentId: seller.agent.id,
      title: product.title,
      description: product.description,
      category: 'digital_good',
      assuranceTier: 0,
      priceUsdc: product.priceUsdc,
      inventoryType: 'unique',
      totalQuantity: 1,
      unit: 'graphic',
      acceptsOffers: true,
      metadata: {
        launchProduct: true,
        edition: product.edition,
        imageUrl: product.imageUrl,
        delivery: 'manual_seller_provided',
        settlement: 'external_usdc',
        sellerWallet,
        buyerInstructions: `Send ${product.priceUsdc} USDC externally to ${sellerWallet}; seller manually delivers the graphic after confirming payment.`
      }
    });
    created.push(response.listing);
  }

  console.log(JSON.stringify({
    ok: true,
    baseUrl,
    sellerAgentId: seller?.agent.id ?? null,
    existing: [...titles],
    created: created.map((listing) => ({
      id: listing.id,
      title: listing.title,
      priceUsdc: listing.priceUsdc,
      imageUrl: listing.metadata?.imageUrl
    }))
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error.message,
    payload: error.payload ?? null
  }, null, 2));
  process.exitCode = 1;
});
