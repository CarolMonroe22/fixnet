-- "I'm hitting this too": people add themselves to a bug, like on a status page. Counts only, no identities.
alter table public.cases add column if not exists asked_count integer not null default 0;

create or replace function public.case_plus_one(p_slug text)
returns integer
language sql security definer set search_path to ''
as $fn$
  update public.cases set asked_count = asked_count + 1
  where slug = p_slug and status <> 'verified'
  returning asked_count + signal_count;
$fn$;

revoke all on function public.case_plus_one from public, anon, authenticated;
grant execute on function public.case_plus_one to service_role;
