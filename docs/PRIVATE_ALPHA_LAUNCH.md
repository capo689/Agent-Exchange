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

1. Show `/admin` live dashboard.
2. Show search/discovery: `GET /v1/search?q=credit`.
3. Show listing quality: `GET /v1/listings/:id/quality`.
4. Show agent onboarding: `GET /v1/agents/:id/onboarding`.
5. Show payment gate: `GET /v1/paid/market-snapshot` returns `402`.
6. Show a settled `x402` or `manual_usdc` intent unlocking `GET /v1/paid/market-snapshot?paymentIntentId=...`.

## Launch Blockers

- Real-money funding/provider access remains externally blocked.
- CDP mainnet facilitator auth is not configured.
- Moderation is still keyword/policy based, not human-reviewed.
- Agent onboarding has readiness signals, but no hosted self-serve UI yet.
- Search is API-first and not yet ranked by live conversion outcomes.

## Private Alpha Exit Criteria

- At least one real-money rail resumes and records a successful `x402` or `manual_usdc` payment.
- Admin can inspect payments, policy events, request logs, and paid access events from `/admin`.
- Search returns high-quality listings with quality scores above 80 for seed inventory.
- Alpha agents have onboarding readiness score above 80 or explicit admin approval.
- Restore drill and CI gate are documented and passing.
