import { decodeEventLog, getAddress, keccak256, stringToHex } from 'viem';
import { X402_BASE_MAINNET_NETWORK, X402_BASE_SEPOLIA_NETWORK, usdcToAtomicAmount } from './payments.js';

export const escrowContractAbi = Object.freeze([
  {
    type: 'constructor',
    inputs: [
      { name: 'asset_', type: 'address' },
      { name: 'platformFeeRecipient_', type: 'address' },
      { name: 'arbitrator_', type: 'address' },
      { name: 'platformFeeBps_', type: 'uint16' }
    ]
  },
  {
    type: 'function',
    name: 'fund',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tradeIdHash', type: 'bytes32' },
      { name: 'tradeId', type: 'string' },
      { name: 'seller', type: 'address' },
      { name: 'amount', type: 'uint256' }
    ],
    outputs: []
  },
  {
    type: 'function',
    name: 'release',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'tradeIdHash', type: 'bytes32' }],
    outputs: []
  },
  {
    type: 'function',
    name: 'refund',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'tradeIdHash', type: 'bytes32' }],
    outputs: []
  },
  {
    type: 'function',
    name: 'escrowOf',
    stateMutability: 'view',
    inputs: [{ name: 'tradeIdHash', type: 'bytes32' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'buyer', type: 'address' },
          { name: 'seller', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'feeBps', type: 'uint16' },
          { name: 'state', type: 'uint8' }
        ]
      }
    ]
  },
  {
    type: 'event',
    name: 'EscrowFunded',
    inputs: [
      { name: 'tradeIdHash', type: 'bytes32', indexed: true },
      { name: 'tradeId', type: 'string', indexed: false },
      { name: 'buyer', type: 'address', indexed: true },
      { name: 'seller', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'feeBps', type: 'uint16', indexed: false }
    ]
  },
  {
    type: 'event',
    name: 'EscrowReleased',
    inputs: [
      { name: 'tradeIdHash', type: 'bytes32', indexed: true },
      { name: 'seller', type: 'address', indexed: true },
      { name: 'sellerAmount', type: 'uint256', indexed: false },
      { name: 'platformFee', type: 'uint256', indexed: false }
    ]
  },
  {
    type: 'event',
    name: 'EscrowRefunded',
    inputs: [
      { name: 'tradeIdHash', type: 'bytes32', indexed: true },
      { name: 'buyer', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false }
    ]
  }
]);

const rpcUrlsByNetwork = Object.freeze({
  [X402_BASE_MAINNET_NETWORK]: 'https://mainnet.base.org',
  [X402_BASE_SEPOLIA_NETWORK]: 'https://sepolia.base.org'
});

const eventNameByAction = Object.freeze({
  fund_onchain: 'EscrowFunded',
  release_onchain: 'EscrowReleased',
  refund_onchain: 'EscrowRefunded'
});

function normalizeTxHash(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return /^0x[a-f0-9]{64}$/.test(normalized) ? normalized : '';
}

function normalizeAddress(value) {
  try {
    return getAddress(String(value ?? '').trim()).toLowerCase();
  } catch {
    return '';
  }
}

function serializeEventArgs(args) {
  return Object.fromEntries(
    Object.entries(args ?? {}).map(([key, value]) => [
      key,
      typeof value === 'bigint' ? value.toString() : value
    ])
  );
}

async function rpcCall({ url, method, params, fetchFn }) {
  const response = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params
    })
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

export function escrowTradeIdHash(tradeId) {
  return keccak256(stringToHex(String(tradeId ?? '')));
}

export function escrowEventNameForAction(action) {
  return eventNameByAction[action] ?? '';
}

