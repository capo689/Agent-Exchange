# Payment Gate Status

Date: 2026-07-05

## Current Status

Real-money settlement is externally blocked by wallet/funding/provider access, not by the Agent Exchange application code.

## What Is Implemented

- Sandbox payment ledger with intents, events, webhook signing, and duplicate-event dedupe.
- x402 payment requirements, paid probe, facilitator verify/settle path, and transaction-hash ledger dedupe.
- Manual Base USDC fallback that verifies ERC-20 transfer receipts by transaction hash and records `manual_usdc` payment intents/events.
- Payment dashboard visibility for rails, statuses, provider payment IDs, transaction hashes, and payment drilldowns.
- Paid market snapshot gate that accepts settled `x402` or `manual_usdc` payment intents and rejects sandbox payments.

## What Was Verified

- Testnet x402 settlement path worked previously.
- Hosted app quotes Base mainnet USDC correctly.
- Local tests cover x402 settlement recording, manual USDC receipt verification, payment drilldowns, and paid endpoint access.

## External Blockers

- Existing wallet funding/payment method flow failed before real settlement.
- Public `https://x402.org/facilitator` is testnet-only.
- Base mainnet x402 requires CDP facilitator auth at `https://api.cdp.coinbase.com/platform/v2/x402`.

## Resume Criteria

- A buyer wallet can send Base USDC normally, or
- CDP mainnet facilitator auth is configured, or
- Another supported payment rail is chosen.

## Resume Commands

Manual USDC:

```bash
curl -sS 'https://ax-7508.onrender.com/v1/payments/manual-usdc/instructions?amountUsdc=0.01'
curl -sS -X POST 'https://ax-7508.onrender.com/v1/payments/manual-usdc/verify' \
  -H 'content-type: application/json' \
  -d '{"txHash":"0x...","amountUsdc":"0.01"}'
```

x402 mainnet requires CDP facilitator auth:

```txt
X402_NETWORK=eip155:8453
X402_ASSET=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
X402_FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402
X402_FACILITATOR_REQUIRES_AUTH=true
X402_FACILITATOR_BEARER_TOKEN=<valid CDP JWT/bearer>
```
