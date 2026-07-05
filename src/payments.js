import { createHmac, timingSafeEqual } from 'node:crypto';

export const X402_BASE_SEPOLIA_NETWORK = 'eip155:84532';
export const X402_BASE_MAINNET_NETWORK = 'eip155:8453';

export const x402UsdcAssets = Object.freeze({
  [X402_BASE_SEPOLIA_NETWORK]: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  [X402_BASE_MAINNET_NETWORK]: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
});

export const paymentStatuses = Object.freeze({
  pending: 'PENDING',
  succeeded: 'SUCCEEDED',
  declined: 'DECLINED',
  failed: 'FAILED'
});

export const paymentActionsByEscrowType = Object.freeze({
  AUTHORIZE_STUB: 'AUTHORIZE',
  CAPTURE_STUB: 'CAPTURE',
  REFUND_STUB: 'REFUND',
  SMART_CONTRACT_FUND: 'AUTHORIZE',
  SMART_CONTRACT_RELEASE: 'CAPTURE',
  SMART_CONTRACT_REFUND: 'REFUND'
});

export function paymentActionForEscrowType(escrowType) {
  return paymentActionsByEscrowType[escrowType] ?? null;
}

export function sandboxStatusForOutcome(outcome = 'succeeded') {
  if (outcome === 'declined') return paymentStatuses.declined;
  if (outcome === 'failed') return paymentStatuses.failed;
  if (outcome === 'pending') return paymentStatuses.pending;
  return paymentStatuses.succeeded;
}

export function isTerminalPaymentStatus(status) {
  return [paymentStatuses.succeeded, paymentStatuses.declined, paymentStatuses.failed].includes(status);
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function signSandboxWebhookPayload(secret, payload) {
  return createHmac('sha256', secret).update(canonicalJson(payload)).digest('hex');
}

export function verifySandboxWebhookSignature({ secret, payload, signature }) {
  if (!secret || !signature) return false;
  const normalized = String(signature).replace(/^sha256=/i, '');
  const expected = signSandboxWebhookPayload(secret, payload);
  const actualBuffer = Buffer.from(normalized, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function usdcToAtomicAmount(amountUsdc) {
  const value = String(amountUsdc ?? '').trim();
  const match = value.match(/^(\d+)(?:\.(\d{1,6})?)?$/);
  if (!match) {
    throw new Error('amountUsdc must be a positive USDC decimal string with at most 6 decimal places');
  }

  const whole = BigInt(match[1]);
  const fractional = BigInt((match[2] ?? '').padEnd(6, '0'));
  const atomic = whole * 1_000_000n + fractional;
  if (atomic <= 0n) throw new Error('amountUsdc must be greater than 0');
  return atomic.toString();
}

export function x402AssetForNetwork(network) {
  return x402UsdcAssets[network] ?? '';
}

export function buildX402PaymentRequirements({ amountUsdc, x402 }) {
  if (!x402?.payTo) throw new Error('X402_PAY_TO must be configured before x402 payments can run');
  const network = x402.network ?? X402_BASE_SEPOLIA_NETWORK;
  const asset = x402.asset ?? x402AssetForNetwork(network);
  if (!asset) throw new Error(`No default USDC asset configured for x402 network ${network}`);

  return {
    scheme: x402.scheme ?? 'exact',
    network,
    asset,
    amount: usdcToAtomicAmount(amountUsdc),
    payTo: x402.payTo,
    maxTimeoutSeconds: x402.maxTimeoutSeconds ?? 60,
    extra: {
      name: 'USDC',
      version: '2'
    }
  };
}

export function parseX402PaymentPayload(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;

  try {
    return JSON.parse(value);
  } catch {
    try {
      return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    } catch {
      try {
        return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
      } catch {
        return null;
      }
    }
  }
}

async function facilitatorPost({ url, token, path, body, fetchFn }) {
  const response = await fetchFn(`${url.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  return { ok: response.ok, status: response.status, payload };
}

export async function settleX402Payment({
  paymentPayload,
  paymentRequirements,
  x402,
  fetchFn = fetch
}) {
  if (!paymentPayload) {
    return {
      ok: false,
      status: 402,
      error: 'x402_payment_required',
      paymentRequirements
    };
  }

  if (x402?.facilitatorRequiresAuth && !x402?.facilitatorBearerToken) {
    return {
      ok: false,
      status: 503,
      error: 'x402_facilitator_auth_required',
      paymentRequirements
    };
  }

  const requestBody = {
    x402Version: paymentPayload.x402Version ?? 2,
    paymentPayload,
    paymentRequirements
  };
  const verify = await facilitatorPost({
    url: x402.facilitatorUrl,
    token: x402.facilitatorBearerToken,
    path: '/verify',
    body: requestBody,
    fetchFn
  });

  if (!verify.ok || verify.payload?.isValid !== true) {
    return {
      ok: false,
      status: verify.status === 200 ? 402 : verify.status,
      error: 'x402_payment_verification_failed',
      verify: verify.payload,
      paymentRequirements
    };
  }

  const settle = await facilitatorPost({
    url: x402.facilitatorUrl,
    token: x402.facilitatorBearerToken,
    path: '/settle',
    body: requestBody,
    fetchFn
  });

  if (!settle.ok || settle.payload?.success !== true) {
    return {
      ok: false,
      status: settle.status === 200 ? 402 : settle.status,
      error: 'x402_payment_settlement_failed',
      verify: verify.payload,
      settle: settle.payload,
      paymentRequirements
    };
  }

  return {
    ok: true,
    payer: settle.payload.payer ?? verify.payload.payer ?? null,
    transaction: settle.payload.transaction,
    network: settle.payload.network,
    amount: settle.payload.amount ?? paymentRequirements.amount,
    verify: verify.payload,
    settle: settle.payload,
    paymentRequirements
  };
}
