-- Harden Agent Exchange's Supabase project for the current server-only API model.
-- Public clients should use the Agent Exchange API, not Supabase Data API tables/RPC.

revoke all privileges on all tables in schema public from anon, authenticated;
revoke all privileges on all sequences in schema public from anon, authenticated;

alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables from anon, authenticated;

alter default privileges for role postgres in schema public
  revoke usage, select on sequences from anon, authenticated;

alter default privileges for role postgres in schema public
  revoke execute on functions from public;

alter function public.reserve_listing_inventory(
  text,
  text,
  text,
  text,
  text,
  integer,
  text,
  text
) set search_path = public, pg_temp;

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
