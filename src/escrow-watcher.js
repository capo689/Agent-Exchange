import { createHash } from 'node:crypto';
import { decodeEventLog, getAddress } from 'viem';
import { escrowContractAbi, escrowTradeIdHash } from './escrow-contract.js';
import { usdcToAtomicAmount } from './payments.js';

const rpcUrlsByNetwork = Object.freeze({
  'eip155:8453': 'https://mainnet.base.org',
  'eip155:84532': 'https://sepolia.base.org'
});

const actionByEventName = Object.freeze({
  EscrowFunded: 'fund_onchain',
  EscrowReleased: 'release_onchain',
  EscrowRefunded: 'refund_onchain'
});

function normalizeAddress(value) {
  try {
    return getAddress(String(value ?? '').trim()).toLowerCase();
  } catch {
    return '';
  }
}

function hexBlock(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string' && value.startsWith('0x')) return value;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) return null;
  return `0x${number.toString(16)}`;
}

function blockNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.startsWith('0x')) return Number.parseInt(value, 16);
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function serializableArgs(args = {}) {
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => [key, typeof value === 'bigint' ? value.toString() : value])
  );
}

async function rpcCall({ url, method, params, fetchFn }) {
  const response = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  if (!response.ok || payload?.error) {
    return {
      error: {
        status: response.status || 502,
        body: {
          error: 'base_rpc_error',
          rpcError: payload?.error ?? payload
        }
      }
    };
  }
  return { result: payload?.result ?? null };
}

export async function getEscrowWatcherStatus({ config, fetchFn = fetch }) {
  const escrow = config.payment.escrowContract;
  const rpcUrl = escrow.rpcUrl || rpcUrlsByNetwork[escrow.network];
  const status = {
    configured: Boolean(escrow.configured && rpcUrl),
    contractConfigured: escrow.configured,
    rpcConfigured: Boolean(rpcUrl),
    network: escrow.network,
    contractAddress: escrow.address || '',
    latestBlock: null
  };
  if (!status.configured) return status;

  const latest = await rpcCall({ url: rpcUrl, method: 'eth_blockNumber', params: [], fetchFn });
  if (latest.error) return { ...status, error: latest.error.body };
  return { ...status, latestBlock: blockNumber(latest.result) };
}

function decodeEscrowLog(log) {
  try {
    const decoded = decodeEventLog({
      abi: escrowContractAbi,
      topics: log.topics ?? [],
      data: log.data ?? '0x'
    });
    if (!actionByEventName[decoded.eventName]) return null;
    return decoded;
  } catch {
    return null;
  }
}

function eventAuditId({ network, log, eventName }) {
  const basis = [
    'escrow_watcher',
    network,
    String(log.transactionHash ?? '').toLowerCase(),
    String(log.logIndex ?? '').toLowerCase(),
    eventName
  ].join(':');
  return `aud_watch_${createHash('sha256').update(basis).digest('hex').slice(0, 48)}`;
}

function eventIdentity(log) {
  return {
    transactionHash: String(log.transactionHash ?? '').toLowerCase(),
    blockNumber: blockNumber(log.blockNumber),
    logIndex: blockNumber(log.logIndex)
  };
}

function inspectDecodedEvent({ decoded, log, trade, buyerAgent, sellerAgent }) {
  const args = decoded.args ?? {};
  const expectedHash = trade ? escrowTradeIdHash(trade.id).toLowerCase() : String(args.tradeIdHash ?? '').toLowerCase();
  const details = {
    eventName: decoded.eventName,
    action: actionByEventName[decoded.eventName],
    tradeIdHash: String(args.tradeIdHash ?? '').toLowerCase(),
    eventArgs: serializableArgs(args),
    ...eventIdentity(log)
  };
  const errors = [];

  if (!trade) return { severity: 'warn', code: 'escrow_watcher_unmatched_event', details };
  if (details.tradeIdHash !== expectedHash) errors.push('trade hash does not match trade id');

  const expectedBuyer = normalizeAddress(buyerAgent?.walletAddress);
  const expectedSeller = normalizeAddress(sellerAgent?.walletAddress);
  if (decoded.eventName === 'EscrowFunded') {
    if (args.tradeId !== trade.id) errors.push('fund event tradeId does not match');
    if (expectedBuyer && normalizeAddress(args.buyer) !== expectedBuyer) errors.push('fund event buyer does not match');
    if (expectedSeller && normalizeAddress(args.seller) !== expectedSeller) errors.push('fund event seller does not match');
    try {
      if (BigInt(args.amount) < BigInt(usdcToAtomicAmount(trade.priceUsdc))) {
        errors.push('fund event amount is below trade price');
      }
    } catch {
      errors.push('fund event amount could not be compared');
    }
  }
  if (decoded.eventName === 'EscrowReleased' && expectedSeller && normalizeAddress(args.seller) !== expectedSeller) {
    errors.push('release event seller does not match');
  }
  if (decoded.eventName === 'EscrowRefunded' && expectedBuyer && normalizeAddress(args.buyer) !== expectedBuyer) {
    errors.push('refund event buyer does not match');
  }

  const stateWarnings = [];
  if (decoded.eventName === 'EscrowFunded' && !['OFFER_MADE', 'FUNDED'].includes(trade.state)) {
    stateWarnings.push(`fund event observed while trade is ${trade.state}`);
  }
  if (decoded.eventName === 'EscrowReleased' && !['DELIVERED', 'CAPTURED'].includes(trade.state)) {
    stateWarnings.push(`release event observed while trade is ${trade.state}`);
  }
  if (decoded.eventName === 'EscrowRefunded' && !['FUNDED', 'DELIVERED', 'DISPUTED', 'REFUNDED'].includes(trade.state)) {
    stateWarnings.push(`refund event observed while trade is ${trade.state}`);
  }

  if (errors.length > 0) {
    return {
      severity: 'error',
      code: 'escrow_watcher_conflicting_event',
      details: { ...details, tradeId: trade.id, tradeState: trade.state, errors }
    };
  }
  if (stateWarnings.length > 0) {
    return {
      severity: 'warn',
      code: 'escrow_watcher_state_warning',
      details: { ...details, tradeId: trade.id, tradeState: trade.state, warnings: stateWarnings }
    };
  }
  return {
    severity: 'info',
    code: 'escrow_watcher_event_observed',
    details: { ...details, tradeId: trade.id, tradeState: trade.state }
  };
}

