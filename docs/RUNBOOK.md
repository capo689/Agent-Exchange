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
