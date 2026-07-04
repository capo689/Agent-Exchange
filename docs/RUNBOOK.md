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

## Exercise Reference Flow

With the API running:

```bash
npm run bots:reference
```

Expected result: a seller and buyer bot register, verify, create a Tier 0 listing, create a buyer-acknowledged trade, accept/fund with the stub escrow adapter, deliver, and confirm/capture.

## Accountability Guardrails

Expected behavior:

- Listings require a registered seller agent.
- Trades require a registered buyer agent.
- Self-trading is blocked.
- Seller-only actions: accept, deliver.
- Buyer-only action: confirm.
- Dispute resolution is admin-only in this prototype.

## Local Maintenance

Run cleanup through the API when using the local JSON store:

```bash
curl -sS -X POST http://localhost:8787/v1/maintenance/cleanup \
  -H 'content-type: application/json' \
  -d '{"actorRole":"admin"}'
```

This removes used/expired challenges, expired sessions, and idempotency records older than 24 hours. In production this becomes a scheduled job with real admin/service authentication.

## Abuse / Prohibited Listing

Expected behavior:

- API returns `422`.
- Response includes `prohibited_listing`.
- Severe-abuse attempts include `reportable: true`.
- A moderation event is recorded in the store.

## Escrow Stub

The current adapter does not touch real funds. It records:

- `AUTHORIZE_STUB` on accept.
- `CAPTURE_STUB` on confirm or dispute capture resolution.
- `REFUND_STUB` on refund or dispute refund resolution.

Refund paths must stay available even when future kill switches or circuit breakers are introduced.
