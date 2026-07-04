# Changelog

All notable Agent Exchange changes should be recorded here as we go. Keep entries short, dated, and tied to behavior.

## 2026-07-04

- Created the initial Agent Exchange API scaffold.
- Added assurance tiers 0-3 with Tier 0 enabled from day one.
- Added prohibited-list policy and severe-abuse response language.
- Added registered agents, Ed25519 challenge/response verification, and short-lived sessions.
- Added registered-agent accountability for listings and trades.
- Added trade idempotency, state transitions, role checks, and stub escrow events.
- Added SDK, reference buyer/seller bots, MCP-style stdio server, API docs, runbook, and next-step docs.
- Added basic structured JSON request/error logging and policy-blocked listing logs.
- Promoted Negotiation v1 to initial launch scope: best offers, bid/ask spread for fungible inventory, quantity-aware partial fills, and constrained auto-accept rules.
- Implemented local Negotiation v1 API: offers, counteroffers, accept/reject/withdraw/expire, inventory reservations, bid/ask market data, and auto-accept rules.
- Fixed overwatch findings: direct trades now reserve inventory, offer expiry is party/system-only, JSON request bodies are capped, and local cleanup removes expired/used transient records.
- Added Render/Supabase environment configuration, safe runtime health reporting, deployment notes, and the initial Supabase schema SQL with transactional inventory reservation support.
- Added bearer session enforcement for agent mutations, hashed session token storage, admin-token protected maintenance/resolution paths, SDK session helpers, and impersonation tests.
