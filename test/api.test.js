import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader
} from '@x402/core/http';
import { encodeAbiParameters, encodeEventTopics } from 'viem';
import { getConfig, getSafeRuntimeStatus } from '../src/config.js';
import { escrowContractAbi, escrowTradeIdHash } from '../src/escrow-contract.js';
import { runEscrowWatcher } from '../src/escrow-watcher.js';
import { signRequestHeaders } from '../sdk/agent-exchange-sdk.js';
import { createRateLimiter } from '../src/rate-limit.js';
import { createApp, handleApiRequest } from '../src/server.js';
import { createStore } from '../src/store.js';
import { signSandboxWebhookPayload, usdcToAtomicAmount } from '../src/payments.js';
import { getTransition } from '../src/trades.js';

process.env.ADMIN_TOKEN ??= 'test-admin-token';
process.env.MARKETPLACE_MODE ??= 'paid_test';
process.env.PAYMENTS_ENABLED ??= 'true';
process.env.ESCROW_ENABLED ??= 'true';

function createClient() {
  const store = createStore();
  const authHeadersByAgentId = new Map();

  function inferHeaders(body = {}, headers = {}) {
    if (headers.authorization || headers.Authorization || headers['x-admin-token']) return headers;

    const agentId = body.actorAgentId ?? body.sellerAgentId ?? body.buyerAgentId;
    const authHeaders = authHeadersByAgentId.get(agentId);
    return authHeaders ? { ...authHeaders, ...headers } : headers;
  }

  return {
    store,
    authHeadersByAgentId,
    get(pathname, query = {}) {
      return handleApiRequest({ method: 'GET', pathname, query }, store);
    },
    getWithHeaders(pathname, headers = {}, query = {}) {
      return handleApiRequest({ method: 'GET', pathname, query, headers }, store);
    },
    post(pathname, body, headers = {}) {
      return handleApiRequest({ method: 'POST', pathname, body, headers: inferHeaders(body, headers) }, store);
    },
    postWithoutAuth(pathname, body, headers = {}) {
      return handleApiRequest({ method: 'POST', pathname, body, headers }, store);
    },
    adminPost(pathname, body = {}, headers = {}) {
      const previous = process.env.ADMIN_TOKEN;
      process.env.ADMIN_TOKEN = 'test-admin-token';
      const result = handleApiRequest({
        method: 'POST',
        pathname,
        body,
        headers: { 'x-admin-token': 'test-admin-token', ...headers }
      }, store);
      if (previous === undefined) {
        delete process.env.ADMIN_TOKEN;
      } else {
        process.env.ADMIN_TOKEN = previous;
      }
      return result;
    },
    adminGet(pathname, query = {}) {
      const previous = process.env.ADMIN_TOKEN;
      process.env.ADMIN_TOKEN = 'test-admin-token';
      const result = handleApiRequest({
        method: 'GET',
        pathname,
        query,
        headers: { 'x-admin-token': 'test-admin-token' }
      }, store);
      if (previous === undefined) {
        delete process.env.ADMIN_TOKEN;
      } else {
        process.env.ADMIN_TOKEN = previous;
      }
      return result;
    }
  };
}

async function registerBasicAgent(client, name, overrides = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const response = await client.post('/v1/agents/register', {
    developerId: `dev_${name}`,
    name,
    reputationScore: name.includes('good') ? 90 : 0,
    publicKeyJwk: publicKey.export({ format: 'jwk' }),
    ...overrides
  });
  assert.equal(response.status, 201);

  const challenged = await client.post(`/v1/agents/${response.body.agent.id}/verify/challenge`, {});
  const signature = sign(null, Buffer.from(challenged.body.challenge.canonical), privateKey).toString('base64');
  const verified = await client.post(`/v1/agents/${response.body.agent.id}/verify/response`, {
    challengeId: challenged.body.challenge.id,
    signature
  });
  assert.equal(verified.status, 201);

  const agent = {
    ...response.body.agent,
    privateKey,
    sessionToken: verified.body.session.token,
    authHeaders: {
      authorization: `Bearer ${verified.body.session.token}`
    }
  };
  client.authHeadersByAgentId.set(agent.id, agent.authHeaders);
  return agent;
}

async function registerBuyerSeller(client) {
  const seller = await registerBasicAgent(client, 'seller');
  const buyer = await registerBasicAgent(client, 'buyer');
  return { seller, buyer };
}

function futureIso(seconds = 300) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

async function createFungibleListing(client, seller, overrides = {}) {
  const response = await client.post('/v1/listings', {
    sellerAgentId: seller.id,
    title: 'API credit inventory',
    description: 'Fungible API credits.',
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
    ...overrides
  });
  assert.equal(response.status, 201);
  return response.body.listing;
}

function escrowFundedLog({ contractAddress, tradeId, buyer, seller, amount, feeBps = 25 }) {
  return {
    address: contractAddress,
    topics: encodeEventTopics({
      abi: escrowContractAbi,
      eventName: 'EscrowFunded',
      args: {
        tradeIdHash: escrowTradeIdHash(tradeId),
        buyer,
        seller
      }
    }),
    data: encodeAbiParameters(
      [
        { type: 'string' },
        { type: 'uint256' },
        { type: 'uint16' }
      ],
      [tradeId, BigInt(amount), feeBps]
    ),
    logIndex: '0x0'
  };
}

function escrowReleasedLog({ contractAddress, tradeId, seller, sellerAmount, platformFee }) {
  return {
    address: contractAddress,
    topics: encodeEventTopics({
      abi: escrowContractAbi,
      eventName: 'EscrowReleased',
      args: {
        tradeIdHash: escrowTradeIdHash(tradeId),
        seller
      }
    }),
    data: encodeAbiParameters(
      [
        { type: 'uint256' },
        { type: 'uint256' }
      ],
      [BigInt(sellerAmount), BigInt(platformFee)]
    ),
    logIndex: '0x1'
  };
}

test('policy exposes assurance tiers and severe abuse response', async () => {
  const client = createClient();
  const response = await client.get('/v1/policy');

  assert.equal(response.status, 200);
  assert.equal(response.body.assuranceTiers.length, 4);
  assert.equal(response.body.assuranceTiers[0].buyerAcknowledgementRequired, true);
  assert.ok(
    response.body.prohibitedCategories.some((item) => item.toLowerCase().includes('human trafficking'))
  );
  assert.ok(response.body.severeAbuseResponse.some((item) => item.includes('law enforcement')));
});

test('config accepts Render Supabase env group names without exposing secrets in status', () => {
  const config = getConfig({
    PORT: '9999',
    MAX_JSON_BODY_BYTES: '2048',
    SUPABASE_URL: 'https://example-ref.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'publishable',
    SUPABASE_SECRET_KEY: 'secret',
    DATABASE_URL: 'postgresql://user:pass@example.supabase.com:6543/postgres'
  });
  const status = getSafeRuntimeStatus({
    SUPABASE_URL: 'https://example-ref.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'publishable',
    SUPABASE_SECRET_KEY: 'secret',
    DATABASE_URL: 'postgresql://user:pass@example.supabase.com:6543/postgres'
  });

  assert.equal(config.port, 9999);
  assert.equal(config.maxJsonBodyBytes, 2048);
  assert.equal(config.supabase.projectRef, 'example-ref');
  assert.equal(config.supabase.jwksUrl, 'https://example-ref.supabase.co/auth/v1/.well-known/jwks.json');
  assert.equal(config.storageBackend, 'postgres');
  assert.deepEqual(status, {
    storageBackend: 'postgres',
    databaseConfigured: true,
    databaseConnection: {
      host: 'example.supabase.com',
      port: '6543',
      user: 'user',
      database: 'postgres',
      parseable: true
    },
    adminConfigured: false,
    supabaseConfigured: true,
    supabaseJwksConfigured: true,
    outboundWebhookConfigured: false,
    payment: {
      provider: 'sandbox',
      enabled: false,
      escrowEnabled: false,
      sandboxWebhookConfigured: false,
      x402: {
        configured: false,
        payToConfigured: false,
        network: 'eip155:84532',
        asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        scheme: 'exact',
        facilitatorHost: 'x402.org',
        facilitatorRequiresAuth: false,
        facilitatorBearerConfigured: false,
        maxTimeoutSeconds: 60
      },
      escrowContract: {
        configured: false,
        addressConfigured: false,
        network: 'eip155:84532',
        asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        platformFeeBps: 0,
        rpcUrlConfigured: false
      }
    },
    marketplace: {
      mode: 'free_beta',
      freeBeta: true,
      paymentsEnabled: false,
      escrowEnabled: false,
      settlementType: 'external_or_free',
      launchNotice: 'Free beta: Agent Exchange records listings, offers, trades, and reputation, but does not process payments or custody funds.'
    },
    maxJsonBodyBytes: 1048576,
    rateLimit: {
      enabled: true,
      windowMs: 60000,
      readMaxRequests: 300,
      writeMaxRequests: 120,
      authMaxRequests: 30
    },
    requestQueue: {
      enabled: true,
      maxConcurrent: 50,
      maxQueued: 200,
      timeoutMs: 5000
    }
  });
  assert.equal(JSON.stringify(status).includes('secret'), false);
  assert.equal(JSON.stringify(status).includes('publishable'), false);
});

test('x402 config exposes safe readiness without leaking facilitator bearer token', () => {
  const status = getSafeRuntimeStatus({
    PAYMENT_PROVIDER: 'x402',
    PAYMENTS_ENABLED: 'true',
    X402_PAY_TO: '0x122F8Fcaf2152420445Aa424E1D8C0306935B5c9',
    X402_FACILITATOR_URL: 'https://api.cdp.coinbase.com/platform/v2/x402',
    X402_FACILITATOR_BEARER_TOKEN: 'secret-facilitator-token'
  });

  assert.deepEqual(status.payment, {
    provider: 'x402',
    enabled: true,
    escrowEnabled: true,
    sandboxWebhookConfigured: false,
    x402: {
      configured: true,
      payToConfigured: true,
      network: 'eip155:84532',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      scheme: 'exact',
      facilitatorHost: 'api.cdp.coinbase.com',
      facilitatorRequiresAuth: true,
      facilitatorBearerConfigured: true,
      maxTimeoutSeconds: 60
    },
    escrowContract: {
      configured: false,
      addressConfigured: false,
      network: 'eip155:84532',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      platformFeeBps: 0,
      rpcUrlConfigured: false
    }
  });
  assert.equal(JSON.stringify(status).includes('secret-facilitator-token'), false);
});

test('x402 requirements use exact USDC atomic amounts on Base Sepolia', async () => {
  const previous = {
    payTo: process.env.X402_PAY_TO,
    facilitatorUrl: process.env.X402_FACILITATOR_URL
  };
  process.env.X402_PAY_TO = '0x122F8Fcaf2152420445Aa424E1D8C0306935B5c9';
  process.env.X402_FACILITATOR_URL = 'https://x402.org/facilitator';
  try {
    const client = createClient();
    const response = await client.get('/v1/payments/x402/requirements', { amountUsdc: '9.00' });

    assert.equal(response.status, 200);
    assert.equal(response.body.provider, 'x402');
    assert.equal(response.body.paymentRequirements.scheme, 'exact');
    assert.equal(response.body.paymentRequirements.network, 'eip155:84532');
    assert.equal(response.body.paymentRequirements.asset, '0x036CbD53842c5426634e7929541eC2318f3dCF7e');
    assert.equal(response.body.paymentRequirements.amount, '9000000');
    assert.equal(response.body.paymentRequirements.payTo, process.env.X402_PAY_TO);
    assert.equal(usdcToAtomicAmount('0.001'), '1000');
  } finally {
    if (previous.payTo === undefined) delete process.env.X402_PAY_TO;
    else process.env.X402_PAY_TO = previous.payTo;
    if (previous.facilitatorUrl === undefined) delete process.env.X402_FACILITATOR_URL;
    else process.env.X402_FACILITATOR_URL = previous.facilitatorUrl;
  }
});

