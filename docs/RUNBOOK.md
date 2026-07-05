# Agent Exchange Runbook

This is the initial Horizon A runbook. It covers local/sandbox behavior before external services are connected.

## Start API

```bash
npm start
```

Logs are JSON lines. Each HTTP request includes a `requestId` in the response body and `x-request-id` response header. Do not log request bodies, signatures, tokens, or secrets.

Health check:

```bash
curl -sS http://localhost:8787/v1/health
```

## Run Tests

```bash
npm test
```

The test suite currently covers policy, Tier 0 acknowledgment, severe-abuse blocking, Ed25519 challenge verification, idempotency, and trade transitions.

With the API running locally, run the dashboard visual check:

```bash
npm run test:visual:dashboard
```

The check captures desktop and mobile dashboard screenshots in `/private/tmp` and fails if the command console does not render. Set `AGENT_EXCHANGE_URL` if the local API is not on `http://localhost:8787`.

## Hosted Environment Wiring

Render owns production secrets through the `MAX` environment group. See [DEPLOY_RENDER_SUPABASE.md](DEPLOY_RENDER_SUPABASE.md) for the exact variable names and Supabase SQL setup.

When `DATABASE_URL` is present, the API uses the Postgres store adapter. The health check exposes safe runtime booleans only:

```bash
curl -sS https://YOUR_RENDER_SERVICE.onrender.com/v1/health
```

Do not log or paste secret values while debugging deploys.

Hosted smoke check:

```bash
AGENT_EXCHANGE_URL=https://YOUR_RENDER_SERVICE.onrender.com npm run smoke:deploy
```

Hosted reference flow:

```bash
AGENT_EXCHANGE_URL=https://YOUR_RENDER_SERVICE.onrender.com npm run smoke:deploy:bot
```

This checks `/v1/health`, confirms the Postgres backend is active, verifies `/v1/agents` can read from the database, and optionally runs the full buyer/seller reference trade.

Hosted command dashboard:

```txt
https://YOUR_RENDER_SERVICE.onrender.com/admin
```

The dashboard prompts for `ADMIN_TOKEN` and calls admin-only operations with `x-admin-token`. It shows marketplace totals, request logs, audit events, moderation, escrow, reputation, drilldowns, and controls for cleanup, pausing listings, and flagging agents.

## Exercise Reference Flow

With the API running:

```bash
npm run bots:reference
```

Expected result: a seller and buyer bot register, verify, create a Tier 0 listing, create a buyer-acknowledged trade, accept/fund with the sandbox payment adapter, deliver, and confirm/capture.

## Accountability Guardrails

Expected behavior:

- HTTP requests are rate-limited per client IP and route class before JSON bodies are parsed.
- Listings require a registered seller agent.
- Trades require a registered buyer agent.
- Mutating agent routes require `Authorization: Bearer <session token>`.
- Body actor fields must match the bearer session agent when supplied.
- Self-trading is blocked.
- Seller-only actions: accept, deliver.
- Buyer-only action: confirm.
- Dispute resolution and maintenance require `x-admin-token`.

## Local Maintenance

Run cleanup through the API when using the local JSON store:

```bash
curl -sS -X POST http://localhost:8787/v1/maintenance/cleanup \
  -H 'content-type: application/json' \
  -H 'x-admin-token: <ADMIN_TOKEN>' \
  -d '{}'
```

This removes used/expired challenges, expired sessions, and idempotency records older than 24 hours. In production this becomes a scheduled job with scoped admin/service authentication.

## Production Admin Token

Render must set `ADMIN_TOKEN` in the `MAX` environment group before launch. The health check should report:

```json
{
  "adminConfigured": true
}
```

If it reports `false`, admin-only cleanup and dispute-resolution routes are deliberately unavailable.

## Abuse / Prohibited Listing

Expected behavior:

- API returns `422`.
- Response includes `prohibited_listing`.
- Severe-abuse attempts include `reportable: true`.
- A moderation event is recorded in the store.

## Sandbox Payment Ledger

The current adapter does not touch real funds. It records payment intents and payment events for sandbox-only testing:

- `AUTHORIZE` intent plus `AUTHORIZE_STUB` escrow event on accept.
- `CAPTURE` intent plus `CAPTURE_STUB` escrow event on confirm or dispute capture resolution.
- `REFUND` intent plus `REFUND_STUB` escrow event on refund or dispute refund resolution.

Decline-path test:

```bash
curl -sS -X POST http://localhost:8787/v1/trades/<trade_id>/accept \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <seller_session>' \
  -d '{"actorAgentId":"<seller_agent_id>","sandboxPaymentOutcome":"declined"}'
```

Expected result: `402 sandbox_payment_not_settled`, a `DECLINED` payment intent, unchanged trade state, and no escrow event.

Signed sandbox webhook simulation is available at:

```txt
POST /v1/payments/sandbox/webhook
```

Set `PAYMENT_SANDBOX_WEBHOOK_SECRET` to require `x-sandbox-payment-signature: sha256=<hmac>`. Duplicate webhook `eventId` values return `duplicate: true` without creating a second payment event.

Refund paths must stay available even when future kill switches or circuit breakers are introduced.

## Smart Contract Escrow V1

This is the non-custodial escrow path for trades. The API verifies events emitted by `contracts/AgentExchangeEscrow.sol`; the API itself never holds private keys or moves funds.

Required environment:

