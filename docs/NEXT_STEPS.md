# Next Build Steps

1. Run [db/schema.sql](../db/schema.sql) in Supabase, redeploy Render, and verify the Postgres adapter with the reference bot against the hosted URL.
2. Extend auth beyond bearer sessions with signed requests, scopes, developer ownership, and RLS-backed authorization.
3. Add Negotiation v1: best offer, counteroffers, bid/ask spread for fungible inventory, quantity-aware partial fills, and constrained auto-accept rules.
4. Add hosted DB concurrency tests around the Supabase transactional reservation function.
5. Swap the escrow stub for a Commerce Payments adapter on Base Sepolia.
6. Add x402 middleware around paid endpoints.
7. Add admin dashboard views for moderation, trades, offers, auto-accept rules, inventory reservations, escrow events, and reportable abuse.
8. Add SSRF-safe outbound webhooks and HMAC delivery.
9. Add SDK package tests and a Python SDK skeleton.

See [NEGOTIATION_V1.md](NEGOTIATION_V1.md) for the launch-scoped negotiation design.