export async function verifyEscrowContractEvent({
  txHash,
  trade,
  action,
  contractAddress,
  network,
  amountUsdc,
  buyerAgent,
  sellerAgent,
  rpcUrl,
  fetchFn = fetch
}) {
  const normalizedTxHash = normalizeTxHash(txHash);
  const normalizedContractAddress = normalizeAddress(contractAddress);
  const eventName = escrowEventNameForAction(action);
  const url = rpcUrl || rpcUrlsByNetwork[network];

  if (!normalizedTxHash) {
    return { error: { status: 400, body: { error: 'invalid_transaction_hash' } } };
  }
  if (!normalizedContractAddress) {
    return { error: { status: 503, body: { error: 'escrow_contract_not_configured' } } };
  }
  if (!eventName) {
    return { error: { status: 400, body: { error: 'unsupported_escrow_contract_action', action } } };
  }
  if (!url) {
    return { error: { status: 503, body: { error: 'unsupported_escrow_network', network } } };
  }

  let requiredAtomic = null;
  if (action === 'fund_onchain') {
    try {
      requiredAtomic = BigInt(usdcToAtomicAmount(amountUsdc ?? trade?.priceUsdc));
    } catch (error) {
      return { error: { status: 400, body: { error: 'invalid_amount_usdc', message: error.message } } };
    }
  }

  const receiptResult = await rpcCall({
    url,
    method: 'eth_getTransactionReceipt',
    params: [normalizedTxHash],
    fetchFn
  });
  if (receiptResult.error) return receiptResult;

  const receipt = receiptResult.result;
  if (!receipt) {
    return { error: { status: 404, body: { error: 'transaction_not_found' } } };
  }
  if (receipt.status !== '0x1') {
    return { error: { status: 409, body: { error: 'transaction_not_successful', status: receipt.status } } };
  }

  const expectedTradeHash = escrowTradeIdHash(trade.id).toLowerCase();
  const expectedBuyer = normalizeAddress(buyerAgent?.walletAddress);
  const expectedSeller = normalizeAddress(sellerAgent?.walletAddress);

  for (const log of receipt.logs ?? []) {
    if (normalizeAddress(log.address) !== normalizedContractAddress) continue;

    let decoded = null;
    try {
      decoded = decodeEventLog({
        abi: escrowContractAbi,
        eventName,
        topics: log.topics,
        data: log.data
      });
    } catch {
      continue;
    }

    const args = decoded.args ?? {};
    if (String(args.tradeIdHash ?? '').toLowerCase() !== expectedTradeHash) continue;

    if (eventName === 'EscrowFunded') {
      if (args.tradeId !== trade.id) continue;
      if (requiredAtomic !== null && BigInt(args.amount) < requiredAtomic) continue;
      if (expectedBuyer && normalizeAddress(args.buyer) !== expectedBuyer) continue;
      if (expectedSeller && normalizeAddress(args.seller) !== expectedSeller) continue;
    }

    if (eventName === 'EscrowReleased' && expectedSeller && normalizeAddress(args.seller) !== expectedSeller) {
      continue;
    }
    if (eventName === 'EscrowRefunded' && expectedBuyer && normalizeAddress(args.buyer) !== expectedBuyer) {
      continue;
    }

    return {
      ok: true,
      transaction: normalizedTxHash,
      network,
      contractAddress: normalizedContractAddress,
      eventName,
      tradeId: trade.id,
      tradeIdHash: expectedTradeHash,
      amount: args.amount?.toString?.() ?? null,
      sellerAmount: args.sellerAmount?.toString?.() ?? null,
      platformFee: args.platformFee?.toString?.() ?? null,
      buyer: args.buyer ? normalizeAddress(args.buyer) : expectedBuyer || null,
      seller: args.seller ? normalizeAddress(args.seller) : expectedSeller || null,
      feeBps: args.feeBps?.toString?.() ?? null,
      blockNumber: receipt.blockNumber ?? null,
      logIndex: log.logIndex ?? null,
      eventArgs: serializeEventArgs(args)
    };
  }

  return {
    error: {
      status: 402,
      body: {
        error: 'matching_escrow_contract_event_not_found',
        txHash: normalizedTxHash,
        contractAddress: normalizedContractAddress,
        eventName,
        tradeId: trade.id,
        tradeIdHash: expectedTradeHash
      }
    }
  };
}