test('admin x402 settlement test verifies then settles through configured facilitator', async () => {
  const previousEnv = {
    payTo: process.env.X402_PAY_TO,
    facilitatorUrl: process.env.X402_FACILITATOR_URL,
    token: process.env.X402_FACILITATOR_BEARER_TOKEN
  };
  const previousFetch = globalThis.fetch;
  const calls = [];
  process.env.X402_PAY_TO = '0x122F8Fcaf2152420445Aa424E1D8C0306935B5c9';
  process.env.X402_FACILITATOR_URL = 'https://facilitator.test/x402';
  process.env.X402_FACILITATOR_BEARER_TOKEN = 'facilitator-token';
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    const payload = url.endsWith('/verify')
      ? { isValid: true, payer: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e', extra: {} }
      : {
          success: true,
          payer: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
          transaction: '0x89c91c789e57059b17285e7ba1716a1f5ff4c5dace0ea5a5135f26158d0421b9',
          network: 'base-sepolia',
          amount: '9000000',
          extra: {}
        };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    const client = createClient();
    const response = await client.adminPost('/v1/payments/x402/settle', {
      amountUsdc: '9.00',
      paymentPayload: {
        x402Version: 2,
        accepted: {
          scheme: 'exact',
          network: 'eip155:84532',
          asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          amount: '9000000',
          payTo: process.env.X402_PAY_TO,
          maxTimeoutSeconds: 60,
          extra: { name: 'USDC', version: '2' }
        },
        payload: {
          signature: '0xsig',
          authorization: {
            from: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
            to: process.env.X402_PAY_TO,
            value: '9000000',
            validAfter: '0',
            validBefore: '9999999999',
            nonce: '0xnonce'
          }
        },
        resource: {
          url: 'https://ax.test/v1/trades/example/confirm',
          description: 'Agent Exchange x402 settlement test',
          mimeType: 'application/json'
        }
      }
    });

    assert.equal(response.status, 202);
    assert.equal(response.body.settlement.transaction, '0x89c91c789e57059b17285e7ba1716a1f5ff4c5dace0ea5a5135f26158d0421b9');
    assert.deepEqual(calls.map((call) => call.url), [
      'https://facilitator.test/x402/verify',
      'https://facilitator.test/x402/settle'
    ]);
    assert.equal(calls[0].options.headers.authorization, 'Bearer facilitator-token');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousEnv.payTo === undefined) delete process.env.X402_PAY_TO;
    else process.env.X402_PAY_TO = previousEnv.payTo;
    if (previousEnv.facilitatorUrl === undefined) delete process.env.X402_FACILITATOR_URL;
    else process.env.X402_FACILITATOR_URL = previousEnv.facilitatorUrl;
    if (previousEnv.token === undefined) delete process.env.X402_FACILITATOR_BEARER_TOKEN;
    else process.env.X402_FACILITATOR_BEARER_TOKEN = previousEnv.token;
  }
});

test('x402 probe returns payment challenge headers and settles a supplied payment header', async () => {
  const previousEnv = {
    payTo: process.env.X402_PAY_TO,
    facilitatorUrl: process.env.X402_FACILITATOR_URL
  };
  const previousFetch = globalThis.fetch;
  const calls = [];
  process.env.X402_PAY_TO = '0x122F8Fcaf2152420445Aa424E1D8C0306935B5c9';
  process.env.X402_FACILITATOR_URL = 'https://facilitator.test/x402';
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    const payload = url.endsWith('/verify')
      ? { isValid: true, payer: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e', extra: {} }
      : {
          success: true,
          payer: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
          transaction: '0x89c91c789e57059b17285e7ba1716a1f5ff4c5dace0ea5a5135f26158d0421b9',
          network: 'eip155:84532',
          amount: '10000',
          extra: {}
        };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    const client = createClient();
    const unpaid = await client.get('/v1/payments/x402/probe', { amountUsdc: '0.01' });
    const required = decodePaymentRequiredHeader(unpaid.headers['PAYMENT-REQUIRED']);
    const paymentPayload = {
      x402Version: 2,
      resource: required.resource,
      accepted: required.accepts[0],
      payload: {
        signature: '0xsig',
        authorization: {
          from: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
          to: process.env.X402_PAY_TO,
          value: '10000',
          validAfter: '0',
          validBefore: '9999999999',
          nonce: '0xnonce'
        }
      }
    };
    const paid = await client.getWithHeaders(
      '/v1/payments/x402/probe',
      { 'X-PAYMENT': encodePaymentSignatureHeader(paymentPayload) },
      { amountUsdc: '0.01' }
    );

    assert.equal(unpaid.status, 402);
    assert.equal(required.x402Version, 2);
    assert.equal(required.accepts[0].amount, '10000');
    assert.equal(paid.status, 200);
    assert.ok(paid.headers['PAYMENT-RESPONSE'], JSON.stringify(paid));
    const paymentResponse = decodePaymentResponseHeader(paid.headers['PAYMENT-RESPONSE']);
    assert.equal(paid.body.ok, true);
    assert.equal(paymentResponse.transaction, '0x89c91c789e57059b17285e7ba1716a1f5ff4c5dace0ea5a5135f26158d0421b9');
    assert.equal(paid.body.paymentIntent.provider, 'x402');
    assert.equal(paid.body.paymentIntent.providerPaymentId, '0x89c91c789e57059b17285e7ba1716a1f5ff4c5dace0ea5a5135f26158d0421b9');
    assert.equal(paid.body.paymentIntent.tradeId, null);
    assert.equal(paid.body.paymentIntent.status, 'SUCCEEDED');
    assert.equal(paid.body.paymentEvent.type, 'x402.payment_settled');

    const duplicate = await client.getWithHeaders(
      '/v1/payments/x402/probe',
      { 'X-PAYMENT': encodePaymentSignatureHeader(paymentPayload) },
      { amountUsdc: '0.01' }
    );
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.duplicate, true);
    assert.equal(duplicate.body.paymentIntent.id, paid.body.paymentIntent.id);

    const payments = await client.adminGet('/v1/admin/payments', { provider: 'x402' });
    assert.equal(payments.status, 200);
    assert.equal(payments.body.paymentIntents.length, 1);
    assert.equal(payments.body.paymentEvents.length, 1);
    assert.deepEqual(calls.map((call) => call.url), [
      'https://facilitator.test/x402/verify',
      'https://facilitator.test/x402/settle',
      'https://facilitator.test/x402/verify',
      'https://facilitator.test/x402/settle'
    ]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousEnv.payTo === undefined) delete process.env.X402_PAY_TO;
    else process.env.X402_PAY_TO = previousEnv.payTo;
    if (previousEnv.facilitatorUrl === undefined) delete process.env.X402_FACILITATOR_URL;
    else process.env.X402_FACILITATOR_URL = previousEnv.facilitatorUrl;
  }
});

test('manual USDC verification records an on-chain transfer in the payment ledger', async () => {
  const previousEnv = {
    payTo: process.env.X402_PAY_TO,
    network: process.env.X402_NETWORK,
    asset: process.env.X402_ASSET,
    baseRpcUrl: process.env.BASE_RPC_URL
  };
  const previousFetch = globalThis.fetch;
  const payTo = '0x4707fedb208178ba609626cd654316c8a6f53510';
  const payer = '0xa8B690F9AEe52bdF344C6C5133eF4DfBAAA12e5D';
  const asset = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const txHash = '0x30999d74fd3d2372829c556665c544ae18a742e8ff3cf5f3571ce6f36bac3175';
  const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const addressTopic = (address) => `0x${address.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
  const calls = [];

  process.env.X402_PAY_TO = payTo;
  process.env.X402_NETWORK = 'eip155:8453';
  process.env.X402_ASSET = asset;
  delete process.env.BASE_RPC_URL;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: {
        transactionHash: txHash,
        status: '0x1',
        blockNumber: '0x123',
        logs: [
          {
            address: asset,
            topics: [transferTopic, addressTopic(payer), addressTopic(payTo)],
            data: '0x2710',
            logIndex: '0x0'
          }
        ]
      }
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    const client = createClient();
    const instructions = await client.get('/v1/payments/manual-usdc/instructions', { amountUsdc: '0.01' });
    assert.equal(instructions.status, 200);
    assert.equal(instructions.body.instructions.network, 'eip155:8453');
    assert.equal(instructions.body.instructions.amount, '10000');

    const verified = await client.postWithoutAuth('/v1/payments/manual-usdc/verify', {
      txHash,
      amountUsdc: '0.01',
      payer
    });
    assert.equal(verified.status, 202);
    assert.equal(verified.body.provider, 'manual_usdc');
    assert.equal(verified.body.settlement.payer, payer.toLowerCase());
    assert.equal(verified.body.paymentIntent.provider, 'manual_usdc');
    assert.equal(verified.body.paymentIntent.providerPaymentId, txHash);
    assert.equal(verified.body.paymentEvent.type, 'manual_usdc.transfer_confirmed');

    const duplicate = await client.postWithoutAuth('/v1/payments/manual-usdc/verify', {
      txHash,
      amountUsdc: '0.01',
      payer
    });
    assert.equal(duplicate.status, 202);
    assert.equal(duplicate.body.duplicate, true);
    assert.equal(duplicate.body.paymentIntent.id, verified.body.paymentIntent.id);

    const payments = await client.adminGet('/v1/admin/payments', { provider: 'manual_usdc' });
    assert.equal(payments.status, 200);
    assert.equal(payments.body.paymentIntents.length, 1);
    assert.equal(payments.body.paymentEvents.length, 1);
    assert.equal(calls[0].url, 'https://mainnet.base.org');

    const detail = await client.adminGet(`/v1/admin/inspect/payments/${verified.body.paymentIntent.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.resource.provider, 'manual_usdc');
    assert.equal(detail.body.paymentEvents.length, 1);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousEnv.payTo === undefined) delete process.env.X402_PAY_TO;
    else process.env.X402_PAY_TO = previousEnv.payTo;
    if (previousEnv.network === undefined) delete process.env.X402_NETWORK;
    else process.env.X402_NETWORK = previousEnv.network;
    if (previousEnv.asset === undefined) delete process.env.X402_ASSET;
    else process.env.X402_ASSET = previousEnv.asset;
    if (previousEnv.baseRpcUrl === undefined) delete process.env.BASE_RPC_URL;
    else process.env.BASE_RPC_URL = previousEnv.baseRpcUrl;
  }
});

test('paid market snapshot requires settled real-rail payment intent', async () => {
  const client = createClient();
  const { seller } = await registerBuyerSeller(client);
  await client.post('/v1/listings', {
    sellerAgentId: seller.id,
    title: 'Paid snapshot listing',
    description: 'Visible in paid market intelligence.',
    category: 'data',
    assuranceTier: 1,
    priceUsdc: '2.00'
  });

  const missing = await client.get('/v1/paid/market-snapshot');
  assert.equal(missing.status, 402);
  assert.equal(missing.body.error, 'payment_intent_required');

  const sandboxLedger = await client.store.recordExternalPaymentSettlement({
    provider: 'sandbox',
    providerPaymentId: 'sandbox_paid_demo',
    action: 'CAPTURE',
    amountUsdc: '1.00',
    actor: 'test',
    status: 'SUCCEEDED',
    eventType: 'sandbox.payment_settled'
  });
  const rejectedSandbox = await client.get('/v1/paid/market-snapshot', {
    paymentIntentId: sandboxLedger.paymentIntent.id
  });
  assert.equal(rejectedSandbox.status, 402);
  assert.equal(rejectedSandbox.body.error, 'payment_provider_not_accepted');

  const manualLedger = await client.store.recordExternalPaymentSettlement({
    provider: 'manual_usdc',
    providerPaymentId: '0x40999d74fd3d2372829c556665c544ae18a742e8ff3cf5f3571ce6f36bac3175',
    action: 'CAPTURE',
    amountUsdc: '0.01',
    actor: '0xa8b690f9aee52bdf344c6c5133ef4dfbaaa12e5d',
    status: 'SUCCEEDED',
    eventType: 'manual_usdc.transfer_confirmed'
  });
  const snapshot = await client.get('/v1/paid/market-snapshot', {
    paymentIntentId: manualLedger.paymentIntent.id
  });
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.body.ok, true);
  assert.equal(snapshot.body.unlockedBy.provider, 'manual_usdc');
  assert.equal(snapshot.body.snapshot.totals.activeListings, 1);
  assert.equal(snapshot.body.snapshot.recentListings[0].title, 'Paid snapshot listing');

  const events = await client.adminGet('/v1/admin/events', { type: 'paid_access.granted' });
  assert.equal(events.status, 200);
  assert.equal(events.body.events.length, 1);
});

