# FINISHER Baseline: Agent Exchange

Date: 2026-07-04  
Current stage: Level 0 local prototype moving toward Level 1 private prototype  
Launch standard: FINISHER private beta gate first, then paid/live beta gate

## Executive Summary

Agent Exchange currently has an executable local prototype for agent registration, assurance-tiered listings, Tier 0 buyer acknowledgement, policy blocking, trade state transitions, idempotency, role checks, stub escrow events, and local Negotiation v1: best offers, counteroffers, bid/ask spread for fungible inventory, quantity-aware partial fills, inventory reservations, and constrained auto-accept rules.

This is not launchable yet. It is intentionally pre-production: no real database, no hosted staging, no enforced session auth on every route, no real escrow, no x402, no rate limiting, no CI, no backup/restore, and no monitoring service.

## Project Identity

| Field | Current Value |
|---|---|
| Project name | Agent Exchange |
| Product type | Agent-first marketplace/API |
| Target users | AI agent developers, agent operators, and agents acting for accountable developers/entities |
| Primary value proposition | Let agents discover, list, and trade permitted goods with explicit assurance tiers and machine-readable accountability |
| Current stage | Local prototype |
| Current users | 0 external users |
| Expected 90-day users | Unknown; proposed private beta target: 5-10 invited developer/operators |
| Launch target | Private beta only after FINISHER P0/P1 gates pass |

## Stack Map

| Area | Current | Launch Target |
|---|---|---|
| API | Node.js standard `http` server in [src/server.js](../src/server.js) | Fastify or hardened Node API with middleware |
| Runtime | Node 24+ | Node 24+ |
| Persistence | In-memory / optional JSON file store in [src/store.js](../src/store.js) | Supabase Postgres with Drizzle migrations and RLS |
| Auth | Ed25519 challenge/response creates hashed bearer sessions; mutating agent routes require sessions | Signed requests + scoped route auth + developer ownership |
| Payments/escrow | Stub escrow events | Commerce Payments on Base Sepolia, then mainnet after gates |
| x402 | Not implemented | x402 middleware for paid endpoints |
| AI | None in code | Later moderation/dispute wrapper with quotas and logs |
| Frontend | None | Minimal admin/operator dashboard |
| SDK | JavaScript SDK in [sdk/agent-exchange-sdk.js](../sdk/agent-exchange-sdk.js) | Packaged TypeScript SDK, Python fast-follow |
| MCP | Lightweight stdio tool server in [mcp/server.js](../mcp/server.js) | Documented MCP server with auth |
| Observability | Basic JSON request/error logs via [src/logger.js](../src/logger.js) | Structured logs, error tracking, uptime, dashboards |
| CI/CD | None | Required GitHub Actions checks |
| Deployment | Local only | Staging + production with rollback |

## Data Map

Current store entities:

| Entity | Purpose | Current Storage | Ownership/Isolation |
|---|---|---|---|
| agents | Accountable agent identity records | Memory/JSON | `developerId`, `agent.id`; no RLS yet |
| challenges | One-time Ed25519 verification challenges | Memory/JSON | agent-scoped |
| sessions | Short-lived session tokens | Memory/JSON | agent-scoped; not enforced yet |
| listings | Marketplace listings with assurance tiers | Memory/JSON | seller agent |
| offers | Buyer/seller negotiation records | Memory/JSON | buyer + seller agents |
| offerEvents | Immutable offer/counter/accept/reject history | Memory/JSON | offer-linked |
| inventoryLots | Fungible or unique sellable inventory | Memory/JSON | seller agent |
| inventoryReservations | Accepted-offer inventory locks | Memory/JSON | trade/offer-linked |
| autoAcceptRules | Structured seller automation rules | Memory/JSON | seller agent |
| trades | Buyer/seller trade state | Memory/JSON | buyer + seller agents |
| escrowEvents | Stub authorize/capture/refund records | Memory/JSON | trade-linked |
| moderationEvents | Blocked/reportable policy events | Memory/JSON | admin/system |
| idempotencyRecords | Duplicate mutation protection | Memory/JSON | scoped by route/key |

Launch data requirements:

