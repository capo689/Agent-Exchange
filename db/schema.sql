-- Agent Exchange initial Supabase schema.
-- Run this in the Supabase SQL Editor before switching the API to Postgres.

create extension if not exists pgcrypto;

create table if not exists agents (
  id text primary key,
  developer_id text not null,
  name text not null,
  wallet_address text,
  public_key_jwk jsonb,
  reputation_score integer not null default 0,
  verification_tier integer not null default 0,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists challenges (
  id text primary key,
  agent_id text not null references agents(id) on delete cascade,
  nonce text not null,
  canonical text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists sessions (
  id text primary key,
  token_hash text not null unique,
  agent_id text not null references agents(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists listings (
  id text primary key,
  seller_agent_id text not null references agents(id),
  title text not null,
  description text not null default '',
  category text not null,
  assurance_tier integer not null check (assurance_tier between 0 and 3),
  price_usdc text not null,
  inventory_type text not null check (inventory_type in ('unique', 'fungible')),
  accepts_offers boolean not null default true,
  ask_price_usdc text not null,
  unit_price_usdc text not null,
  total_quantity integer not null check (total_quantity > 0),
  available_quantity integer not null check (available_quantity >= 0),
  unit text not null,
  min_fill_quantity integer not null check (min_fill_quantity > 0),
  max_fill_quantity integer not null check (max_fill_quantity > 0),
  metadata jsonb not null default '{}'::jsonb,
  status text not null default 'active',
  screening jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (available_quantity <= total_quantity),
  check (min_fill_quantity <= max_fill_quantity),
  check (max_fill_quantity <= total_quantity)
);

create table if not exists offers (
  id text primary key,
  listing_id text not null references listings(id),
  buyer_agent_id text not null references agents(id),
  seller_agent_id text not null references agents(id),
  parent_offer_id text references offers(id),
  root_offer_id text,
  created_by_agent_id text not null references agents(id),
  status text not null,
  unit_price_usdc text not null,
  total_price_usdc text not null,
  quantity integer not null check (quantity > 0),
  terms jsonb not null default '{}'::jsonb,
  assurance_acknowledgement boolean not null default false,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by_agent_id text references agents(id),
  auto_accept_rule_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists offer_events (
  id text primary key,
  offer_id text not null references offers(id) on delete cascade,
  type text not null,
  actor_agent_id text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists inventory_lots (
  id text primary key,
  listing_id text not null unique references listings(id) on delete cascade,
  total_quantity integer not null check (total_quantity > 0),
  available_quantity integer not null check (available_quantity >= 0),
  unit text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (available_quantity <= total_quantity)
);

create table if not exists inventory_reservations (
  id text primary key,
  listing_id text not null references listings(id),
  offer_id text references offers(id),
  buyer_agent_id text not null references agents(id),
  seller_agent_id text not null references agents(id),
  quantity integer not null check (quantity > 0),
  unit text not null,
  unit_price_usdc text not null,
  total_price_usdc text not null,
  state text not null default 'RESERVED',
  actor_agent_id text not null,
  created_at timestamptz not null default now()
);

create table if not exists auto_accept_rules (
  id text primary key,
  listing_id text not null references listings(id) on delete cascade,
  seller_agent_id text not null references agents(id),
  min_unit_price_usdc text not null,
  max_quantity_per_trade integer not null check (max_quantity_per_trade > 0),
  max_daily_auto_accepted_usdc text not null,
  min_buyer_reputation integer not null default 0,
  required_assurance_acknowledgement boolean not null default false,
  offer_expires_within_seconds integer not null check (offer_expires_within_seconds > 0),
  dry_run boolean not null default true,
  enabled boolean not null default true,
  disabled_by_agent_id text references agents(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'offers_root_offer_id_fkey'
  ) then
    alter table offers
      add constraint offers_root_offer_id_fkey
      foreign key (root_offer_id) references offers(id);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'offers_auto_accept_rule_id_fkey'
  ) then
    alter table offers
      add constraint offers_auto_accept_rule_id_fkey
      foreign key (auto_accept_rule_id) references auto_accept_rules(id);
  end if;
end;
$$;

create table if not exists trades (
  id text primary key,
  listing_id text not null references listings(id),
  offer_id text references offers(id),
  reservation_id text references inventory_reservations(id),
  buyer_agent_id text not null references agents(id),
  seller_agent_id text not null references agents(id),
  assurance_tier integer not null check (assurance_tier between 0 and 3),
  buyer_acknowledged_assurance boolean not null default false,
  state text not null,
  price_usdc text not null,
  quantity integer not null check (quantity > 0),
  unit text not null,
  events jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists escrow_events (
  id text primary key,
  trade_id text not null references trades(id) on delete cascade,
  type text not null,
  amount_usdc text not null,
  actor text not null,
  adapter text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists payment_intents (
  id text primary key,
  trade_id text references trades(id) on delete cascade,
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

create table if not exists reputation_events (
  id text primary key,
  agent_id text not null references agents(id) on delete cascade,
  trade_id text references trades(id) on delete set null,
  role text not null check (role in ('buyer', 'seller')),
  delta integer not null,
  reason text not null,
  previous_score integer not null check (previous_score between 0 and 100),
  new_score integer not null check (new_score between 0 and 100),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists request_logs (
  id text primary key,
  request_id text not null,
  method text not null,
  path text not null,
  route text not null,
  status integer not null,
  latency_ms numeric not null,
  actor_agent_id text references agents(id) on delete set null,
  session_id text references sessions(id) on delete set null,
  error_code text,
  ip_hash text,
  user_agent text,
  created_at timestamptz not null default now()
);

create table if not exists audit_events (
  id text primary key,
  type text not null,
  severity text not null default 'info' check (severity in ('debug', 'info', 'warn', 'error', 'critical')),
  actor_agent_id text references agents(id) on delete set null,
  session_id text references sessions(id) on delete set null,
  resource_type text,
  resource_id text,
  request_id text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table request_logs enable row level security;
alter table audit_events enable row level security;

revoke all on table request_logs from anon, authenticated;
revoke all on table audit_events from anon, authenticated;

drop policy if exists request_logs_no_client_access on request_logs;
create policy request_logs_no_client_access
  on request_logs
  for all
  to anon, authenticated
  using (false)
  with check (false);

drop policy if exists audit_events_no_client_access on audit_events;
create policy audit_events_no_client_access
  on audit_events
  for all
  to anon, authenticated
  using (false)
  with check (false);

create table if not exists moderation_events (
  id text primary key,
  type text not null,
  reportable boolean not null default false,
  input jsonb not null default '{}'::jsonb,
  matches jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists idempotency_records (
  key text primary key,
  fingerprint text not null,
  response jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists challenges_agent_id_idx on challenges(agent_id);
create index if not exists sessions_agent_id_idx on sessions(agent_id);
create index if not exists listings_seller_agent_id_idx on listings(seller_agent_id);
create index if not exists offers_listing_id_idx on offers(listing_id);
create index if not exists offers_buyer_agent_id_idx on offers(buyer_agent_id);
create index if not exists offers_seller_agent_id_idx on offers(seller_agent_id);
create index if not exists inventory_reservations_listing_id_idx on inventory_reservations(listing_id);
create index if not exists trades_buyer_agent_id_idx on trades(buyer_agent_id);
create index if not exists trades_seller_agent_id_idx on trades(seller_agent_id);
create index if not exists escrow_events_trade_id_idx on escrow_events(trade_id);
create index if not exists payment_intents_trade_id_idx on payment_intents(trade_id);
create index if not exists payment_intents_status_idx on payment_intents(status);
create index if not exists payment_intents_provider_payment_id_idx on payment_intents(provider_payment_id);
create index if not exists payment_events_payment_intent_id_idx on payment_events(payment_intent_id);
create index if not exists reputation_events_agent_id_idx on reputation_events(agent_id);
create index if not exists reputation_events_trade_id_idx on reputation_events(trade_id);
create index if not exists request_logs_created_at_idx on request_logs(created_at);
create index if not exists request_logs_request_id_idx on request_logs(request_id);
create index if not exists request_logs_status_idx on request_logs(status);
create index if not exists request_logs_actor_agent_id_idx on request_logs(actor_agent_id);
create index if not exists request_logs_session_id_idx on request_logs(session_id);
create index if not exists audit_events_created_at_idx on audit_events(created_at);
create index if not exists audit_events_type_idx on audit_events(type);
create index if not exists audit_events_resource_idx on audit_events(resource_type, resource_id);
create index if not exists audit_events_actor_agent_id_idx on audit_events(actor_agent_id);
create index if not exists audit_events_session_id_idx on audit_events(session_id);
create index if not exists idempotency_records_created_at_idx on idempotency_records(created_at);

create or replace function reserve_listing_inventory(
  p_reservation_id text,
  p_listing_id text,
  p_offer_id text,
  p_buyer_agent_id text,
  p_actor_agent_id text,
  p_quantity integer,
  p_unit_price_usdc text,
  p_total_price_usdc text
) returns inventory_reservations
language plpgsql
set search_path = public, pg_temp
as $$
declare
  locked_listing listings%rowtype;
  created_reservation inventory_reservations%rowtype;
begin
  select * into locked_listing
  from listings
  where id = p_listing_id
  for update;

  if not found then
    raise exception 'listing_not_found';
  end if;

  if p_quantity < locked_listing.min_fill_quantity then
    raise exception 'below_min_fill';
  end if;

  if p_quantity > locked_listing.max_fill_quantity then
    raise exception 'above_max_fill';
  end if;

  if p_quantity > locked_listing.available_quantity then
    raise exception 'insufficient_inventory';
  end if;

  update listings
  set
    available_quantity = available_quantity - p_quantity,
    status = case
      when available_quantity - p_quantity = 0 then 'filled'
      when available_quantity - p_quantity < total_quantity then 'partially_filled'
      else status
    end,
    updated_at = now()
  where id = p_listing_id;

  update inventory_lots
  set
    available_quantity = available_quantity - p_quantity,
    updated_at = now()
  where listing_id = p_listing_id;

  insert into inventory_reservations (
    id,
    listing_id,
    offer_id,
    buyer_agent_id,
    seller_agent_id,
    quantity,
    unit,
    unit_price_usdc,
    total_price_usdc,
    actor_agent_id
  ) values (
    p_reservation_id,
    locked_listing.id,
    p_offer_id,
    p_buyer_agent_id,
    locked_listing.seller_agent_id,
    p_quantity,
    locked_listing.unit,
    p_unit_price_usdc,
    p_total_price_usdc,
    p_actor_agent_id
  )
  returning * into created_reservation;

  return created_reservation;
end;
$$;

alter table agents enable row level security;
alter table challenges enable row level security;
alter table sessions enable row level security;
alter table listings enable row level security;
alter table offers enable row level security;
alter table offer_events enable row level security;
alter table inventory_lots enable row level security;
alter table inventory_reservations enable row level security;
alter table auto_accept_rules enable row level security;
alter table trades enable row level security;
alter table escrow_events enable row level security;
alter table payment_intents enable row level security;
alter table payment_events enable row level security;
alter table reputation_events enable row level security;
alter table moderation_events enable row level security;
alter table idempotency_records enable row level security;

-- The API should use the server-side Supabase secret key / service role.
-- Public client policies come later, after route-level session auth is enforced.

revoke all privileges on all tables in schema public from anon, authenticated;
revoke all privileges on all sequences in schema public from anon, authenticated;

alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables from anon, authenticated;

alter default privileges for role postgres in schema public
  revoke usage, select on sequences from anon, authenticated;

alter default privileges for role postgres in schema public
  revoke execute on functions from public;

revoke execute on function public.reserve_listing_inventory(
  text,
  text,
  text,
  text,
  text,
  integer,
  text,
  text
) from public, anon, authenticated;

do $$
declare
  target_table text;
begin
  foreach target_table in array array[
    'agents',
    'challenges',
    'sessions',
    'listings',
    'offers',
    'offer_events',
    'inventory_lots',
    'inventory_reservations',
    'auto_accept_rules',
    'trades',
    'escrow_events',
    'payment_intents',
    'payment_events',
    'reputation_events',
    'moderation_events',
    'idempotency_records'
  ]
  loop
    if not exists (
      select 1
      from pg_policies
      where schemaname = 'public'
        and tablename = target_table
        and policyname = 'server_only_no_direct_client_access'
    ) then
      execute format(
        'create policy server_only_no_direct_client_access on public.%I for all to anon, authenticated using (false) with check (false)',
        target_table
      );
    end if;
  end loop;
end;
$$;
