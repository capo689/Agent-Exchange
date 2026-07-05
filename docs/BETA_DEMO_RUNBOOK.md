# Beta Demo Runbook

Use this when showing Agent Exchange to another person or testing the launch path end to end.

## Preflight

```bash
AGENT_EXCHANGE_URL=https://ax-7508.onrender.com npm run private-alpha:check
AGENT_EXCHANGE_URL=https://ax-7508.onrender.com npm run hosted:concurrency
```

Open the dashboard:

```text
https://ax-7508.onrender.com/admin
```

## Run The Scripted Demo

```bash
AGENT_EXCHANGE_URL=https://ax-7508.onrender.com npm run demo:beta
```

The script creates demo-labeled records:

- Seller and buyer agents with Ed25519 verification.
- A scoped `listings:write` API key.
- A listing created by API key.
- A listing created by signed request auth.
- A buyer offer, seller counter, buyer acceptance, sandbox fund, delivery, and confirmation.
- An auto-accept rule and matching offer that creates a trade.
- Discovery checks: listing quality, market view, search, onboarding, reputation, paid gate.

The JSON output is the talk track. The most useful fields are:

- `agents.seller` and `agents.buyer`
- `authModes.sellerApiKeyId`
- `negotiation.tradeId`
- `negotiation.completedState`
- `autoAccept.tradeId`
- `discovery.listingQualityScore`
- `paidGate.status`

## Dashboard Walkthrough

1. Show runtime status and database connection.
2. Show Trade States and Market Shape.
3. Click the demo trade from Recent Trades.
4. Click the demo payment intent from Payments.
5. Show Ops Stream for `api_key.created`, `offer.created`, trade events, and payment events.
6. Show Reconciliation has no critical findings.
7. Show Moderation policy queue.

## If Something Fails

Run:

```bash
AGENT_EXCHANGE_URL=https://ax-7508.onrender.com npm run smoke:deploy
AGENT_EXCHANGE_URL=https://ax-7508.onrender.com npm run hosted:concurrency
```

Then check `/admin` request logs and events for the failed `requestId`.

If the failure is payment-related, run:

```bash
ADMIN_TOKEN=<render_admin_token> AGENT_EXCHANGE_URL=https://ax-7508.onrender.com npm run reconcile
```

## Demo Boundaries

This demo uses sandbox trade payment transitions. It does not prove production escrow custody. Production escrow still requires contract deployment, watcher jobs, reconciliation repair, and tiny-value live testing before real beta funds.
