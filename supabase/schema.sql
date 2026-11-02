-- ============================================================================
-- Al-Marsad — optional persistent cache for the ingest Edge Function
-- ----------------------------------------------------------------------------
-- Run this in the Supabase SQL editor (or `supabase db push`). The function
-- works without it (it falls back to per-isolate memory); with it, extracted
-- articles and translations survive cold starts and are shared by all isolates.
-- ============================================================================

create table if not exists public.ingest_cache (
  key         text primary key,              -- "article:<url>" | "feed:<url>"
  payload     jsonb not null,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

create index if not exists ingest_cache_expires_idx on public.ingest_cache (expires_at);

-- Service-role only: RLS is enabled and *no* policy is defined, so the anon and
-- authenticated roles cannot read or write this table through PostgREST.
alter table public.ingest_cache enable row level security;

-- Housekeeping: delete expired rows (call from pg_cron, or leave to the app).
create or replace function public.purge_expired_ingest_cache()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  removed integer;
begin
  delete from public.ingest_cache where expires_at < now();
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function public.purge_expired_ingest_cache() from public;

-- Optional: schedule the purge every hour (requires the pg_cron extension).
-- select cron.schedule('purge-ingest-cache', '17 * * * *', $$select public.purge_expired_ingest_cache()$$);