test('free beta mode exposes market snapshot without payment intent and disables payment rails', async () => {
  const previous = {
    marketplaceMode: process.env.MARKETPLACE_MODE,
    paymentsEnabled: process.env.PAYMENTS_ENABLED,
    escrowEnabled: process.env.ESCROW_ENABLED
  };
  process.env.MARKETPLACE_MODE = 'free_beta';
  process.env.PAYMENTS_ENABLED = 'false';
  process.env.ESCROW_ENABLED = 'false';

  try {
    const client = createClient();
    const { seller } = await registerBuyerSeller(client);
    await client.post('/v1/listings', {
      sellerAgentId: seller.id,
      title: 'Free beta listing',
      description: 'Visible before paid rails are enabled.',
      category: 'digital_good',
      assuranceTier: 1,
      priceUsdc: '0.00'
    });

    const snapshot = await client.get('/v1/paid/market-snapshot');
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.body.priceUsdc, '0.00');
    assert.equal(snapshot.body.unlockedBy.provider, 'free_beta');
    assert.equal(snapshot.body.snapshot.totals.activeListings, 1);

    const x402 = await client.get('/v1/payments/x402/requirements', { amountUsdc: '0.01' });
    assert.equal(x402.status, 503);
    assert.equal(x402.body.error, 'payments_disabled');

    const manualUsdc = await client.get('/v1/payments/manual-usdc/instructions', { amountUsdc: '0.01' });
    assert.equal(manualUsdc.status, 503);
    assert.equal(manualUsdc.body.error, 'payments_disabled');
  } finally {
    process.env.MARKETPLACE_MODE = previous.marketplaceMode;
    process.env.PAYMENTS_ENABLED = previous.paymentsEnabled;
    process.env.ESCROW_ENABLED = previous.escrowEnabled;
  }
});

test('free beta trades complete without creating payment intents or escrow events', async () => {
  const previous = {
    marketplaceMode: process.env.MARKETPLACE_MODE,
    paymentsEnabled: process.env.PAYMENTS_ENABLED,
    escrowEnabled: process.env.ESCROW_ENABLED
  };
  process.env.MARKETPLACE_MODE = 'free_beta';
  process.env.PAYMENTS_ENABLED = 'false';
  process.env.ESCROW_ENABLED = 'false';

  try {
    const client = createClient();
    const { seller, buyer } = await registerBuyerSeller(client);
    const listing = await client.post('/v1/listings', {
      sellerAgentId: seller.id,
      title: 'External settlement beta task',
      description: 'Buyer and seller settle outside Agent Exchange.',
      category: 'digital_good',
      assuranceTier: 1,
      priceUsdc: '1.00'
    });
    const created = await client.post('/v1/trades', {
      listingId: listing.body.listing.id,
      buyerAgentId: buyer.id,
      assuranceAcknowledgement: true
    });

    assert.equal(created.status, 201);
    assert.equal(created.body.trade.settlementType, 'external_or_free');

    const accepted = await client.post(`/v1/trades/${created.body.trade.id}/accept`, {
      actorAgentId: seller.id
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.trade.state, 'FUNDED');
    assert.equal(accepted.body.escrowEvent, null);
    assert.equal(accepted.body.paymentIntent, null);

    await client.post(`/v1/trades/${created.body.trade.id}/deliver`, {
      actorAgentId: seller.id
    });
    const confirmed = await client.post(`/v1/trades/${created.body.trade.id}/confirm`, {
      actorAgentId: buyer.id
    });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.trade.state, 'CAPTURED');
    assert.equal(confirmed.body.escrowEvent, null);
    assert.equal(confirmed.body.paymentIntent, null);

    const payments = await client.adminGet('/v1/admin/payments');
    assert.equal(payments.body.paymentIntents.length, 0);
    const escrow = await client.getWithHeaders('/v1/escrow/events', seller.authHeaders);
    assert.equal(escrow.body.escrowEvents.length, 0);
  } finally {
    process.env.MARKETPLACE_MODE = previous.marketplaceMode;
    process.env.PAYMENTS_ENABLED = previous.paymentsEnabled;
    process.env.ESCROW_ENABLED = previous.escrowEnabled;
  }
});

test('Tier 0 listings are allowed when they do not violate policy', async () => {
  const client = createClient();
  const { seller } = await registerBuyerSeller(client);
  const result = await client.post('/v1/listings', {
    sellerAgentId: seller.id,
    title: 'Unused API credit voucher',
    description: 'Transferable voucher for 100 API calls.',
    category: 'digital_good',
    assuranceTier: 0,
    priceUsdc: '10.00'
  });

  assert.equal(result.status, 201);
  assert.equal(result.body.listing.assuranceTier, 0);
  assert.equal(result.body.listing.status, 'active');
});

test('Tier 0 trades require explicit buyer acknowledgement', async () => {
  const client = createClient();
  const { seller, buyer } = await registerBuyerSeller(client);
  const created = await client.post('/v1/listings', {
    sellerAgentId: seller.id,
    title: 'Unsupported digital file transfer',
    description: 'Seller-provided file delivery.',
    category: 'digital_good',
    assuranceTier: 0,
    priceUsdc: '3.50'
  });

  const listingId = created.body.listing.id;
  const missingAck = await client.post('/v1/trades', {
    listingId,
    buyerAgentId: buyer.id
  });

  assert.equal(missingAck.status, 409);
  assert.equal(missingAck.body.error, 'assurance_acknowledgement_required');

  const acknowledged = await client.post('/v1/trades', {
    listingId,
    buyerAgentId: buyer.id,
    assuranceAcknowledgement: true
  });

  assert.equal(acknowledged.status, 201);
  assert.equal(acknowledged.body.trade.state, 'OFFER_MADE');
  assert.equal(acknowledged.body.trade.buyerAcknowledgedAssurance, true);
});

test('prohibited severe abuse listings are blocked and marked reportable', async () => {
  const client = createClient();
  const { seller } = await registerBuyerSeller(client);
  const result = await client.post('/v1/listings', {
    sellerAgentId: seller.id,
    title: 'human trafficking listing',
    description: 'This should never be accepted.',
    category: 'generic',
    assuranceTier: 0,
    priceUsdc: '1.00'
  });

  assert.equal(result.status, 422);
  assert.equal(result.body.error, 'prohibited_listing');
  assert.equal(result.body.reportable, true);
  assert.ok(result.body.matches.some((match) => match.id === 'human_trafficking'));
});

test('listings require an authenticated seller session', async () => {
  const client = createClient();
  const result = await client.postWithoutAuth('/v1/listings', {
    sellerAgentId: 'agt_missing',
    title: 'Missing seller listing',
    description: 'Should be rejected before policy screening.',
    category: 'digital_good',
    assuranceTier: 0,
    priceUsdc: '1.00'
  });

  assert.equal(result.status, 401);
  assert.equal(result.body.error, 'authentication_required');
});

test('bearer session must match declared agent identity on mutations', async () => {
  const client = createClient();
  const { seller, buyer } = await registerBuyerSeller(client);
  const listing = await client.post(
    '/v1/listings',
    {
      sellerAgentId: seller.id,
      title: 'Impersonation listing',
      description: 'Buyer token cannot create as seller.',
      category: 'digital_good',
      assuranceTier: 0,
      priceUsdc: '1.00'
    },
    buyer.authHeaders
  );

  assert.equal(listing.status, 403);
  assert.equal(listing.body.error, 'authenticated_actor_mismatch');
});

test('signed agent requests authenticate mutations and reject nonce replay', async () => {
  const client = createClient();
  const { seller, buyer } = await registerBuyerSeller(client);
  const body = {
    sellerAgentId: seller.id,
    title: 'Signed request listing',
    description: 'Seller signs without bearer session.',
    category: 'digital_good',
    assuranceTier: 0,
    priceUsdc: '1.00'
  };
  const timestamp = new Date().toISOString();
  const nonce = 'signed-listing-nonce';
  const headers = signRequestHeaders({
    agentId: seller.id,
    privateKey: seller.privateKey,
    method: 'POST',
    pathname: '/v1/listings',
    body,
    timestamp,
    nonce
  });

  const created = await client.postWithoutAuth('/v1/listings', body, headers);
  const replay = await client.postWithoutAuth('/v1/listings', body, headers);
  const mismatchBody = {
    ...body,
    sellerAgentId: buyer.id,
    title: 'Signed request mismatch'
  };
  const mismatch = await client.postWithoutAuth('/v1/listings', mismatchBody, signRequestHeaders({
    agentId: seller.id,
    privateKey: seller.privateKey,
    method: 'POST',
    pathname: '/v1/listings',
    body: mismatchBody,
    nonce: 'signed-mismatch-nonce'
  }));

  assert.equal(created.status, 201);
  assert.equal(created.body.listing.sellerAgentId, seller.id);
  assert.equal(replay.status, 409);
  assert.equal(replay.body.error, 'signed_request_replay');
  assert.equal(mismatch.status, 403);
  assert.equal(mismatch.body.error, 'authenticated_actor_mismatch');
});

test('scoped API keys authenticate agents and enforce route scopes', async () => {
  const client = createClient();
  const { seller } = await registerBuyerSeller(client);
  const readKey = await client.post(`/v1/agents/${seller.id}/api-keys`, {
    name: 'read only',
    scopes: ['read']
  }, seller.authHeaders);
  const writeKey = await client.post(`/v1/agents/${seller.id}/api-keys`, {
    name: 'listing writer',
    scopes: ['listings:write']
  }, seller.authHeaders);
  const listed = await client.getWithHeaders(`/v1/agents/${seller.id}/api-keys`, seller.authHeaders);

  const body = {
    sellerAgentId: seller.id,
    title: 'API key listing',
    description: 'Scoped key creates this listing.',
    category: 'digital_good',
    assuranceTier: 0,
    priceUsdc: '1.00'
  };
  const denied = await client.postWithoutAuth('/v1/listings', body, {
    authorization: `ApiKey ${readKey.body.token}`
  });
  const created = await client.postWithoutAuth('/v1/listings', body, {
    authorization: `ApiKey ${writeKey.body.token}`
  });
  const revoked = await client.post(`/v1/agents/${seller.id}/api-keys/${writeKey.body.apiKey.id}/revoke`, {}, seller.authHeaders);
  const afterRevoke = await client.postWithoutAuth('/v1/listings', {
    ...body,
    title: 'Revoked key listing'
  }, {
    authorization: `ApiKey ${writeKey.body.token}`
  });

  assert.equal(readKey.status, 201);
  assert.ok(readKey.body.token.startsWith('axk_'));
  assert.equal('tokenHash' in readKey.body.apiKey, false);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.apiKeys.length, 2);
  assert.equal('tokenHash' in listed.body.apiKeys[0], false);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error, 'api_key_scope_denied');
  assert.equal(created.status, 201);
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.apiKey.status, 'revoked');
  assert.equal(afterRevoke.status, 401);
  assert.equal(afterRevoke.body.error, 'invalid_or_expired_api_key');
});

