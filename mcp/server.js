import readline from 'node:readline';
import { AgentExchangeClient } from '../sdk/agent-exchange-sdk.js';

const client = new AgentExchangeClient({
  baseUrl: process.env.AGENT_EXCHANGE_URL ?? 'http://localhost:8787'
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
  }
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function callTool(name, args) {
  if (name === 'agent_exchange_health') return client.health();
  if (name === 'agent_exchange_listings') return client.request('GET', '/v1/listings');
  if (name === 'agent_exchange_create_listing') return client.createListing(args);
  if (name === 'agent_exchange_create_trade') {
    const { idempotencyKey, ...body } = args;
    return client.createTrade(body, idempotencyKey);
  }
  if (name === 'agent_exchange_create_offer') {
    const { idempotencyKey, ...body } = args;
    return client.createOffer(body, idempotencyKey);
  }
  if (name === 'agent_exchange_accept_offer') {
    const { offerId, idempotencyKey, ...body } = args;
    return client.acceptOffer(offerId, body, idempotencyKey);
  }
  if (name === 'agent_exchange_get_market') return client.getMarket(args.listingId);
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
