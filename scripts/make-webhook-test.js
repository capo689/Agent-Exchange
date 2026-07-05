import { signSandboxWebhookPayload } from '../src/payments.js';

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

function hasArg(name) {
  return process.argv.includes(name);
}

const secret = process.env.PAYMENT_SANDBOX_WEBHOOK_SECRET;
const paymentIntentId = argValue('--payment-intent-id') ?? process.env.PAYMENT_INTENT_ID;
const baseUrl = (argValue('--base-url') ?? process.env.AGENT_EXCHANGE_URL ?? 'https://ax-7508.onrender.com').replace(/\/$/, '');
const eventId = argValue('--event-id') ?? `evt_hosted_positive_${Date.now()}`;
const status = argValue('--status') ?? 'SUCCEEDED';
const type = argValue('--type') ?? 'sandbox.payment_succeeded';
const shouldSend = hasArg('--send');
const shouldReplay = hasArg('--replay');

if (!secret) {
  console.error('Missing PAYMENT_SANDBOX_WEBHOOK_SECRET in your shell environment.');
  process.exit(1);
}

if (!paymentIntentId) {
  console.error('Missing --payment-intent-id or PAYMENT_INTENT_ID.');
  process.exit(1);
}

const payload = {
  eventId,
  paymentIntentId,
  status,
  type,
  payload: { test: 'hosted-positive' }
};

const body = JSON.stringify(payload);
const signature = signSandboxWebhookPayload(secret, payload);
const url = `${baseUrl}/v1/payments/sandbox/webhook`;

console.log(`curl -i -sS ${url} \\`);
console.log("  -H 'content-type: application/json' \\");
console.log(`  -H 'x-sandbox-payment-signature: sha256=${signature}' \\`);
console.log(`  --data '${body}'`);

async function sendWebhook(label) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-sandbox-payment-signature': `sha256=${signature}`
    },
    body
  });
  const text = await response.text();
  console.log(`\n${label}: HTTP ${response.status}`);
  console.log(text);
}

if (shouldSend) {
  await sendWebhook('first send');
  if (shouldReplay) {
    await sendWebhook('replay');
  }
}