test('agents can register and verify an Ed25519 challenge once', async () => {
  const client = createClient();
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const registered = await client.post('/v1/agents/register', {
    developerId: 'dev_identity',
    name: 'Identity Bot',
    publicKeyJwk: publicKey.export({ format: 'jwk' })
  });

  assert.equal(registered.status, 201);
  assert.equal(registered.body.agent.verificationTier, 2);

  const challenged = await client.post(`/v1/agents/${registered.body.agent.id}/verify/challenge`, {});
  const signature = sign(null, Buffer.from(challenged.body.challenge.canonical), privateKey).toString('base64');

  const verified = await client.post(`/v1/agents/${registered.body.agent.id}/verify/response`, {
    challengeId: challenged.body.challenge.id,
    signature
  });

  assert.equal(verified.status, 201);
  assert.equal(verified.body.session.agentId, registered.body.agent.id);
  assert.ok(verified.body.session.token);
  assert.equal('tokenHash' in verified.body.session, false);

  const replay = await client.post(`/v1/agents/${registered.body.agent.id}/verify/response`, {
    challengeId: challenged.body.challenge.id,
    signature
  });

  assert.equal(replay.status, 409);
  assert.equal(replay.body.error, 'challenge_already_used');
});

test('trade creation is idempotent and rejects key reuse with a different body', async () => {
  const client = createClient();
  const { seller, buyer } = await registerBuyerSeller(client);
  const otherBuyer = await registerBasicAgent(client, 'other_buyer');
  const created = await client.post('/v1/listings', {
    sellerAgentId: seller.id,
    title: 'Idempotent listing',
    description: 'Seller-provided file delivery.',
    category: 'digital_good',
    assuranceTier: 0,
    priceUsdc: '5.00'
  });

  const body = {
    listingId: created.body.listing.id,
    buyerAgentId: buyer.id,
    assuranceAcknowledgement: true
  };
  const first = await client.post('/v1/trades', body, { 'idempotency-key': 'trade-key-1' });
  const second = await client.post('/v1/trades', body, { 'idempotency-key': 'trade-key-1' });

  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(second.body.trade.id, first.body.trade.id);

  const reused = await client.post(
    '/v1/trades',
    { ...body, buyerAgentId: otherBuyer.id },
    { 'idempotency-key': 'trade-key-1' }
  );

  assert.equal(reused.status, 409);
  assert.equal(reused.body.error, 'idempotency_key_reuse');
});

test('idempotency serializes duplicate in-flight requests', async () => {
  const store = createStore();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let runs = 0;
  const input = { agentId: 'agt_race', amount: '1.00' };

  const first = store.withIdempotency(
    { scope: 'race', key: 'same-key', input },
    async () => {
      runs += 1;
      await gate;
      return { status: 201, body: { runs } };
    }
  );
  await Promise.resolve();
  const second = store.withIdempotency(
    { scope: 'race', key: 'same-key', input },
    async () => {
      runs += 1;
      return { status: 201, body: { runs } };
    }
  );
  const reusedDifferentBody = await store.withIdempotency(
    { scope: 'race', key: 'same-key', input: { ...input, amount: '2.00' } },
    async () => ({ status: 201, body: { shouldNotRun: true } })
  );

  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(runs, 1);
  assert.deepEqual(secondResult, firstResult);
  assert.equal(reusedDifferentBody.status, 409);
  assert.equal(reusedDifferentBody.body.error, 'idempotency_key_reuse');
});

test('self trading is blocked', async () => {
  const client = createClient();
  const seller = await registerBasicAgent(client, 'self_trade_agent');
  const created = await client.post('/v1/listings', {
    sellerAgentId: seller.id,
    title: 'Self trade listing',
    description: 'Should not be buyable by the same agent.',
    category: 'digital_good',
    assuranceTier: 0,
    priceUsdc: '2.00'
  });
  const result = await client.post('/v1/trades', {
    listingId: created.body.listing.id,
    buyerAgentId: seller.id,
    assuranceAcknowledgement: true
  });

  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'self_trade_blocked');
});

test('trade transitions create escrow events and reject invalid state jumps', async () => {
  const client = createClient();
  const { seller, buyer } = await registerBuyerSeller(client);
  const created = await client.post('/v1/listings', {
    sellerAgentId: seller.id,
    title: 'Transition listing',
    description: 'Seller-provided file delivery.',
    category: 'digital_good',
    assuranceTier: 0,
    priceUsdc: '7.00'
  });
  const offer = await client.post('/v1/trades', {
    listingId: created.body.listing.id,
    buyerAgentId: buyer.id,
    assuranceAcknowledgement: true
  });

  const invalidConfirm = await client.post(`/v1/trades/${offer.body.trade.id}/confirm`, {
    actorAgentId: buyer.id
  });

  assert.equal(invalidConfirm.status, 409);
  assert.equal(invalidConfirm.body.error, 'invalid_trade_transition');

  const accepted = await client.post(
    `/v1/trades/${offer.body.trade.id}/accept`,
    { actorAgentId: seller.id },
    { 'idempotency-key': 'accept-1' }
  );
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.trade.state, 'FUNDED');
  assert.equal(accepted.body.escrowEvent.type, 'AUTHORIZE_STUB');
  assert.equal(accepted.body.paymentIntent.action, 'AUTHORIZE');
  assert.equal(accepted.body.paymentIntent.status, 'SUCCEEDED');
  assert.equal(accepted.body.escrowEvent.adapter, 'sandbox');

  const delivered = await client.post(`/v1/trades/${offer.body.trade.id}/deliver`, {
    actorAgentId: seller.id,
    proof: { note: 'Tier 0 seller proof' }
  });
  assert.equal(delivered.status, 200);
  assert.equal(delivered.body.trade.state, 'DELIVERED');

  const confirmed = await client.post(`/v1/trades/${offer.body.trade.id}/confirm`, {
    actorAgentId: buyer.id
  });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.trade.state, 'CAPTURED');
  assert.equal(confirmed.body.escrowEvent.type, 'CAPTURE_STUB');
  assert.equal(confirmed.body.paymentIntent.action, 'CAPTURE');
});

test('smart contract escrow events fund and release trades through verified receipts', async () => {
  const previousEnv = {
    contractAddress: process.env.ESCROW_CONTRACT_ADDRESS,
    network: process.env.ESCROW_NETWORK,
    asset: process.env.ESCROW_ASSET,
    rpcUrl: process.env.ESCROW_RPC_URL,
    provider: process.env.PAYMENT_PROVIDER
  };
  const previousFetch = globalThis.fetch;
  const contractAddress = '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
  const buyerWallet = '0xa8B690F9AEe52bdF344C6C5133eF4DfBAAA12e5D';
  const sellerWallet = '0x4707fedb208178ba609626cd654316c8a6f53510';
  const fundTxHash = '0x10999d74fd3d2372829c556665c544ae18a742e8ff3cf5f3571ce6f36bac3175';
  const releaseTxHash = '0x20999d74fd3d2372829c556665c544ae18a742e8ff3cf5f3571ce6f36bac3175';
  const calls = [];

  process.env.ESCROW_CONTRACT_ADDRESS = contractAddress;
  process.env.ESCROW_NETWORK = 'eip155:8453';
  process.env.ESCROW_ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  process.env.ESCROW_RPC_URL = 'https://rpc.test/base';
  process.env.PAYMENT_PROVIDER = 'x402';

  try {
    const client = createClient();
    const seller = await registerBasicAgent(client, 'escrow_seller', { walletAddress: sellerWallet });
    const buyer = await registerBasicAgent(client, 'escrow_buyer', { walletAddress: buyerWallet });
    const created = await client.post('/v1/listings', {
      sellerAgentId: seller.id,
      title: 'Escrow contract listing',
      description: 'Seller-provided file delivery settled by contract escrow.',
      category: 'digital_good',
      assuranceTier: 0,
      priceUsdc: '7.00'
    });
    const offered = await client.post('/v1/trades', {
      listingId: created.body.listing.id,
      buyerAgentId: buyer.id,
      assuranceAcknowledgement: true
    });
    const tradeId = offered.body.trade.id;

    globalThis.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url, body });
      const txHash = body.params[0];
      const log = txHash === fundTxHash
        ? escrowFundedLog({
            contractAddress,
            tradeId,
            buyer: buyerWallet,
            seller: sellerWallet,
            amount: '7000000'
          })
        : escrowReleasedLog({
            contractAddress,
            tradeId,
            seller: sellerWallet,
            sellerAmount: '6998250',
            platformFee: '1750'
          });
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          transactionHash: txHash,
          status: '0x1',
          blockNumber: '0x456',
          logs: [log]
        }
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    };

    const config = await client.get('/v1/escrow/contract/config', { tradeId });
    assert.equal(config.status, 200);
    assert.equal(config.body.configured, true);
    assert.equal(config.body.sampleTradeIdHash, escrowTradeIdHash(tradeId));
    assert.ok(config.body.abi.some((item) => item.name === 'EscrowFunded'));

    const funded = await client.post(
      `/v1/trades/${tradeId}/fund-onchain`,
      { actorAgentId: buyer.id, txHash: fundTxHash },
      { 'idempotency-key': 'onchain-fund-1' }
    );
    assert.equal(funded.status, 200);
    assert.equal(funded.body.trade.state, 'FUNDED');
    assert.equal(funded.body.escrowEvent.type, 'SMART_CONTRACT_FUND');
    assert.equal(funded.body.escrowEvent.adapter, 'smart_contract');
    assert.equal(funded.body.paymentIntent.provider, 'smart_contract');
    assert.equal(funded.body.paymentIntent.providerPaymentId, fundTxHash);
    assert.equal(funded.body.paymentIntent.action, 'AUTHORIZE');
    assert.equal(funded.body.trade.events.at(-1).type, 'ONCHAIN_FUNDED');

    const delivered = await client.post(`/v1/trades/${tradeId}/deliver`, {
      actorAgentId: seller.id,
      proof: { note: 'delivered' }
    });
    assert.equal(delivered.status, 200);

    const released = await client.post(
      `/v1/trades/${tradeId}/release-onchain`,
      { actorAgentId: buyer.id, txHash: releaseTxHash },
      { 'idempotency-key': 'onchain-release-1' }
    );
    assert.equal(released.status, 200);
    assert.equal(released.body.trade.state, 'CAPTURED');
    assert.equal(released.body.escrowEvent.type, 'SMART_CONTRACT_RELEASE');
    assert.equal(released.body.paymentIntent.action, 'CAPTURE');
    assert.equal(released.body.paymentIntent.providerPaymentId, releaseTxHash);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'https://rpc.test/base');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousEnv.contractAddress === undefined) delete process.env.ESCROW_CONTRACT_ADDRESS;
    else process.env.ESCROW_CONTRACT_ADDRESS = previousEnv.contractAddress;
    if (previousEnv.network === undefined) delete process.env.ESCROW_NETWORK;
    else process.env.ESCROW_NETWORK = previousEnv.network;
    if (previousEnv.asset === undefined) delete process.env.ESCROW_ASSET;
    else process.env.ESCROW_ASSET = previousEnv.asset;
    if (previousEnv.rpcUrl === undefined) delete process.env.ESCROW_RPC_URL;
    else process.env.ESCROW_RPC_URL = previousEnv.rpcUrl;
    if (previousEnv.provider === undefined) delete process.env.PAYMENT_PROVIDER;
    else process.env.PAYMENT_PROVIDER = previousEnv.provider;
  }
});