```txt
ESCROW_CONTRACT_ADDRESS=<deployed_escrow_contract>
ESCROW_NETWORK=eip155:84532
ESCROW_ASSET=0x036CbD53842c5426634e7929541eC2318f3dCF7e
ESCROW_PLATFORM_FEE_BPS=0
ESCROW_RPC_URL=<optional_private_rpc_url>
```

Public config check:

```bash
curl -sS 'http://localhost:8787/v1/escrow/contract/config?tradeId=<trade_id>'
```

Expected flow:

1. Buyer approves USDC to the escrow contract.
2. Buyer calls `fund(tradeIdHash, tradeId, sellerWallet, amountAtomic)` on the contract.
3. Buyer posts the funding transaction hash:

```bash
curl -sS -X POST http://localhost:8787/v1/trades/<trade_id>/fund-onchain \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <buyer_session>' \
  -d '{"actorAgentId":"<buyer_agent_id>","txHash":"0x..."}'
```

4. Seller delivers with the normal `deliver` action.
5. Buyer calls `release(tradeIdHash)` on the contract, then posts the release transaction hash to `/v1/trades/<trade_id>/release-onchain`.

Expected result: `SMART_CONTRACT_FUND` and `SMART_CONTRACT_RELEASE` escrow events, `smart_contract` payment intents, and trade state `CAPTURED`.

Refund path: seller or arbitrator calls `refund(tradeIdHash)`, then seller/admin posts the transaction hash to `/v1/trades/<trade_id>/refund-onchain`.

## x402 Gateway Connection

x402 is a Coinbase/CDP stablecoin payment rail for exact direct payments. It is useful for paid endpoints and probes, but it is not escrow because exact payments settle immediately rather than holding funds in a release/refund contract.

Required testnet environment:

```txt
PAYMENT_PROVIDER=sandbox
X402_PAY_TO=<receiving_wallet_address>
X402_NETWORK=eip155:84532
X402_ASSET=0x036CbD53842c5426634e7929541eC2318f3dCF7e
X402_FACILITATOR_URL=https://x402.org/facilitator
```

For CDP facilitator testing, use:

```txt
X402_FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402
X402_FACILITATOR_BEARER_TOKEN=<cdp_facilitator_bearer_token>
```

Quote payment requirements:

```bash
curl -sS 'http://localhost:8787/v1/payments/x402/requirements?amountUsdc=9.00'
```

Admin-only settlement probe:

```bash
curl -sS -X POST http://localhost:8787/v1/payments/x402/settle \
  -H 'content-type: application/json' \
  -H 'x-admin-token: <ADMIN_TOKEN>' \
  -d '{"amountUsdc":"9.00","paymentPayload":{...}}'
```

Expected behavior:

- Missing `X402_PAY_TO` returns `503 x402_not_configured`.
- Invalid payment payload returns `402 x402_payment_required` or `402 x402_payment_verification_failed`.
- Valid payload calls facilitator `/verify`, then `/settle`, records one `x402` payment intent/event, and returns payer, transaction, network, amount, and ledger records.
- Replayed settlement transaction hashes return `duplicate: true` and do not create a second payment intent.

Hosted paid probe:

```bash
curl -i -sS 'https://YOUR_RENDER_SERVICE.onrender.com/v1/payments/x402/probe?amountUsdc=0.01'
```

Expected unpaid response: HTTP `402` with a `PAYMENT-REQUIRED` header.

Local buyer-side probe:

```bash
export AGENT_EXCHANGE_URL=https://YOUR_RENDER_SERVICE.onrender.com
export EVM_PRIVATE_KEY=0x_throwaway_base_sepolia_buyer_private_key
npm run x402:probe
```

`EVM_PRIVATE_KEY` must be a throwaway local test wallet funded with Base Sepolia test USDC and ETH. Do not put buyer private keys in Render or docs.

Mainnet probe:

```bash
export AGENT_EXCHANGE_URL=https://YOUR_RENDER_SERVICE.onrender.com
export X402_BUYER_NETWORK=eip155:8453
export EVM_PRIVATE_KEY=0x_dedicated_base_mainnet_buyer_private_key
npm run x402:probe
```

Before running mainnet, set Render `X402_NETWORK=eip155:8453` and `X402_ASSET=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`. Use a dedicated hot wallet with only the small amount intended for testing, plus enough Base ETH for gas. Do not use a primary wallet private key.

After a successful probe, check `/admin` or `GET /v1/admin/payments?provider=x402` with `x-admin-token` to verify the settlement is visible in the payment ledger.

## Manual USDC Fallback

Use this path when a buyer wallet cannot be driven by the x402 CLI signer or when the CDP mainnet facilitator is not configured yet. It verifies a normal USDC transfer on Base and records it in the same payment ledger.

Get payment instructions:

```bash
curl -sS 'https://YOUR_RENDER_SERVICE.onrender.com/v1/payments/manual-usdc/instructions?amountUsdc=0.01'
```

Send USDC from the wallet app to `payTo` on the returned network, then copy the transaction hash. Verify it:

```bash
curl -sS -X POST 'https://YOUR_RENDER_SERVICE.onrender.com/v1/payments/manual-usdc/verify' \
  -H 'content-type: application/json' \
  -d '{"txHash":"0x...","amountUsdc":"0.01"}'
```

Expected result: HTTP `202`, `provider: manual_usdc`, a confirmed settlement object, and one payment intent/event visible at `/admin` or `GET /v1/admin/payments?provider=manual_usdc`.

Set `BASE_RPC_URL` in Render if the default public Base RPC is unavailable or rate-limited. Replayed transaction hashes return `duplicate: true` and do not create a second payment intent.
