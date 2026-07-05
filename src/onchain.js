import { usdcToAtomicAmount, X402_BASE_MAINNET_NETWORK, X402_BASE_SEPOLIA_NETWORK } from './payments.js';

const transferEventTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const rpcUrlsByNetwork = Object.freeze({
  [X402_BASE_MAINNET_NETWORK]: 'https://mainnet.base.org',
  [X402_BASE_SEPOLIA_NETWORK]: 'https://sepolia.base.org'
});

function normalizeAddress(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(normalized) ? normalized : '';
}

function normalizeTxHash(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return /^0x[a-f0-9]{64}$/.test(normalized) ? normalized : '';
}

function addressFromTopic(topic) {
  const value = String(topic ?? '').toLowerCase();
  if (!/^0x[a-f0-9]{64}$/.test(value)) return '';
  return `0x${value.slice(-40)}`;
}

function atomicFromHex(hex) {
  const value = String(hex ?? '').trim();
  if (!/^0x[a-fA-F0-9]+$/.test(value)) return null;
  return BigInt(value);
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

export async function verifyOnchainUsdcTransfer({
  txHash,
  amountUsdc,
  payer,
  payTo,
  asset,
  network,
  rpcUrl,
  fetchFn = fetch
}) {
  const normalizedTxHash = normalizeTxHash(txHash);
  const normalizedPayTo = normalizeAddress(payTo);
  const normalizedAsset = normalizeAddress(asset);
  const normalizedPayer = payer ? normalizeAddress(payer) : '';
  const url = rpcUrl || rpcUrlsByNetwork[network];

  if (!normalizedTxHash) {
    return { error: { status: 400, body: { error: 'invalid_transaction_hash' } } };
  }
  if (!normalizedPayTo || !normalizedAsset) {
    return { error: { status: 503, body: { error: 'manual_usdc_not_configured' } } };
  }
  if (payer && !normalizedPayer) {
    return { error: { status: 400, body: { error: 'invalid_payer_address' } } };
  }
  if (!url) {
    return { error: { status: 503, body: { error: 'unsupported_manual_usdc_network', network } } };
  }

  let requiredAtomic;
  try {
    requiredAtomic = BigInt(usdcToAtomicAmount(amountUsdc));
  } catch (error) {
    return { error: { status: 400, body: { error: 'invalid_amount_usdc', message: error.message } } };
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

  for (const log of receipt.logs ?? []) {
    const topics = log.topics ?? [];
    if (normalizeAddress(log.address) !== normalizedAsset) continue;
    if (String(topics[0] ?? '').toLowerCase() !== transferEventTopic) continue;

    const from = addressFromTopic(topics[1]);
    const to = addressFromTopic(topics[2]);
    const value = atomicFromHex(log.data);
    if (!from || !to || value === null) continue;
    if (to !== normalizedPayTo) continue;
    if (normalizedPayer && from !== normalizedPayer) continue;
    if (value < requiredAtomic) continue;

    return {
      ok: true,
      transaction: normalizedTxHash,
      network,
      asset: normalizedAsset,
      payer: from,
      payTo: to,
      amount: value.toString(),
      requiredAmount: requiredAtomic.toString(),
      blockNumber: receipt.blockNumber ?? null,
      logIndex: log.logIndex ?? null
    };
  }

  return {
    error: {
      status: 402,
      body: {
        error: 'matching_usdc_transfer_not_found',
        txHash: normalizedTxHash,
        payTo: normalizedPayTo,
        asset: normalizedAsset,
        requiredAmount: requiredAtomic.toString()
      }
    }
  };
}