test('escrow watcher records matched smart contract logs idempotently', async () => {
  const client = createClient();
  const contractAddress = '0x1111111111111111111111111111111111111111';
  const buyerWallet = '0x2222222222222222222222222222222222222222';
  const sellerWallet = '0x3333333333333333333333333333333333333333';
  const seller = await registerBasicAgent(client, 'watcher_seller', { walletAddress: sellerWallet });
  const buyer = await registerBasicAgent(client, 'watcher_buyer', { walletAddress: buyerWallet });
  const listing = await createFungibleListing(client, seller, {
    totalQuantity: 1000,
    maxFillQuantity: 1000
  });
  const tradeResult = await client.post('/v1/trades', {
    listingId: listing.id,
    buyerAgentId: buyer.id,
    quantity: 100,
    assuranceAcknowledgement: true
  });
  const trade = tradeResult.body.trade;
  const log = {
    ...escrowFundedLog({
      contractAddress,
      tradeId: trade.id,
      buyer: buyerWallet,
      seller: sellerWallet,
      amount: usdcToAtomicAmount(trade.priceUsdc)
    }),
    transactionHash: '0x' + 'a'.repeat(64),
    blockNumber: '0x10',
    logIndex: '0x0'
  };
  const fetchFn = async (_url, init) => {
    const request = JSON.parse(init.body);
    if (request.method === 'eth_blockNumber') {
      return { ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x10' }) };
    }
    if (request.method === 'eth_getLogs') {
      return { ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: [log] }) };
    }
    throw new Error(`unexpected rpc method ${request.method}`);
  };
  const config = getConfig({
    ESCROW_ENABLED: 'true',
    ESCROW_CONTRACT_ADDRESS: contractAddress,
    ESCROW_NETWORK: 'eip155:84532',
    ESCROW_RPC_URL: 'https://rpc.test'
  });

  const first = await runEscrowWatcher({
    store: client.store,
    config,
    fromBlock: 16,
    toBlock: 16,
    fetchFn
  });
  const second = await runEscrowWatcher({
    store: client.store,
    config,
    fromBlock: 16,
    toBlock: 16,
    fetchFn
  });
  const events = await client.adminGet('/v1/admin/events', {
    resourceType: 'trade',
    resourceId: trade.id,
    type: 'escrow.watcher.event.observed'
  });

  assert.equal(first.ok, true);
  assert.equal(first.eventsObserved, 1);
  assert.equal(first.events[0].resourceId, trade.id);
  assert.equal(first.events[0].payload.eventName, 'EscrowFunded');
  assert.equal(second.ok, true);
  assert.equal(events.body.events.length, 1);
});

test('stale trade transition recheck prevents split escrow writes', async () => {
  const client = createClient();
  const { seller, buyer } = await registerBuyerSeller(client);
  const created = await client.post('/v1/listings', {
    sellerAgentId: seller.id,
    title: 'Transition race listing',
    description: 'State recheck should guard escrow writes.',
    category: 'digital_good',
    assuranceTier: 0,
    priceUsdc: '11.00'
  });
  const offered = await client.post('/v1/trades', {
    listingId: created.body.listing.id,
    buyerAgentId: buyer.id,
    assuranceAcknowledgement: true
  });
  await client.post(`/v1/trades/${offered.body.trade.id}/accept`, {
    actorAgentId: seller.id
  });
  await client.post(`/v1/trades/${offered.body.trade.id}/deliver`, {
    actorAgentId: seller.id
  });

  const tradeBeforeRace = (await client.getWithHeaders(
    `/v1/trades/${offered.body.trade.id}`,
    buyer.authHeaders
  )).body.trade;
  const confirm = getTransition('confirm');
  const refund = getTransition('refund');
  const confirmed = client.store.transitionTrade(tradeBeforeRace.id, {
    ...confirm,
    actor: buyer.id,
    escrowAmountUsdc: tradeBeforeRace.priceUsdc,
    escrowPayload: {},
    payload: {}
  });
  const staleRefund = client.store.transitionTrade(tradeBeforeRace.id, {
    ...refund,
    actor: seller.id,
    escrowAmountUsdc: tradeBeforeRace.priceUsdc,
    escrowPayload: {},
    payload: {}
  });
  const escrowEvents = await client.store.listEscrowEvents({ tradeId: tradeBeforeRace.id });

  assert.equal(confirmed.trade.state, 'CAPTURED');
  assert.equal(confirmed.escrowEvent.type, 'CAPTURE_STUB');
  assert.equal(confirmed.paymentIntent.status, 'SUCCEEDED');
  assert.equal(staleRefund.error.status, 409);
  assert.equal(escrowEvents.some((event) => event.type === 'REFUND_STUB'), false);
});

test('sandbox payment decline leaves trade state unchanged and skips escrow event', async () => {
  const client = createClient();
  const { seller, buyer } = await registerBuyerSeller(client);
  const created = await client.post('/v1/listings', {
    sellerAgentId: seller.id,
    title: 'Declined payment listing',
    description: 'Funding should fail in sandbox.',
    category: 'digital_good',
    assuranceTier: 0,
    priceUsdc: '12.00'
  });
  const offered = await client.post('/v1/trades', {
    listingId: created.body.listing.id,
    buyerAgentId: buyer.id,
    assuranceAcknowledgement: true
  });
  const declined = await client.post(`/v1/trades/${offered.body.trade.id}/accept`, {
    actorAgentId: seller.id,
    sandboxPaymentOutcome: 'declined'
  });
  const fetchedTrade = await client.getWithHeaders(`/v1/trades/${offered.body.trade.id}`, buyer.authHeaders);
  const payments = await client.adminGet('/v1/admin/payments', { status: 'DECLINED' });
  const escrowEvents = await client.store.listEscrowEvents();

  assert.equal(declined.status, 402);
  assert.equal(declined.body.error, 'sandbox_payment_not_settled');
  assert.equal(declined.body.paymentIntent.status, 'DECLINED');
  assert.equal(fetchedTrade.body.trade.state, 'OFFER_MADE');
  assert.equal(payments.status, 200);
  assert.equal(payments.body.paymentIntents.some((intent) => intent.id === declined.body.paymentIntent.id), true);
  assert.equal(escrowEvents.some((event) => event.tradeId === offered.body.trade.id), false);
});

test('non-sandbox payment provider cannot silently run trade escrow actions', async () => {
  const previousProvider = process.env.PAYMENT_PROVIDER;
  process.env.PAYMENT_PROVIDER = 'x402';
  try {
    const client = createClient();
    const { seller, buyer } = await registerBuyerSeller(client);
    const created = await client.post('/v1/listings', {
      sellerAgentId: seller.id,
      title: 'x402 guarded listing',
      description: 'Trade escrow should not silently use sandbox while x402 is selected.',
      category: 'digital_good',
      assuranceTier: 0,
      priceUsdc: '12.00'
    });
    const offered = await client.post('/v1/trades', {
      listingId: created.body.listing.id,
      buyerAgentId: buyer.id,
      assuranceAcknowledgement: true
    });
    const accepted = await client.post(`/v1/trades/${offered.body.trade.id}/accept`, {
      actorAgentId: seller.id
    });
    const payments = await client.adminGet('/v1/admin/payments');

    assert.equal(accepted.status, 503);
    assert.equal(accepted.body.error, 'trade_payment_provider_not_connected');
    assert.equal(payments.body.paymentIntents.length, 0);
  } finally {
    if (previousProvider === undefined) delete process.env.PAYMENT_PROVIDER;
    else process.env.PAYMENT_PROVIDER = previousProvider;
  }
});

test('sandbox payment webhooks require signatures and dedupe event ids', async () => {
  const previousSecret = process.env.PAYMENT_SANDBOX_WEBHOOK_SECRET;
  process.env.PAYMENT_SANDBOX_WEBHOOK_SECRET = 'sandbox-webhook-secret';
  try {
    const client = createClient();
    const { seller, buyer } = await registerBuyerSeller(client);
    const listing = await createFungibleListing(client, seller);
    const trade = await client.post('/v1/trades', {
      listingId: listing.id,
      buyerAgentId: buyer.id,
      quantity: 100,
      assuranceAcknowledgement: true
    });
    const accepted = await client.post(`/v1/trades/${trade.body.trade.id}/accept`, {
      actorAgentId: seller.id
    });
    const payload = {
      eventId: 'evt_sandbox_1',
      paymentIntentId: accepted.body.paymentIntent.id,
      status: 'SUCCEEDED',
      type: 'sandbox.payment_succeeded',
      payload: { replayable: true }
    };
    const rejected = await client.postWithoutAuth('/v1/payments/sandbox/webhook', payload, {
      'x-sandbox-payment-signature': 'bad'
    });
    const signature = signSandboxWebhookPayload(process.env.PAYMENT_SANDBOX_WEBHOOK_SECRET, payload);
    const first = await client.postWithoutAuth('/v1/payments/sandbox/webhook', payload, {
      'x-sandbox-payment-signature': `sha256=${signature}`
    });
    const duplicate = await client.postWithoutAuth('/v1/payments/sandbox/webhook', payload, {
      'x-sandbox-payment-signature': `sha256=${signature}`
    });
    const detail = await client.adminGet(`/v1/admin/payments/${accepted.body.paymentIntent.id}`);

    assert.equal(rejected.status, 401);
    assert.equal(first.status, 202);
    assert.equal(first.body.duplicate, false);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.duplicate, true);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.paymentEvents.length, 1);
  } finally {
    if (previousSecret === undefined) {
      delete process.env.PAYMENT_SANDBOX_WEBHOOK_SECRET;
    } else {
      process.env.PAYMENT_SANDBOX_WEBHOOK_SECRET = previousSecret;
    }
  }
});

test('admin payment repair requires reason and force for terminal status changes', async () => {
  const client = createClient();
  const { seller, buyer } = await registerBuyerSeller(client);
  const listing = await createFungibleListing(client, seller);
  const trade = await client.post('/v1/trades', {
    listingId: listing.id,
    buyerAgentId: buyer.id,
    quantity: 100,
    assuranceAcknowledgement: true
  });
  const accepted = await client.post(`/v1/trades/${trade.body.trade.id}/accept`, {
    actorAgentId: seller.id
  });
  const paymentIntentId = accepted.body.paymentIntent.id;

  const missingReason = await client.adminPost(`/v1/admin/payments/${paymentIntentId}/repair`, {
    status: 'FAILED'
  });
  const unforced = await client.adminPost(`/v1/admin/payments/${paymentIntentId}/repair`, {
    status: 'FAILED',
    reason: 'ops drill'
  });
  const forced = await client.adminPost(`/v1/admin/payments/${paymentIntentId}/repair`, {
    status: 'FAILED',
    reason: 'ops drill',
    force: true,
    metadata: { ticket: 'test' }
  });
  const detail = await client.adminGet(`/v1/admin/payments/${paymentIntentId}`);

  assert.equal(missingReason.status, 400);
  assert.equal(missingReason.body.error, 'repair_reason_required');
  assert.equal(unforced.status, 409);
  assert.equal(unforced.body.error, 'terminal_payment_repair_requires_force');
  assert.equal(forced.status, 200);
  assert.equal(forced.body.paymentIntent.status, 'FAILED');
  assert.ok(detail.body.paymentEvents.some((event) => event.type === 'admin.payment_status_repaired'));
});

test('trade actions enforce buyer seller roles', async () => {
  const client = createClient();
  const { seller, buyer } = await registerBuyerSeller(client);
  const created = await client.post('/v1/listings', {
    sellerAgentId: seller.id,
    title: 'Role enforcement listing',
    description: 'Seller-provided file delivery.',
    category: 'digital_good',
    assuranceTier: 0,
    priceUsdc: '8.00'
  });
  const offer = await client.post('/v1/trades', {
    listingId: created.body.listing.id,
    buyerAgentId: buyer.id,
    assuranceAcknowledgement: true
  });

  const buyerAccept = await client.post(`/v1/trades/${offer.body.trade.id}/accept`, {
    actorAgentId: buyer.id
  });

  assert.equal(buyerAccept.status, 403);
  assert.equal(buyerAccept.body.error, 'seller_actor_required');

  const accepted = await client.post(`/v1/trades/${offer.body.trade.id}/accept`, {
    actorAgentId: seller.id
  });
  const delivered = await client.post(`/v1/trades/${offer.body.trade.id}/deliver`, {
    actorAgentId: seller.id
  });
  const sellerConfirm = await client.post(`/v1/trades/${offer.body.trade.id}/confirm`, {
    actorAgentId: seller.id
  });

  assert.equal(accepted.status, 200);
  assert.equal(delivered.status, 200);
  assert.equal(sellerConfirm.status, 403);
  assert.equal(sellerConfirm.body.error, 'buyer_actor_required');
});

