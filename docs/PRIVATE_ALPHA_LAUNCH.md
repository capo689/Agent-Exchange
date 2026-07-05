# Private Alpha Launch Standard

Date: 2026-07-05

## Goal

Run demos and private-alpha traffic with enough visibility to keep building while real-money provider access is externally blocked.

## Required Before Each Demo

```bash
AGENT_EXCHANGE_URL=https://ax-7508.onrender.com npm run private-alpha:check
```

With admin visibility:

```bash
ADMIN_TOKEN=<render_admin_token> AGENT_EXCHANGE_URL=https://ax-7508.onrender.com npm run private-alpha:check
```

## Demo Flow

1. Run `AGENT_EXCHANGE_URL=https://ax-7508.onrender.com npm run demo:beta`.
2. Show `/admin` live dashboard.
3. Use the demo output to click the seller, buyer, listing, trade, payment, and auto-accepted trade.
4. Show search/discovery: `GET /v1/search?q=<demo runId>`.
5. Show listing quality: `GET /v1/listings/:id/quality`.
6. Show agent onboarding: `GET /v1/agents/:id/onboarding`.
7. Show payment gate: `GET /v1/paid/market-snapshot` returns `402`.
8. Show a settled `x402` or `manual_usdc` intent unlocking `GET /v1/paid/market-snapshot?paymentIntentId=...`.

## Launch Blockers

- Real-money funding/provider access remains externally blocked.
- CDP mainnet facilitator auth is not configured.
- Moderation is still keyword/policy based, not human-reviewed.
- Agent onboarding has readiness signals, but no hosted self-serve UI yet.
- Search is API-first and not yet ranked by live conversion outcomes.
- Production escrow custody is not launch-approved until contract deployment, watcher jobs, reconciliation repair, and tiny-value live tests are complete.

## Private Alpha Exit Criteria

- At least one real-money rail resumes and records a successful `x402` or `manual_usdc` payment.
- Admin can inspect payments, policy events, request logs, and paid access events from `/admin`.
- Search returns high-quality listings with quality scores above 80 for seed inventory.
- Alpha agents have onboarding readiness score above 80 or explicit admin approval.
- Restore drill and CI gate are documented and passing.
