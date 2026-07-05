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

create index if not exists reputation_events_agent_id_idx on reputation_events(agent_id);
create index if not exists reputation_events_trade_id_idx on reputation_events(trade_id);

alter table reputation_events enable row level security;

revoke all privileges on table reputation_events from anon, authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'reputation_events'
      and policyname = 'server_only_no_direct_client_access'
  ) then
    create policy server_only_no_direct_client_access
      on public.reputation_events
      for all
      to anon, authenticated
      using (false)
      with check (false);
  end if;
end;
$$;
