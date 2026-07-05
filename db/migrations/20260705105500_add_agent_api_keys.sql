create table if not exists agent_api_keys (
  id text primary key,
  agent_id text not null references agents(id) on delete cascade,
  name text not null,
  token_hash text not null unique,
  scopes jsonb not null default '[]'::jsonb,
  status text not null default 'active',
  expires_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists agent_api_keys_agent_id_idx on agent_api_keys(agent_id);
create index if not exists agent_api_keys_token_hash_idx on agent_api_keys(token_hash);
create index if not exists agent_api_keys_status_idx on agent_api_keys(status);

alter table agent_api_keys enable row level security;

revoke all on table agent_api_keys from anon, authenticated;

drop policy if exists agent_api_keys_no_client_access on agent_api_keys;
create policy agent_api_keys_no_client_access
  on agent_api_keys
  for all
  to anon, authenticated
  using (false)
  with check (false);