test('dispute resolution is admin-only in the current prototype', async () => {
  const client = createClient();
  const { seller, buyer } = await registerBuyerSeller(client);
  const created = await client.post('/v1/listings', {
    sellerAgentId: seller.id,
    title: 'Dispute listing',
    description: 'Seller-provided file delivery.',
    category: 'digital_good',
    assuranceTier: 0,
    priceUsdc: '9.00'
  });
  const offer = await client.post('/v1/trades', {
    listingId: created.body.listing.id,
    buyerAgentId: buyer.id,
    assuranceAcknowledgement: true
  });

  await client.post(`/v1/trades/${offer.body.trade.id}/accept`, {
    actorAgentId: seller.id
  });
  await client.post(`/v1/trades/${offer.body.trade.id}/deliver`, {
    actorAgentId: seller.id
  });
  const disputed = await client.post(`/v1/trades/${offer.body.trade.id}/dispute`, {
    actorAgentId: buyer.id,
    reason: 'Buyer disputes Tier 0 delivery.'
  });

  assert.equal(disputed.status, 200);
  assert.equal(disputed.body.trade.state, 'DISPUTED');

  const partyResolve = await client.post(`/v1/trades/${offer.body.trade.id}/resolve`, {
    actorAgentId: buyer.id,
    resolution: 'refund'
  });
  const adminResolve = await client.adminPost(`/v1/trades/${offer.body.trade.id}/resolve`, {
    actorAgentId: 'admin_1',
    actorRole: 'admin',
    resolution: 'refund'
  });

  assert.equal(partyResolve.status, 403);
  assert.equal(partyResolve.body.error, 'admin_actor_required');
  assert.equal(adminResolve.status, 200);
  assert.equal(adminResolve.body.trade.state, 'REFUNDED');
});

test('buyer can make best offer and seller can counter', async () => {
  const client = createClient();
  const { seller, buyer } = await registerBuyerSeller(client);
  const listing = await createFungibleListing(client, seller);
  const fetchedListing = await client.get(`/v1/listings/${listing.id}`);

  const offer = await client.post('/v1/offers', {
    listingId: listing.id,
    buyerAgentId: buyer.id,
    quantity: 1000,
    unitPriceUsdc: '0.008',
    assuranceAcknowledgement: true,
    expiresAt: futureIso()
  });
  const fetchedOffer = await client.getWithHeaders(`/v1/offers/${offer.body.offer.id}`, buyer.authHeaders);

  assert.equal(fetchedListing.status, 200);
  assert.equal(fetchedListing.body.listing.id, listing.id);
  assert.equal(offer.status, 201);
  assert.equal(offer.body.offer.status, 'OPEN');
  assert.equal(offer.body.offer.totalPriceUsdc, '8.00');
  assert.equal(fetchedOffer.status, 200);
  assert.equal(fetchedOffer.body.offer.id, offer.body.offer.id);

  const counter = await client.post(`/v1/offers/${offer.body.offer.id}/counter`, {
    actorAgentId: seller.id,
    quantity: 1000,
    unitPriceUsdc: '0.009',
    assuranceAcknowledgement: true,
    expiresAt: futureIso()
  });

  assert.equal(counter.status, 201);
  assert.equal(counter.body.offer.parentOfferId, offer.body.offer.id);
  assert.equal(counter.body.offer.createdByAgentId, seller.id);
  assert.equal(counter.body.offer.totalPriceUsdc, '9.00');
});

test('single-resource lookup endpoints return 404 for missing ids', async () => {
  const client = createClient();

  const listing = await client.get('/v1/listings/lst_missing');
  const offer = await client.adminGet('/v1/offers/off_missing');
  const trade = await client.adminGet('/v1/trades/trd_missing');

  assert.equal(listing.status, 404);
  assert.equal(listing.body.error, 'listing_not_found');
  assert.equal(offer.status, 404);
  assert.equal(offer.body.error, 'offer_not_found');
  assert.equal(trade.status, 404);
  assert.equal(trade.body.error, 'trade_not_found');
});

test('search, listing quality, and agent onboarding expose launch readiness signals', async () => {
  const client = createClient();
  const seller = await registerBasicAgent(client, 'seller_good_launch');
  const created = await client.post('/v1/listings', {
    sellerAgentId: seller.id,
    title: 'Launch-ready API credit bundle',
    description: 'A detailed bundle of transferable API credits with clear quantity, transfer timing, and buyer expectations.',
    category: 'digital_good',
    assuranceTier: 2,
    priceUsdc: '12.50'
  });
  assert.equal(created.status, 201);

  const search = await client.get('/v1/search', { q: 'credit bundle' });
  assert.equal(search.status, 200);
  assert.equal(search.body.results.length, 1);
  assert.equal(search.body.results[0].listing.id, created.body.listing.id);
  assert.ok(search.body.results[0].quality.score >= 80);

  const buyer = await registerBasicAgent(client, 'search_partial_buyer');
  const fungible = await createFungibleListing(client, seller, {
    title: 'Partially filled searchable compute credits',
    totalQuantity: 1000,
    maxFillQuantity: 1000
  });
  await client.post('/v1/trades', {
    listingId: fungible.id,
    buyerAgentId: buyer.id,
    quantity: 100,
    assuranceAcknowledgement: true
  });
  const partialSearch = await client.get('/v1/search', { q: 'searchable compute' });
  assert.equal(partialSearch.status, 200);
  assert.ok(partialSearch.body.results.some((result) => result.listing.id === fungible.id));

  const quality = await client.get(`/v1/listings/${created.body.listing.id}/quality`);
  assert.equal(quality.status, 200);
  assert.ok(quality.body.quality.checks.some((check) => check.key === 'policyScreened' && check.passed));

  const onboarding = await client.getWithHeaders(`/v1/agents/${seller.id}/onboarding`, seller.authHeaders);
  assert.equal(onboarding.status, 200);
  assert.equal(onboarding.body.onboarding.ready, true);
  assert.equal(onboarding.body.onboarding.activeListings, 2);
});

test('list endpoints support allow-listed filters and pagination', async () => {
  const client = createClient();
  const { seller, buyer } = await registerBuyerSeller(client);
  const otherBuyer = await registerBasicAgent(client, 'filtered_buyer');
  const digitalListing = await createFungibleListing(client, seller);
  const genericListing = await createFungibleListing(client, seller, {
    title: 'Generic filtered inventory',
    category: 'generic'
  });

  const filteredListings = await client.get('/v1/listings', {
    category: 'generic',
    assuranceTier: '0',
    limit: '1'
  });
  const firstOffer = await client.post('/v1/offers', {
    listingId: digitalListing.id,
    buyerAgentId: buyer.id,
    quantity: 1000,
    unitPriceUsdc: '0.008',
    assuranceAcknowledgement: true,
    expiresAt: futureIso()
  });
  await client.post('/v1/offers', {
    listingId: genericListing.id,
    buyerAgentId: otherBuyer.id,
    quantity: 1000,
    unitPriceUsdc: '0.009',
    assuranceAcknowledgement: true,
    expiresAt: futureIso()
  });
  const filteredOffers = await client.getWithHeaders('/v1/offers', otherBuyer.authHeaders, {
    buyerAgentId: otherBuyer.id,
    limit: '5',
    offset: '0'
  });
  const accepted = await client.post(`/v1/offers/${firstOffer.body.offer.id}/accept`, {
    actorAgentId: seller.id
  });
  const filteredTrades = await client.getWithHeaders('/v1/trades', buyer.authHeaders, {
    buyerAgentId: buyer.id,
    state: 'OFFER_MADE',
    limit: '5'
  });
  const invalidQuery = await client.get('/v1/listings', { limit: '101' });

  assert.equal(filteredListings.status, 200);
  assert.equal(filteredListings.body.listings.length, 1);
  assert.equal(filteredListings.body.listings[0].id, genericListing.id);
  assert.deepEqual(filteredListings.body.pagination, { limit: 1, offset: 0, returned: 1 });
  assert.equal(filteredOffers.status, 200);
  assert.equal(filteredOffers.body.offers.length, 1);
  assert.equal(filteredOffers.body.offers[0].buyerAgentId, otherBuyer.id);
  assert.equal(accepted.status, 200);
  assert.equal(filteredTrades.status, 200);
  assert.equal(filteredTrades.body.trades.some((trade) => trade.id === accepted.body.trade.id), true);
  assert.equal(invalidQuery.status, 400);
  assert.equal(invalidQuery.body.error, 'invalid_query');
});

test('private read endpoints are scoped to parties or admin', async () => {
  const client = createClient();
  const { seller, buyer } = await registerBuyerSeller(client);
  const outsider = await registerBasicAgent(client, 'read_scope_outsider');
  const listing = await createFungibleListing(client, seller);
  const offer = await client.post('/v1/offers', {
    listingId: listing.id,
    buyerAgentId: buyer.id,
    quantity: 1000,
    unitPriceUsdc: '0.010',
    assuranceAcknowledgement: true,
    expiresAt: futureIso()
  });
  const accepted = await client.post(`/v1/offers/${offer.body.offer.id}/accept`, {
    actorAgentId: seller.id
  });
  await client.post(`/v1/trades/${accepted.body.trade.id}/accept`, {
    actorAgentId: seller.id
  });

  const anonymousAgents = await client.get('/v1/agents');
  const ownAgents = await client.getWithHeaders('/v1/agents', buyer.authHeaders);
  const adminAgents = await client.adminGet('/v1/agents');
  const anonymousOffer = await client.get(`/v1/offers/${offer.body.offer.id}`);
  const outsiderOffer = await client.getWithHeaders(`/v1/offers/${offer.body.offer.id}`, outsider.authHeaders);
  const buyerOffer = await client.getWithHeaders(`/v1/offers/${offer.body.offer.id}`, buyer.authHeaders);
  const anonymousTrade = await client.get(`/v1/trades/${accepted.body.trade.id}`);
  const sellerTrades = await client.getWithHeaders('/v1/trades', seller.authHeaders);
  const anonymousEscrow = await client.get('/v1/escrow/events');
  const buyerEscrow = await client.getWithHeaders('/v1/escrow/events', buyer.authHeaders);

  assert.equal(anonymousAgents.status, 401);
  assert.equal(ownAgents.status, 200);
  assert.deepEqual(ownAgents.body.agents.map((agent) => agent.id), [buyer.id]);
  assert.equal(adminAgents.status, 200);
  assert.equal(adminAgents.body.agents.length >= 3, true);
  assert.equal(anonymousOffer.status, 401);
  assert.equal(outsiderOffer.status, 403);
  assert.equal(buyerOffer.status, 200);
  assert.equal(anonymousTrade.status, 401);
  assert.equal(sellerTrades.status, 200);
  assert.equal(sellerTrades.body.trades.some((trade) => trade.id === accepted.body.trade.id), true);
  assert.equal(anonymousEscrow.status, 401);
  assert.equal(buyerEscrow.status, 200);
  assert.equal(buyerEscrow.body.escrowEvents.some((event) => event.tradeId === accepted.body.trade.id), true);
});

