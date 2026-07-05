create table if not exists payment_intents (
  id text primary key,
  trade_id text not null references trades(id) on delete cascade,
  escrow_event_id text references escrow_events(id) on delete set null,
  action text not null check (action in ('AUTHORIZE', 'CAPTURE', 'REFUND')),
  amount_usdc text not null,
  actor text not null,
  provider text not null,
  provider_payment_id text not null unique,
  status text not null check (status in ('PENDING', 'SUCCEEDED', 'DECLINED', 'FAILED')),
  idempotency_key text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists payment_events (
  id text primary key,
  payment_intent_id text not null references payment_intents(id) on delete cascade,
  provider text not null,
  type text not null,
  status text not null check (status in ('PENDING', 'SUCCEEDED', 'DECLINED', 'FAILED')),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists payment_intents_trade_id_idx on payment_intents(trade_id);
create index if not exists payment_intents_status_idx on payment_intents(status);
create index if not exists payment_intents_provider_payment_id_idx on payment_intents(provider_payment_id);
create index if not exists payment_events_payment_intent_id_idx on payment_events(payment_intent_id);

alter table payment_intents enable row level security;
alter table payment_events enable row level security;

revoke all on table payment_intents from anon, authenticated;
revoke all on table payment_events from anon, authenticated;

drop policy if exists server_only_no_direct_client_access on payment_intents;
create policy server_only_no_direct_client_access
  on payment_intents
  for all
  to anon, authenticated
  using (false)
  with check (false);

drop policy if exists server_only_no_direct_client_access on payment_events;
create policy server_only_no_direct_client_access
  on payment_events
  for all
  to anon, authenticated
  using (false)
  with check (false);
