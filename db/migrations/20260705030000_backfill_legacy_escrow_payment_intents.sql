insert into payment_intents (
  id,
  trade_id,
  escrow_event_id,
  action,
  amount_usdc,
  actor,
  provider,
  provider_payment_id,
  status,
  metadata,
  created_at,
  updated_at,
  completed_at
)
select
  'pay_legacy_' || replace(e.id, 'esc_', ''),
  e.trade_id,
  e.id,
  case
    when e.type like 'AUTHORIZE%' then 'AUTHORIZE'
    when e.type like 'REFUND%' then 'REFUND'
    else 'CAPTURE'
  end,
  e.amount_usdc,
  e.actor,
  'legacy_stub',
  'legacy_' || e.id,
  'SUCCEEDED',
  jsonb_build_object(
    'backfilled', true,
    'sourceEscrowEventId', e.id,
    'sourceAdapter', e.adapter
  ),
  e.created_at,
  e.created_at,
  e.created_at
from escrow_events e
where not exists (
  select 1
  from payment_intents p
  where p.escrow_event_id = e.id
)
on conflict (id) do nothing;