test('accepting a counteroffer creates reservation and trade with partial fill', async () => {
  const client = createClient();
  const { seller, buyer } = await registerBuyerSeller(client);
  const listing = await createFungibleListing(client, seller);
  const offer = await client.post('/v1/offers', {
    listingId: listing.id,
    buyerAgentId: buyer.id,
    quantity: 2000,
    unitPriceUsdc: '0.008',
    assuranceAcknowledgement: true,
    expiresAt: futureIso()
  });
  const counter = await client.post(`/v1/offers/${offer.body.offer.id}/counter`, {
    actorAgentId: seller.id,
    quantity: 2000,
    unitPriceUsdc: '0.009',
    assuranceAcknowledgement: true,
    expiresAt: futureIso()
  });

  const accepted = await client.post(
    `/v1/offers/${counter.body.offer.id}/accept`,
    { actorAgentId: buyer.id },
    { 'idempotency-key': 'accept-counter-1' }
  );
  const reservations = await client.getWithHeaders('/v1/inventory/reservations', buyer.authHeaders);
  const market = await client.get(`/v1/listings/${listing.id}/market`);
  const fetchedTrade = await client.getWithHeaders(`/v1/trades/${accepted.body.trade.id}`, buyer.authHeaders);

  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.offer.status, 'ACCEPTED');
  assert.equal(accepted.body.reservation.quantity, 2000);
  assert.equal(accepted.body.trade.offerId, counter.body.offer.id);
  assert.equal(accepted.body.trade.priceUsdc, '18.00');
  assert.equal(reservations.body.reservations.length, 1);
  assert.equal(market.body.market.bestAsk.availableQuantity, 8000);
  assert.equal(fetchedTrade.status, 200);
  assert.equal(fetchedTrade.body.trade.id, accepted.body.trade.id);
});

test('completed trades create auditable reputation events and update scores', async () => {
  const client = createClient();
  const { seller, buyer } = await registerBuyerSeller(client);
  const listing = await createFungibleListing(client, seller);
  const offer = await client.post('/v1/offers', {
    listingId: listing.id,
    buyerAgentId: buyer.id,
    quantity: 1000,
    unitPriceUsdc: '0.010',
    assuranceAcknowledgement: true,
    expiresAt: futureIso()
  });
  const accepted = await client.post(`/v1/offers/${offer.body.offer.id}/accept`, {
    actorAgentId: seller.id
  });
  await client.post(`/v1/trades/${accepted.body.trade.id}/accept`, {
    actorAgentId: seller.id
  });
  await client.post(`/v1/trades/${accepted.body.trade.id}/deliver`, {
    actorAgentId: seller.id
  });
  await client.post(`/v1/trades/${accepted.body.trade.id}/confirm`, {
    actorAgentId: buyer.id
  });

  const sellerReputation = await client.getWithHeaders(`/v1/agents/${seller.id}/reputation`, seller.authHeaders);
  const buyerReputation = await client.getWithHeaders(`/v1/agents/${buyer.id}/reputation`, buyer.authHeaders);
  const missing = await client.adminGet('/v1/agents/agt_missing/reputation');

  assert.equal(sellerReputation.status, 200);
  assert.equal(sellerReputation.body.agent.reputationScore, 3);
  assert.equal(sellerReputation.body.reputationEvents.length, 1);
  assert.equal(sellerReputation.body.reputationEvents[0].reason, 'TRADE_CAPTURED');
  assert.equal(sellerReputation.body.reputationEvents[0].delta, 3);
  assert.equal(buyerReputation.body.agent.reputationScore, 1);
  assert.equal(buyerReputation.body.reputationEvents[0].role, 'buyer');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'agent_not_found');

  const forbiddenAudit = await client.getWithHeaders('/v1/admin/audit', {});
  const audit = await client.getWithHeaders('/v1/admin/audit', { 'x-admin-token': 'test-admin-token' });

  assert.equal(forbiddenAudit.status, 403);
  assert.equal(audit.status, 200);
  assert.equal(audit.body.totals.reputationEvents, 2);
  assert.equal(audit.body.breakdowns.tradesByState.CAPTURED, 1);
  assert.equal(audit.body.recent.reputationEvents.length, 2);
  assert.ok(audit.body.totals.auditEvents >= 1);
});

test('admin ops endpoints expose events, drilldowns, and controls', async () => {
  const client = createClient();
  const { seller, buyer } = await registerBuyerSeller(client);
  const listing = await createFungibleListing(client, seller);
  const offer = await client.post('/v1/offers', {
    listingId: listing.id,
    buyerAgentId: buyer.id,
    quantity: 1000,
    unitPriceUsdc: '0.010',
    assuranceAcknowledgement: true,
    expiresAt: futureIso()
  });

  const events = await client.adminGet('/v1/admin/events');
  const offerDetail = await client.adminGet(`/v1/admin/inspect/offers/${offer.body.offer.id}`);
  const listingDetail = await client.adminGet(`/v1/admin/inspect/listings/${listing.id}`);
  const paused = await client.adminPost(`/v1/admin/listings/${listing.id}/pause`, {
    reason: 'test pause'
  });
  const pausedOffer = await client.post('/v1/offers', {
    listingId: listing.id,
    buyerAgentId: buyer.id,
    quantity: 1000,
    unitPriceUsdc: '0.010',
    assuranceAcknowledgement: true,
    expiresAt: futureIso()
  });
  const flagged = await client.adminPost(`/v1/admin/agents/${buyer.id}/flag`, {
    reason: 'test flag'
  });
  const filteredEvents = await client.adminGet('/v1/admin/events', {
    resourceType: 'listing',
    resourceId: listing.id
  });
  const reconciliation = await client.adminGet('/v1/admin/reconciliation');
  const cleanup = await client.adminPost('/v1/maintenance/cleanup');

  assert.equal(events.status, 200);
  assert.equal(events.body.events.some((event) => event.type === 'offer.created'), true);
  assert.equal(offerDetail.status, 200);
  assert.equal(offerDetail.body.resource.id, offer.body.offer.id);
  assert.equal(offerDetail.body.events.some((event) => event.resourceId === offer.body.offer.id), true);
  assert.equal(listingDetail.status, 200);
  assert.equal(listingDetail.body.resource.id, listing.id);
  assert.equal(paused.status, 200);
  assert.equal(paused.body.listing.status, 'paused');
  assert.equal(pausedOffer.status, 409);
  assert.equal(pausedOffer.body.error, 'listing_not_tradeable');
  assert.equal(flagged.status, 200);
  assert.equal(flagged.body.agent.status, 'flagged');
  assert.equal(filteredEvents.status, 200);
  assert.equal(filteredEvents.body.events.some((event) => event.type === 'listing.paused'), true);
  assert.equal(reconciliation.status, 200);
  assert.equal(reconciliation.body.reconciliation.counts.paymentIntents >= 0, true);
  assert.equal(Array.isArray(reconciliation.body.reconciliation.findings), true);
  assert.equal(cleanup.status, 200);
  assert.equal(cleanup.body.cleanup.removedChallenges >= 0, true);
});

test('refund outcomes reduce seller reputation and clamp scores', async () => {
  const client = createClient();
  const { seller, buyer } = await registerBuyerSeller(client);
  const listing = await createFungibleListing(client, seller);
  const trade = await client.post('/v1/trades', {
    listingId: listing.id,
    buyerAgentId: buyer.id,
    quantity: 100,
    assuranceAcknowledgement: true
  });

  await client.post(`/v1/trades/${trade.body.trade.id}/accept`, {
    actorAgentId: seller.id
  });
  await client.post(`/v1/trades/${trade.body.trade.id}/refund`, {
    actorAgentId: seller.id
  });

  const sellerReputation = await client.getWithHeaders(`/v1/agents/${seller.id}/reputation`, seller.authHeaders);
  const buyerAgent = await client.getWithHeaders(`/v1/agents/${trade.body.trade.buyerAgentId}`, buyer.authHeaders);

  assert.equal(sellerReputation.body.agent.reputationScore, 0);
  assert.equal(sellerReputation.body.reputationEvents[0].reason, 'TRADE_REFUNDED');
  assert.equal(sellerReputation.body.reputationEvents[0].delta, -3);
  assert.equal(sellerReputation.body.reputationEvents[0].previousScore, 0);
  assert.equal(sellerReputation.body.reputationEvents[0].newScore, 0);
  assert.equal(buyerAgent.body.agent.reputationScore, 1);
});

test('partial fills cannot oversell available inventory', async () => {
  const client = createClient();
  const { seller, buyer } = await registerBuyerSeller(client);
  const secondBuyer = await registerBasicAgent(client, 'second_buyer');
  const listing = await createFungibleListing(client, seller, {
    totalQuantity: 1000,
    maxFillQuantity: 1000
  });

  const first = await client.post('/v1/offers', {
    listingId: listing.id,
    buyerAgentId: buyer.id,
    quantity: 800,
    unitPriceUsdc: '0.010',
    assuranceAcknowledgement: true,
    expiresAt: futureIso()
  });
  const second = await client.post('/v1/offers', {
    listingId: listing.id,
    buyerAgentId: secondBuyer.id,
    quantity: 800,
    unitPriceUsdc: '0.010',
    assuranceAcknowledgement: true,
    expiresAt: futureIso()
  });

  const acceptedFirst = await client.post(`/v1/offers/${first.body.offer.id}/accept`, {
    actorAgentId: seller.id
  });
  const acceptedSecond = await client.post(`/v1/offers/${second.body.offer.id}/accept`, {
    actorAgentId: seller.id
  });

  assert.equal(acceptedFirst.status, 200);
  assert.equal(acceptedSecond.status, 409);
  assert.equal(acceptedSecond.body.error, 'insufficient_inventory');
});

test('market data exposes best bid best ask and spread for fungible inventory', async () => {
  const client = createClient();
  const { seller, buyer } = await registerBuyerSeller(client);
  const otherBuyer = await registerBasicAgent(client, 'market_buyer');
  const listing = await createFungibleListing(client, seller);

  await client.post('/v1/offers', {
    listingId: listing.id,
    buyerAgentId: buyer.id,
    quantity: 1000,
    unitPriceUsdc: '0.007',
    assuranceAcknowledgement: true,
    expiresAt: futureIso()
  });
  await client.post('/v1/offers', {
    listingId: listing.id,
    buyerAgentId: otherBuyer.id,
    quantity: 1000,
    unitPriceUsdc: '0.0085',
    assuranceAcknowledgement: true,
    expiresAt: futureIso()
  });

  const market = await client.get(`/v1/listings/${listing.id}/market`);

  assert.equal(market.status, 200);
  assert.equal(market.body.market.bestAsk.unitPriceUsdc, '0.010');
  assert.equal(market.body.market.bestBid.unitPriceUsdc, '0.0085');
  assert.equal(market.body.market.spreadUsdc, '0.0015');
});

test('auto-accept dry run records a match without accepting the offer', async () => {
  const client = createClient();
  const { seller, buyer } = await registerBuyerSeller(client);
  const listing = await createFungibleListing(client, seller);
  const rule = await client.post(`/v1/listings/${listing.id}/auto-accept-rules`, {
    actorAgentId: seller.id,
    minUnitPriceUsdc: '0.009',
    maxQuantityPerTrade: 2000,
    maxDailyAutoAcceptedUsdc: '500.00',
    minBuyerReputation: 0,
    requiredAssuranceAcknowledgement: true,
    offerExpiresWithinSeconds: 600,
    dryRun: true,
    enabled: true
  });
  const offer = await client.post('/v1/offers', {
    listingId: listing.id,
    buyerAgentId: buyer.id,
    quantity: 1000,
    unitPriceUsdc: '0.010',
    assuranceAcknowledgement: true,
    expiresAt: futureIso()
  });

  assert.equal(rule.status, 201);
  assert.equal(offer.status, 201);
  assert.equal(offer.body.offer.status, 'OPEN');
  assert.equal(offer.body.autoAccept.matches.length, 1);
  assert.equal(offer.body.autoAccept.result, null);
});

test('auto-accept live rule creates reservation and trade', async () => {
  const client = createClient();
  const { seller, buyer } = await registerBuyerSeller(client);
  const listing = await createFungibleListing(client, seller);
  await client.post(`/v1/listings/${listing.id}/auto-accept-rules`, {
    actorAgentId: seller.id,
    minUnitPriceUsdc: '0.009',
    maxQuantityPerTrade: 2000,
    maxDailyAutoAcceptedUsdc: '500.00',
    minBuyerReputation: 0,
    requiredAssuranceAcknowledgement: true,
    offerExpiresWithinSeconds: 600,
    dryRun: false,
    enabled: true
  });
  const offer = await client.post('/v1/offers', {
    listingId: listing.id,
    buyerAgentId: buyer.id,
    quantity: 1000,
    unitPriceUsdc: '0.010',
    assuranceAcknowledgement: true,
    expiresAt: futureIso()
  });

  assert.equal(offer.status, 201);
  assert.equal(offer.body.offer.status, 'ACCEPTED');
  assert.equal(offer.body.autoAccept.result.status, 200);
  assert.equal(offer.body.autoAccept.result.body.trade.priceUsdc, '10.00');
});

