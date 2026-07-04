# Next Build Steps

1. Replace in-memory/store-file persistence with Supabase/Postgres. The first SQL schema is in [db/schema.sql](../db/schema.sql); the next code step is a Postgres store adapter.
2. Add real auth boundaries: session bearer tokens, signed requests, scopes, and route-level authorization.
3. Add Negotiation v1: best offer, counteroffers, bid/ask spread for fungible inventory, quantity-aware partial fills, and constrained auto-accept rules.
4. Add transactional inventory reservations so accepted offers cannot oversell under concurrency.
5. Swap the escrow stub for a Commerce Payments adapter on Base Sepolia.
6. Add x402 middleware around paid endpoints.
7. Add admin dashboard views for moderation, trades, offers, auto-accept rules, inventory reservations, escrow events, and reportable abuse.
8. Add SSRF-safe outbound webhooks and HMAC delivery.
9. Add SDK package tests and a Python SDK skeleton.

See [NEGOTIATION_V1.md](NEGOTIATION_V1.md) for the launch-scoped negotiation design.
