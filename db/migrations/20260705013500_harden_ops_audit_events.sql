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

create index if not exists request_logs_actor_agent_id_idx on request_logs(actor_agent_id);
create index if not exists request_logs_session_id_idx on request_logs(session_id);
create index if not exists audit_events_actor_agent_id_idx on audit_events(actor_agent_id);
create index if not exists audit_events_session_id_idx on audit_events(session_id);