- Drizzle migrations for every table.
- Foreign keys and constraints for all ownership links.
- Transactional reservation constraints so partial fills cannot oversell.
- Immutable offer event history.
- RLS policies for agent/developer ownership.
- Append-only audit log for sensitive actions.
- Backup and restore drill before beta.
- Retention and deletion policy for developer/account data.

## Cost Surface Map

Current cost surfaces:

| Surface | Current Status | Risk |
|---|---|---|
| API compute | Local only | Low now; needs hosting cap later |
| Database | None | No launch persistence |
| Escrow gas | Stub only | No real cost yet |
| x402 facilitator | Not implemented | Future per-payment integration/cost risk |
| AI moderation/disputes | Not implemented | Future token spend risk |
| Webhooks | Not implemented | Future retry/abuse cost risk |

Required controls before beta:

- Per-IP and per-agent rate limits.
- Daily caps for listing creation, trades, and escrow volume.
- Gas budget alerts and circuit breaker.
- AI provider quotas and token logging before any AI calls.
- x402 payment ID dedupe before serving paid content.

## Attack Surface Map

| Surface | Current Controls | Gaps |
|---|---|---|
| Agent registration | Input validation | No rate limit, no developer auth |
| Verification challenge | Ed25519 signature, one-time challenge, expiry, hashed bearer sessions | No replay cache outside store; needs signed request option |
| Listing creation | Bearer session required, registered seller required, policy screen, Tier metadata | No DB RLS; no rate limit |
| Trade creation | Bearer session required, registered buyer required, self-trade blocked, Tier 0 acknowledgement, idempotency, inventory reservation | No persistent transaction boundary |
| Offer/counteroffer negotiation | Bearer session required for mutations, local state machine, idempotency, party-only expiry, role checks | Needs DB transactions and RLS |
| Auto-accept rules | Structured schema, dry-run, live mode, daily cap | Needs audit-log table, seller kill switch endpoint polish, RLS |
| Trade actions | Bearer-session role checks for seller/buyer; admin token for maintenance/resolution | Needs scoped admin accounts and audit UI |
| Policy abuse | Severe events marked reportable and logged | No evidence bundle/export flow yet |
| Persistence | Optional local JSON | Not suitable for concurrent/hosted use |
| Logs | Structured request/error logs | No centralized storage, alerting, retention, or redaction tests |
| Request bodies | HTTP JSON body limit | Needs rate limits and proxy-level limits |

## Unknowns

- Final Supabase project structure and credentials.
- CDP account readiness, wallet/signing policy support, and x402 credentials.
- Commerce Payments adapter details for authorize/capture/refund on Base Sepolia.
- Counsel guidance on Tier 0 liability, escrow operation, and reportable abuse flow.
- Exact private beta user count and launch date.
- Hosting target details for staging/prod Render services.
- Whether frontend admin starts as server-rendered minimal UI or separate app.
- Exact first fungible inventory units and schemas for bid/ask spread and partial fills.
- Initial reputation formula for auto-accept `minBuyerReputation` rules.

## Current FINISHER Classification

| Risk Level | Status |
|---|---|
| Level 0: Local demo | Current |
| Level 1: Private prototype | Next target |
| Level 2: Paid beta | Requires auth, DB, escrow testnet, CI, observability, rate limits, legal docs |
| Level 3: Production SaaS | Not close yet |

## P0 Before Private Hosted Beta

- Extend bearer auth with signed requests, scopes, developer ownership, and RLS-backed authorization.
- Replace JSON store with Supabase/Postgres and migrations.
- Add RLS/resource ownership tests.
- Add Negotiation v1 data model and transactional reservation tests. Local tests now cover direct-trade inventory reservation too; DB transaction tests still required.
- Add rate limits.
- Add CI with tests and scans.
- Add centralized error tracking/log retention.
- Add staging deployment and rollback process.

## P0 Before Real-Money Beta

- Commerce Payments adapter working on Base Sepolia.
- Chain event reconciliation and mismatch pause.
- Refund path tested and never blocked by kill switch.
- x402 payment verification for paid endpoints.
- Counsel sign-off or explicit written risk decision.
- Backup restore drill complete.
