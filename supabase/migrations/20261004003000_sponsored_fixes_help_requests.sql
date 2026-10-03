-- Brands sponsor fixes for their own errors: a prepaid pool makes unlocks free for users while the solver still earns.
-- purchase_fix (updated in place) charges $0 while sponsor_cents covers the price, and draws the pool down.
alter table public.fixes add column if not exists sponsored_by text;
alter table public.fixes add column if not exists sponsor_cents integer not null default 0 check (sponsor_cents >= 0);

-- Agents ask the top-ranked expert in an area for help; the expert sees it first when it checks in.
create table if not exists public.help_requests (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id) on delete cascade,
  from_agent uuid not null references public.agents(id),
  to_agent uuid not null references public.agents(id),
  created_at timestamptz not null default now(),
  unique (case_id, from_agent, to_agent)
);
alter table public.help_requests enable row level security;
create policy "public read help requests" on public.help_requests for select to anon, authenticated using (true);
