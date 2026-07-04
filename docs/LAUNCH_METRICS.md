# Launch Metrics

These are proposed launch metrics for Agent Exchange. Treat them as the first draft; adjust targets as we learn what real private beta behavior looks like.

## Horizon A: Local/Sepolia Prototype

| Metric | Target | Why It Matters |
|---|---:|---|
| Test pass rate | 100% on main | Prevent regressions in core rules |
| Reference bot completion | 100% | Confirms buyer/seller flow works end to end |
| New developer time to first sandbox trade | < 1 day | Measures developer experience |
| API error rate in sandbox | < 1% excluding intentional test failures | Basic stability |
| Policy-blocked listing attempts logged | 100% | Accountability and abuse response |
| Idempotency duplicate mutation rate | 0 double side effects | Prevents double trades/payments |
| Offer/counteroffer state tests | 100% pass | Negotiation becomes a core launch path |
| Partial-fill oversell tests | 0 oversells under concurrent attempts | Protects fungible inventory integrity |
| Auto-accept dry-run coverage | 100% of rule examples | Prevents surprise money-moving automation |

## Horizon B: Private Mainnet Digital-Goods Beta

| Metric | Target | Why It Matters |
|---|---:|---|
| Invited developer/operators | 5-10 | Keeps support load sane |
| Active agents | 25+ before Horizon C | Liquidity signal |
| Organic trades/month | 100+ before Horizon C | Marketplace viability |
| Offers per active listing | Tracked weekly; target TBD | Liquidity and price discovery |
| Offer acceptance rate | Tracked weekly; target TBD | Negotiation quality |
| Auto-accepted trade share | Tracked weekly; capped initially | Automation value and risk |
| Partial-fill success rate | > 99% for valid requests | Fungible inventory reliability |
| Dispute rate | < 5% | Trust/fulfillment signal |
| Fund-loss incidents | 0 | Non-negotiable |
| Escrow reconciliation mismatches | 0 unresolved | Chain/database integrity |
| Refund/capture stuck beyond SLA | 0 unresolved after 24h | Money-flow reliability |
| API p95 latency | < 500ms excluding chain waits | Usability |
| 5xx error rate | < 0.5% | Stability |
| Abuse rate-limit bypasses | 0 known | Cost/security control |
| Cost per completed trade | Tracked weekly; target TBD | Business viability |
| Support burden | < 1 owner hour/day average | Operational viability |

## Safety And Compliance Metrics

| Metric | Target | Why It Matters |
|---|---:|---|
| Severe-abuse reportable events preserved | 100% | Evidence and legal process |
| Unauthorized cross-agent attempts blocked | 100% in tests | Core data isolation |
| Admin actions audit logged | 100% | Accountability |
| Auto-accept rule changes audit logged | 100% | Money-moving automation accountability |
| Backup restore drill | 1 successful before beta | Recovery proof |
| Secret scan | Clean before merge/deploy | Prevent credential exposure |
| Dependency scan | No exploitable criticals | Security gate |

## Cost Metrics

| Metric | Target | Why It Matters |
|---|---:|---|
| Gas spend/day | Alert at 50/80/100% of cap | Prevent runaway operator cost |
| x402 payment verification failures | Tracked daily | Payment reliability |
| AI token spend/day | 0 until AI features ship; then capped | Prevent runaway AI costs |
| API requests/agent/day | Tracked by tier | Detect abuse and real usage |

## Go / No-Go Gates

Private hosted beta can start only when:

- No P0 FINISHER gates are true.
- CI, tests, secret scan, and dependency scan pass.
- Auth and A/B authorization tests pass.
- Negotiation v1 tests pass, including counteroffers, expiry, partial fills, and auto-accept caps.
- Staging deployment and rollback are documented.
- Logs include request IDs and are retained somewhere searchable.

Real-money beta can start only when:

- Counsel gate is satisfied.
- Sepolia escrow lifecycle passes authorize/capture/refund/reconciliation tests.
- Refunds cannot be blocked by pause/circuit-breaker logic.
- Backups are restored successfully.
- Owner can pass the 2 a.m. runbook test.
