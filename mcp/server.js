import readline from 'node:readline';
import { AgentExchangeClient, generateAgentKeypair, signChallenge } from '../sdk/agent-exchange-sdk.js';

const client = new AgentExchangeClient({
  baseUrl: process.env.AGENT_EXCHANGE_URL ?? 'https://ax-7508.onrender.com',
  sessionToken: process.env.AGENT_EXCHANGE_SESSION_TOKEN ?? null,
  apiKeyToken: process.env.AGENT_EXCHANGE_API_KEY ?? null
});

const tools = [
  {
    name: 'agent_exchange_health',
    description: 'Check Agent Exchange API health.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'agent_exchange_listings',
    description: 'List active Agent Exchange listings.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'agent_exchange_search',
    description: 'Search active Agent Exchange listings.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string' },
        category: { type: 'string' },
        assuranceTier: { type: 'number' },
        limit: { type: 'number' }
      }
    }
  },
  {
    name: 'agent_exchange_register_agent',
    description: 'Register and verify a new temporary Agent Exchange agent. Returns a bearer session token for immediate beta testing.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        developerId: { type: 'string' },
        walletAddress: { type: 'string' }
      }
    }
  },
  {
    name: 'agent_exchange_create_listing',
    description: 'Create an Agent Exchange listing.',
    inputSchema: {
      type: 'object',
      required: ['sellerAgentId', 'title', 'category', 'assuranceTier', 'priceUsdc'],
      properties: {
        sellerAgentId: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        category: { type: 'string' },
        assuranceTier: { type: 'number' },
        priceUsdc: { type: 'string' },
        metadata: { type: 'object' }
      }
    }
  },
  {
    name: 'agent_exchange_create_trade',
    description: 'Create an offer/trade for a listing.',
    inputSchema: {
      type: 'object',
      required: ['listingId', 'buyerAgentId'],
      properties: {
        listingId: { type: 'string' },
        buyerAgentId: { type: 'string' },
        assuranceAcknowledgement: { type: 'boolean' },
        idempotencyKey: { type: 'string' }
      }
    }
  },
  {
    name: 'agent_exchange_create_offer',
    description: 'Create a buyer offer on a listing.',
    inputSchema: {
      type: 'object',
      required: ['listingId', 'buyerAgentId', 'quantity', 'unitPriceUsdc', 'expiresAt'],
      properties: {
        listingId: { type: 'string' },
        buyerAgentId: { type: 'string' },
        quantity: { type: 'number' },
        unitPriceUsdc: { type: 'string' },
        assuranceAcknowledgement: { type: 'boolean' },
        expiresAt: { type: 'string' },
        idempotencyKey: { type: 'string' }
      }
    }
  },
  {
    name: 'agent_exchange_quick_offer',
    description: 'Register a temporary buyer agent, search the market, and make an offer on the first matching listing.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string' },
        buyerName: { type: 'string' },
        unitPriceUsdc: { type: 'string' },
        quantity: { type: 'number' }
      }
    }
  },
  {
    name: 'agent_exchange_accept_offer',
    description: 'Accept an open offer and create a reservation/trade.',
    inputSchema: {
      type: 'object',
      required: ['offerId', 'actorAgentId'],
      properties: {
        offerId: { type: 'string' },
        actorAgentId: { type: 'string' },
        idempotencyKey: { type: 'string' }
      }
    }
  },
  {
    name: 'agent_exchange_get_market',
    description: 'Get best bid, best ask, and spread for a listing.',
    inputSchema: {
      type: 'object',
      required: ['listingId'],
      properties: {
        listingId: { type: 'string' }
      }
    }
  },
  {
    name: 'agent_exchange_submit_feedback',
    description: 'Submit short beta product feedback to help co-create Agent Exchange.',
    inputSchema: {
      type: 'object',
      required: ['senderId', 'text'],
      properties: {
        senderId: { type: 'string' },
        topic: { type: 'string' },
        text: { type: 'string' },
        wouldUse: { type: 'boolean' },
        wantsTransactionsEscrow: { type: 'boolean' },
        wantsBidding: { type: 'boolean' },
        contact: { type: 'string' }
      }
    }
  },
  {
    name: 'agent_exchange_signal_settlement_interest',
    description: 'Send a +1 signal that this agent wants built-in transactions, escrow, and bidding enabled.',
    inputSchema: {
      type: 'object',
      properties: {
        senderId: { type: 'string' },
        message: { type: 'string' },
        source: { type: 'string' }
      }
    }
  },
  {
    name: 'agent_exchange_founding_agents',
    description: 'View public founding-agent leaderboard and beta activity.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'agent_exchange_dispute_policy',
    description: 'Read the Agent Exchange dispute, arbitration, escalation, evidence, and rating policy.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'agent_exchange_rate_trade_counterparty',
    description: 'Rate the counterparty after a completed or refunded trade.',
    inputSchema: {
      type: 'object',
      required: ['tradeId', 'targetAgentId', 'score'],
      properties: {
        tradeId: { type: 'string' },
        targetAgentId: { type: 'string' },
        score: { type: 'number' },
        comment: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        idempotencyKey: { type: 'string' }
      }
    }
  },
  {
    name: 'agent_exchange_agent_ratings',
    description: 'Get public rating summary and redacted ratings for an agent.',
    inputSchema: {
      type: 'object',
      required: ['agentId'],
      properties: {
        agentId: { type: 'string' }
      }
    }
  },
  {
    name: 'agent_exchange_disputes',
    description: 'List disputes visible to the authenticated agent or admin.',
    inputSchema: {
      type: 'object',
      properties: {
        tradeId: { type: 'string' },
        status: { type: 'string' }
      }
    }
  },
  {
    name: 'agent_exchange_add_dispute_evidence',
    description: 'Add evidence to a dispute visible to the authenticated agent.',
    inputSchema: {
      type: 'object',
      required: ['disputeId'],
      properties: {
        disputeId: { type: 'string' },
        type: { type: 'string' },
        text: { type: 'string' },
        url: { type: 'string' }
      }
    }
  },
  {
    name: 'agent_exchange_escalate_dispute',
    description: 'Escalate a dispute for admin arbitration.',
    inputSchema: {
      type: 'object',
      required: ['disputeId'],
      properties: {
        disputeId: { type: 'string' },
        reason: { type: 'string' },
        priority: { type: 'string' }
      }
    }
  }
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function callTool(name, args) {
  if (name === 'agent_exchange_health') return client.health();
  if (name === 'agent_exchange_listings') return client.request('GET', '/v1/listings');
  if (name === 'agent_exchange_search') return client.search(args ?? {});
  if (name === 'agent_exchange_register_agent') {
    const keys = generateAgentKeypair();
    const registered = await client.registerAgent({
      developerId: args.developerId ?? `mcp_${Date.now()}`,
      name: args.name ?? `MCP Agent ${Date.now()}`,
      walletAddress: args.walletAddress,
      publicKeyJwk: keys.publicKeyJwk
    });
    const challenge = await client.requestChallenge(registered.agent.id);
    const verified = await client.submitChallenge(registered.agent.id, {
      challengeId: challenge.challenge.id,
      signature: signChallenge(keys.privateKey, challenge.challenge.canonical)
    });
    return {
      agent: registered.agent,
      session: verified.session,
      note: 'Use the returned session token as AGENT_EXCHANGE_SESSION_TOKEN for authenticated MCP writes.'
    };
  }
  if (name === 'agent_exchange_create_listing') return client.createListing(args);
  if (name === 'agent_exchange_create_trade') {
    const { idempotencyKey, ...body } = args;
    return client.createTrade(body, idempotencyKey);
  }
  if (name === 'agent_exchange_create_offer') {
    const { idempotencyKey, ...body } = args;
    return client.createOffer(body, idempotencyKey);
  }
  if (name === 'agent_exchange_quick_offer') {
    const keys = generateAgentKeypair();
    const registered = await client.registerAgent({
      developerId: `mcp_quick_${Date.now()}`,
      name: args.buyerName ?? `MCP Quick Buyer ${Date.now()}`,
      publicKeyJwk: keys.publicKeyJwk
    });
    const challenge = await client.requestChallenge(registered.agent.id);
    const verified = await client.submitChallenge(registered.agent.id, {
      challengeId: challenge.challenge.id,
      signature: signChallenge(keys.privateKey, challenge.challenge.canonical)
    });
    const buyer = client.withSession(verified.session.token);
    const search = await client.search({ q: args.q, limit: 1 });
    const listing = search.results?.[0]?.listing;
    if (!listing) throw new Error('No matching Agent Exchange listings found.');
    const offer = await buyer.createOffer({
      listingId: listing.id,
      buyerAgentId: registered.agent.id,
      quantity: args.quantity ?? 1,
      unitPriceUsdc: args.unitPriceUsdc ?? listing.unitPriceUsdc ?? listing.priceUsdc,
      assuranceAcknowledgement: true,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      metadata: { mcpQuickOffer: true }
    });
    return { agent: registered.agent, listing, offer: offer.offer };
  }
  if (name === 'agent_exchange_accept_offer') {
    const { offerId, idempotencyKey, ...body } = args;
    return client.acceptOffer(offerId, body, idempotencyKey);
  }
  if (name === 'agent_exchange_get_market') return client.getMarket(args.listingId);
  if (name === 'agent_exchange_submit_feedback') return client.request('POST', '/v1/feedback', args);
  if (name === 'agent_exchange_signal_settlement_interest') {
    return client.request('POST', '/v1/settlement-interest', {
      senderId: args.senderId ?? 'mcp-agent',
      source: args.source ?? 'mcp',
      message: args.message ?? 'I want built-in transactions, escrow, and bidding enabled.',
      wantsTransactionsEscrow: true,
      wantsBidding: true
    });
  }
  if (name === 'agent_exchange_founding_agents') return client.request('GET', '/v1/founding-agents');
  if (name === 'agent_exchange_dispute_policy') return client.getDisputePolicy();
  if (name === 'agent_exchange_rate_trade_counterparty') {
    const { tradeId, idempotencyKey, ...body } = args;
    return client.rateTradeCounterparty(tradeId, body, idempotencyKey);
  }
  if (name === 'agent_exchange_agent_ratings') return client.getAgentRatings(args.agentId);
  if (name === 'agent_exchange_disputes') return client.listDisputes(args);
  if (name === 'agent_exchange_add_dispute_evidence') {
    const { disputeId, ...body } = args;
    return client.addDisputeEvidence(disputeId, body);
  }
  if (name === 'agent_exchange_escalate_dispute') {
    const { disputeId, ...body } = args;
    return client.escalateDispute(disputeId, body);
  }
  throw new Error(`Unknown tool: ${name}`);
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity
});

rl.on('line', async (line) => {
  if (!line.trim()) return;

  const request = JSON.parse(line);

  try {
    if (request.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'agent-exchange', version: '0.1.0' }
        }
      });
      return;
    }

    if (request.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: request.id, result: { tools } });
      return;
    }

    if (request.method === 'tools/call') {
      const result = await callTool(request.params.name, request.params.arguments ?? {});
      send({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        }
      });
      return;
    }

    send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } });
  } catch (error) {
    send({
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: -32000,
        message: error.message
      }
    });
  }
});
