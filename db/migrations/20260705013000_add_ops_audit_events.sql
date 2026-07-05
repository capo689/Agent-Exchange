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
