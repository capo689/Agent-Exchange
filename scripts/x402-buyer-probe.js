import { ExactEvmScheme, toClientEvmSigner } from '@x402/evm';
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from '@x402/fetch';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

const baseUrl = (process.env.AGENT_EXCHANGE_URL ?? 'https://ax-7508.onrender.com').replace(/\/$/, '');
const amountUsdc = process.env.X402_PROBE_AMOUNT_USDC ?? '0.01';
const privateKey = process.env.EVM_PRIVATE_KEY ?? process.env.X402_BUYER_PRIVATE_KEY;
const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL;

if (!privateKey) {
  console.error('Missing EVM_PRIVATE_KEY or X402_BUYER_PRIVATE_KEY in your local shell.');
  console.error('Use a throwaway funded Base Sepolia buyer wallet. Do not put this key in Render.');
  process.exit(1);
}

const account = privateKeyToAccount(privateKey);
const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(rpcUrl)
});
const signer = toClientEvmSigner(account, publicClient);
const client = new x402Client().register('eip155:84532', new ExactEvmScheme(signer));
const fetchWithPayment = wrapFetchWithPayment(fetch, client);
const probeUrl = `${baseUrl}/v1/payments/x402/probe?amountUsdc=${encodeURIComponent(amountUsdc)}`;

console.log(JSON.stringify({
  event: 'x402_probe_start',
  baseUrl,
  probeUrl,
  buyerAddress: account.address,
  amountUsdc
}, null, 2));

const response = await fetchWithPayment(probeUrl);
const text = await response.text();
let payload = null;
try {
  payload = text ? JSON.parse(text) : null;
} catch {
  payload = { raw: text };
}

const paymentResponseHeader =
  response.headers.get('PAYMENT-RESPONSE') ??
  response.headers.get('X-PAYMENT-RESPONSE');
const paymentResponse = paymentResponseHeader
  ? decodePaymentResponseHeader(paymentResponseHeader)
  : null;

console.log(JSON.stringify({
  event: 'x402_probe_result',
  status: response.status,
  ok: response.ok,
  paymentResponse,
  body: payload
}, null, 2));

if (!response.ok) {
  process.exit(1);
}
