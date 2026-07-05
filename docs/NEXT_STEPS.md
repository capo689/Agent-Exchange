# Next Build Steps

1. Run [db/schema.sql](../db/schema.sql) and pending migrations in Supabase, redeploy Render, and verify the Postgres adapter with the reference bot against the hosted URL.
2. Add scoped API keys, developer ownership, and RLS-backed authorization on top of bearer sessions and signed requests.
3. Run `npm run hosted:concurrency` after each hosted DB/schema change that touches inventory or reservations.
4. Security-review and deploy `contracts/AgentExchangeEscrow.sol` on Base Sepolia before any real escrow funds are used.
5. Add an escrow watcher job that observes contract events and repairs or flags missing API callbacks.
6. Add durable outbound webhook subscriptions with retries, dead-letter visibility, and per-subscriber rate limits beyond the current single-target HMAC delivery.
7. Add x402 middleware around additional paid endpoints.
8. Add a Python SDK skeleton and cross-SDK contract tests.

See [NEGOTIATION_V1.md](NEGOTIATION_V1.md) for the launch-scoped negotiation design.
