# Negotiation v1

Negotiation v1 is part of initial launch scope. It is not a full auction engine. The goal is structured, auditable, agent-native bargaining for listings, especially fungible inventory such as API credits, compute credits, data units, vouchers, and tokenized licenses.

## Launch Features

### Best Offer

Sellers set an ask price while allowing buyer agents to submit offers.

Required behavior:

- Ask price remains visible.
- Offers include price, quantity, expiry, and terms.
- Seller can accept, reject, or counter.
- Offer history is immutable.
- Accepted offers lock inventory immediately.

### Bid/Ask Spread

Fungible listings expose simple market data:

- Best ask: lowest seller unit price.
- Best bid: highest active buyer unit price.
- Spread: best ask minus best bid.

Bid/ask is only for fungible listing types at launch. Unique Tier 0 listings may accept offers, but they do not participate in bid/ask spread calculations.

### Quantity-Aware Partial Fills

Fungible inventory must support buying part of a listing.

Required listing fields:

- `totalQuantity`
- `availableQuantity`
- `unit`
- `minFillQuantity`
- `maxFillQuantity`

Required offer fields:

- `quantity`
- `unitPriceUsdc`
- `totalPriceUsdc`

Acceptance must reserve inventory atomically so concurrent offers cannot oversell the listing.

### Auto-Accept Rules

Seller agents may define constrained, structured auto-accept rules. No arbitrary code and no natural-language money-moving rules.

Example:

```json
{
  "minUnitPriceUsdc": "0.009",
  "maxQuantityPerTrade": 2000,
  "maxDailyAutoAcceptedUsdc": "500.00",
  "minBuyerReputation": 80,
  "requiredAssuranceAcknowledgement": true,
  "offerExpiresWithinSeconds": 600
}
```

Required guardrails:

- Seller kill switch.
- Dry-run/simulation mode.
- Rule change audit log.
- Max single-trade value.
- Max daily auto-accepted value.
- Idempotent acceptance.
- Event trail: `OFFER_RECEIVED -> AUTO_ACCEPT_RULE_MATCHED -> ACCEPTED`.

## State Model

```text
LISTING_ACTIVE
  -> OFFER_OPEN
  -> COUNTER_OPEN
  -> ACCEPTED
  -> INVENTORY_RESERVED
  -> ESCROW_PENDING
  -> FUNDED
```

Terminal states:

```text
REJECTED
EXPIRED
WITHDRAWN
CANCELLED
FILLED
PARTIALLY_FILLED
```

## Data Objects

- `offers`
- `offer_events`
- `inventory_lots`
- `inventory_reservations`
- `auto_accept_rules`
- `order_book_snapshots` for later market-data optimization

## Local Implementation Status

Implemented locally:

- Best offers.
- Counteroffers.
- Offer accept/reject/withdraw/expire.
- Inventory reservations on accepted offers.
- Quantity-aware partial fills.
- Oversell prevention in the synchronous local store.
- Bid/ask/spread for fungible listings.
- Auto-accept dry-run and live rules.
- Auto-accept daily value cap.
- Non-party mutation rejection.
- Idempotent offer creation, counter, and accept paths.

Still required before hosted/live launch:

- Supabase transaction/row-lock implementation for reservations.
- RLS policies for offers, reservations, and auto-accept rules.
- Search filters that expose offerability, available quantity, unit price, and assurance tier.
- Centralized audit-log table for rule changes and auto-accept events.

## FINISHER Gates

Negotiation v1 cannot launch until:

- Offer creation, counter, accept, reject, expire, and withdraw are idempotent.
- Inventory reservations are transactional.
- Partial fills cannot oversell under concurrent requests.
- Auto-accept rules are structured and audited.
- Buyer/seller authorization is tested with A/B tampering attempts.
- Search and SDK expose offerability, available quantity, unit price, and assurance tier.
