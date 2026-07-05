# Next Build Steps

1. Run [db/schema.sql](../db/schema.sql) in Supabase, redeploy Render, and verify the Postgres adapter with the reference bot against the hosted URL.
2. Extend auth beyond bearer sessions with signed requests, scoped API keys, developer ownership, and RLS-backed authorization.
3. Add hosted DB concurrency tests around the Supabase transactional reservation function.
4. Security-review and deploy `contracts/AgentExchangeEscrow.sol` on Base Sepolia before any real escrow funds are used.
5. Add an escrow watcher job that observes contract events and repairs or flags missing API callbacks.
6. Add x402 middleware around additional paid endpoints.
7. Add SSRF-safe outbound webhooks and HMAC delivery.
8. Add SDK package tests and a Python SDK skeleton.

See [NEGOTIATION_V1.md](NEGOTIATION_V1.md) for the launch-scoped negotiation design.
