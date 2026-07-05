create table if not exists signed_request_nonces (
  id text primary key,
  agent_id text not null references agents(id) on delete cascade,
  nonce text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (agent_id, nonce)
);

create index if not exists signed_request_nonces_agent_id_idx on signed_request_nonces(agent_id);
create index if not exists signed_request_nonces_expires_at_idx on signed_request_nonces(expires_at);

alter table signed_request_nonces enable row level security;

revoke all on table signed_request_nonces from anon, authenticated;

drop policy if exists signed_request_nonces_no_client_access on signed_request_nonces;
create policy signed_request_nonces_no_client_access
  on signed_request_nonces
  for all
  to anon, authenticated
  using (false)
  with check (false);