test('auto-accept daily cap blocks excess matching offers', async () => {
  const client = createClient();
  const { seller, buyer } = await registerBuyerSeller(client);
  const otherBuyer = await registerBasicAgent(client, 'cap_buyer');
  const listing = await createFungibleListing(client, seller);
  await client.post(`/v1/listings/${listing.id}/auto-accept-rules`, {
    actorAgentId: seller.id,
    minUnitPriceUsdc: '0.009',
    maxQuantityPerTrade: 2000,
    maxDailyAutoAcceptedUsdc: '10.00',
    minBuyerReputation: 0,
    requiredAssuranceAcknowledgement: true,
    offerExpiresWithinSeconds: 600,
    dryRun: false,
    enabled: true
  });
  const first = await client.post('/v1/offers', {
    listingId: listing.id,
    buyerAgentId: buyer.id,
    quantity: 1000,
    unitPriceUsdc: '0.010',
    assuranceAcknowledgement: true,
    expiresAt: futureIso()
  });
  const second = await client.post('/v1/offers', {
    listingId: listing.id,
    buyerAgentId: otherBuyer.id,
    quantity: 1000,
    unitPriceUsdc: '0.010',
    assuranceAcknowledgement: true,
    expiresAt: futureIso()
  });

  assert.equal(first.body.offer.status, 'ACCEPTED');
  assert.equal(second.body.offer.status, 'OPEN');
  assert.equal(second.body.autoAccept.result, null);
});

test('non-party agents cannot mutate offers', async () => {
  const client = createClient();
  const { seller, buyer } = await registerBuyerSeller(client);
  const stranger = await registerBasicAgent(client, 'stranger');
  const listing = await createFungibleListing(client, seller);
  const offer = await client.post('/v1/offers', {
    listingId: listing.id,
    buyerAgentId: buyer.id,
    quantity: 1000,
    unitPriceUsdc: '0.008',
    assuranceAcknowledgement: true,
    expiresAt: futureIso()
  });

  const accepted = await client.post(`/v1/offers/${offer.body.offer.id}/accept`, {
    actorAgentId: stranger.id
  });
  const countered = await client.post(`/v1/offers/${offer.body.offer.id}/counter`, {
    actorAgentId: stranger.id,
    quantity: 1000,
    unitPriceUsdc: '0.009',
    assuranceAcknowledgement: true,
    expiresAt: futureIso()
  });

  assert.equal(accepted.status, 403);
  assert.equal(countered.status, 403);
});

test('expired offers cannot be accepted', async () => {
  const client = createClient();
  const { seller, buyer } = await registerBuyerSeller(client);
  const listing = await createFungibleListing(client, seller);
  const offer = await client.post('/v1/offers', {
    listingId: listing.id,
    buyerAgentId: buyer.id,
    quantity: 1000,
    unitPriceUsdc: '0.008',
    assuranceAcknowledgement: true,
    expiresAt: futureIso()
  });
  const expired = await client.post(`/v1/offers/${offer.body.offer.id}/expire`, {
    actorAgentId: buyer.id
  });
  const accepted = await client.post(`/v1/offers/${offer.body.offer.id}/accept`, {
    actorAgentId: seller.id
  });

  assert.equal(expired.status, 200);
  assert.equal(expired.body.offer.status, 'EXPIRED');
  assert.equal(accepted.status, 409);
  assert.equal(accepted.body.error, 'offer_not_open');
});

test('direct trades reserve inventory and cannot oversell fungible listings', async () => {
  const client = createClient();
  const { seller, buyer } = await registerBuyerSeller(client);
  const secondBuyer = await registerBasicAgent(client, 'direct_second_buyer');
  const listing = await createFungibleListing(client, seller, {
    totalQuantity: 1000,
    maxFillQuantity: 1000
  });

  const first = await client.post('/v1/trades', {
    listingId: listing.id,
    buyerAgentId: buyer.id,
    quantity: 800,
    unitPriceUsdc: '0.010',
    assuranceAcknowledgement: true
  });
  const second = await client.post('/v1/trades', {
    listingId: listing.id,
    buyerAgentId: secondBuyer.id,
    quantity: 800,
    unitPriceUsdc: '0.010',
    assuranceAcknowledgement: true
  });
  const market = await client.get(`/v1/listings/${listing.id}/market`);

  assert.equal(first.status, 201);
  assert.equal(first.body.reservation.quantity, 800);
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'insufficient_inventory');
  assert.equal(market.body.market.bestAsk.availableQuantity, 200);
});

test('non-party agents cannot expire offers', async () => {
  const client = createClient();
  const { seller, buyer } = await registerBuyerSeller(client);
  const stranger = await registerBasicAgent(client, 'expire_stranger');
  const listing = await createFungibleListing(client, seller);
  const offer = await client.post('/v1/offers', {
    listingId: listing.id,
    buyerAgentId: buyer.id,
    quantity: 1000,
    unitPriceUsdc: '0.008',
    assuranceAcknowledgement: true,
    expiresAt: futureIso()
  });

  const expired = await client.post(`/v1/offers/${offer.body.offer.id}/expire`, {
    actorAgentId: stranger.id
  });

  assert.equal(expired.status, 403);
  assert.equal(expired.body.error, 'trade_party_required');
});

test('http server rejects oversized JSON bodies before buffering everything', async () => {
  const previousLimit = process.env.MAX_JSON_BODY_BYTES;
  process.env.MAX_JSON_BODY_BYTES = '8';
  const server = createApp({ store: createStore() });
  const req = Readable.from([Buffer.from('{"too":"large"}')]);
  req.method = 'POST';
  req.url = '/v1/agents/register';
  req.headers = {};

  let statusCode = null;
  let payload = '';
  const res = new Writable({
    write(chunk, _encoding, callback) {
      payload += chunk.toString();
      callback();
    }
  });
  res.writeHead = (status) => {
    statusCode = status;
  };

  await new Promise((resolve) => {
    res.on('finish', resolve);
    server.emit('request', req, res);
  });

  if (previousLimit === undefined) {
    delete process.env.MAX_JSON_BODY_BYTES;
  } else {
    process.env.MAX_JSON_BODY_BYTES = previousLimit;
  }

  assert.equal(statusCode, 413);
  assert.equal(JSON.parse(payload).error, 'request_body_too_large');
});

test('http server rate limits repeated auth requests before route handling', async () => {
  const store = createStore();
  const server = createApp({
    store,
    rateLimiter: createRateLimiter({
      enabled: true,
      windowMs: 60_000,
      readMaxRequests: 100,
      writeMaxRequests: 100,
      authMaxRequests: 1
    })
  });

  async function emitRegisterRequest() {
    const req = Readable.from([Buffer.from('{"developerId":"dev_rate","name":"Rate Bot"}')]);
    req.method = 'POST';
    req.url = '/v1/agents/register';
    req.headers = { 'x-forwarded-for': '203.0.113.10' };

    let statusCode = null;
    let headers = {};
    let payload = '';
    const res = new Writable({
      write(chunk, _encoding, callback) {
        payload += chunk.toString();
        callback();
      }
    });
    res.writeHead = (status, writtenHeaders = {}) => {
      statusCode = status;
      headers = writtenHeaders;
    };

    await new Promise((resolve) => {
      res.on('finish', resolve);
      server.emit('request', req, res);
    });

    return { statusCode, headers, body: JSON.parse(payload) };
  }

  const first = await emitRegisterRequest();
  const second = await emitRegisterRequest();
  const requestLogs = store.listRequestLogs({ limit: 10 });
  const auditEvents = store.listAuditEvents({ limit: 10 });

  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 429);
  assert.equal(second.body.error, 'rate_limited');
  assert.equal(second.headers['x-ratelimit-limit'], '1');
  assert.equal(second.headers['retry-after'], '60');
  assert.equal(requestLogs.some((log) => log.status === 429 && log.errorCode === 'rate_limited'), true);
  assert.equal(auditEvents.some((event) => event.type === 'http.rate_limited'), true);
});

test('http server returns overload before flooding queued work', async () => {
  const store = createStore();
  let releaseListings = null;
  store.listListings = async () => new Promise((resolve) => {
    releaseListings = () => resolve([]);
  });
  store.listAgents = async () => [];

  const server = createApp({
    store,
    requestQueue: {
      enabled: true,
      maxConcurrent: 1,
      maxQueued: 0,
      timeoutMs: 1000
    }
  });

  async function emitSearchRequest() {
    const req = Readable.from([]);
    req.method = 'GET';
    req.url = '/v1/search';
    req.headers = { 'x-forwarded-for': '203.0.113.20' };

    let statusCode = null;
    let headers = {};
    let payload = '';
    const res = new Writable({
      write(chunk, _encoding, callback) {
        payload += chunk.toString();
        callback();
      }
    });
    res.writeHead = (status, writtenHeaders = {}) => {
      statusCode = status;
      headers = writtenHeaders;
    };

    const done = new Promise((resolve) => {
      res.on('finish', () => resolve({ statusCode, headers, body: JSON.parse(payload) }));
      server.emit('request', req, res);
    });
    return done;
  }

  const first = emitSearchRequest();
  while (!releaseListings) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const second = await emitSearchRequest();
  releaseListings();
  const completedFirst = await first;
  const requestLogs = store.listRequestLogs({ limit: 10 });
  const auditEvents = store.listAuditEvents({ limit: 10 });

  assert.equal(completedFirst.statusCode, 200);
  assert.equal(second.statusCode, 503);
  assert.equal(second.body.error, 'request_queue_overloaded');
  assert.equal(second.headers['retry-after'], '5');
  assert.equal(requestLogs.some((log) => log.status === 503 && log.errorCode === 'request_queue_overloaded'), true);
  assert.equal(auditEvents.some((event) => event.type === 'http.request_overloaded'), true);
});

test('http server serves the admin dashboard shell', async () => {
  const server = createApp({ store: createStore() });
  const req = Readable.from([]);
  req.method = 'GET';
  req.url = '/admin';
  req.headers = {};

  let statusCode = null;
  let headers = {};
  let payload = '';
  const res = new Writable({
    write(chunk, _encoding, callback) {
      payload += chunk.toString();
      callback();
    }
  });
  res.writeHead = (status, writtenHeaders = {}) => {
    statusCode = status;
    headers = writtenHeaders;
  };

  await new Promise((resolve) => {
    res.on('finish', resolve);
    server.emit('request', req, res);
  });

  assert.equal(statusCode, 200);
  assert.equal(headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['x-frame-options'], 'DENY');
  assert.match(headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(payload, /Command Console/);
});

test('cleanup maintenance is admin-only and removes used challenges', async () => {
  const client = createClient();
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const registered = await client.post('/v1/agents/register', {
    developerId: 'dev_cleanup',
    name: 'Cleanup Bot',
    publicKeyJwk: publicKey.export({ format: 'jwk' })
  });
  const challenged = await client.post(`/v1/agents/${registered.body.agent.id}/verify/challenge`, {});
  const signature = sign(null, Buffer.from(challenged.body.challenge.canonical), privateKey).toString('base64');
  await client.post(`/v1/agents/${registered.body.agent.id}/verify/response`, {
    challengeId: challenged.body.challenge.id,
    signature
  });

  const forbidden = await client.post('/v1/maintenance/cleanup', {
    actorRole: 'agent'
  });
  const cleaned = await client.adminPost('/v1/maintenance/cleanup', {
    actorRole: 'admin'
  });

  assert.equal(forbidden.status, 403);
  assert.equal(cleaned.status, 200);
  assert.equal(cleaned.body.cleanup.removedChallenges, 1);
});