export async function runEscrowWatcher({
  store,
  config,
  fromBlock,
  toBlock,
  lookbackBlocks = 500,
  fetchFn = fetch
}) {
  const escrow = config.payment.escrowContract;
  const rpcUrl = escrow.rpcUrl || rpcUrlsByNetwork[escrow.network];
  if (!escrow.configured || !rpcUrl) {
    return {
      error: {
        status: 503,
        body: {
          error: 'escrow_watcher_not_configured',
          contractConfigured: escrow.configured,
          rpcConfigured: Boolean(rpcUrl)
        }
      }
    };
  }

  const latest = await rpcCall({ url: rpcUrl, method: 'eth_blockNumber', params: [], fetchFn });
  if (latest.error) return latest;
  const latestBlock = blockNumber(latest.result);
  const resolvedToBlock = blockNumber(toBlock) ?? latestBlock;
  const resolvedFromBlock = Math.max(0, blockNumber(fromBlock) ?? (resolvedToBlock - lookbackBlocks));

  const logsResult = await rpcCall({
    url: rpcUrl,
    method: 'eth_getLogs',
    params: [{
      address: escrow.address,
      fromBlock: hexBlock(resolvedFromBlock),
      toBlock: hexBlock(resolvedToBlock)
    }],
    fetchFn
  });
  if (logsResult.error) return logsResult;

  const [trades, agents] = await Promise.all([
    store.listTrades({ limit: 10000, offset: 0 }),
    store.listAgents()
  ]);
  const tradesByHash = new Map(trades.map((trade) => [escrowTradeIdHash(trade.id).toLowerCase(), trade]));
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const observed = [];

  for (const log of logsResult.result ?? []) {
    const decoded = decodeEscrowLog(log);
    if (!decoded) continue;
    const tradeHash = String(decoded.args?.tradeIdHash ?? '').toLowerCase();
    const trade = tradesByHash.get(tradeHash) ?? null;
    const inspection = inspectDecodedEvent({
      decoded,
      log,
      trade,
      buyerAgent: trade ? agentsById.get(trade.buyerAgentId) : null,
      sellerAgent: trade ? agentsById.get(trade.sellerAgentId) : null
    });
    const auditEvent = await store.recordAuditEvent({
      id: eventAuditId({ network: escrow.network, log, eventName: decoded.eventName }),
      type: inspection.code.replaceAll('_', '.'),
      severity: inspection.severity,
      resourceType: trade ? 'trade' : 'escrow_contract',
      resourceId: trade?.id ?? escrow.address,
      payload: {
        network: escrow.network,
        contractAddress: escrow.address,
        fromBlock: resolvedFromBlock,
        toBlock: resolvedToBlock,
        ...inspection.details
      }
    });
    observed.push({
      type: auditEvent.type,
      severity: auditEvent.severity,
      resourceType: auditEvent.resourceType,
      resourceId: auditEvent.resourceId,
      payload: auditEvent.payload
    });
  }

  return {
    ok: observed.every((event) => event.severity !== 'error'),
    network: escrow.network,
    contractAddress: escrow.address,
    fromBlock: resolvedFromBlock,
    toBlock: resolvedToBlock,
    latestBlock,
    logsScanned: (logsResult.result ?? []).length,
    eventsObserved: observed.length,
    errors: observed.filter((event) => event.severity === 'error').length,
    warnings: observed.filter((event) => event.severity === 'warn').length,
    events: observed
  };
}
