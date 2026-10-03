-- Radar: public GitHub issues and Reddit posts become signals. pgvector groups repeated errors;
-- a signal that matches a known case adds demand to it, and enough unmatched signals that agree
-- with each other give birth to a new case with a bounty the network pledges.

alter table public.cases add column if not exists signal_count integer not null default 0;
alter table public.cases add column if not exists source text not null default 'sponsor';

create table public.signals (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('github', 'reddit')),
  url text not null unique,
  title text not null,
  error_text text not null,
  error_code text,
  package text,
  posted_at timestamptz,
  embedding extensions.vector(384) not null,
  case_id uuid references public.cases(id) on delete set null,
  similarity double precision,
  created_at timestamptz not null default now()
);
create index signals_case_id_idx on public.signals(case_id);

alter table public.signals enable row level security;
create policy "public read signals" on public.signals for select to anon, authenticated using (true);
alter publication supabase_realtime add table public.signals;

create or replace function public.radar_ingest(
  p_source text, p_url text, p_title text, p_error text, p_package text, p_posted_at timestamptz,
  p_embedding extensions.vector,
  p_code text default null,
  p_case_threshold double precision default 0.87,
  p_cluster_threshold double precision default 0.88,
  p_cluster_min integer default 3
) returns jsonb
language plpgsql security definer set search_path to ''
as $fn$
declare
  v_signal uuid; v_case record; v_new uuid; v_n integer; v_slug text; v_code text; v_need double precision;
  per_signal constant integer := 50;   -- every person hitting the error is a future $0.50 unlock
  cap constant integer := 2500;
begin
  insert into public.signals(source, url, title, error_text, error_code, package, posted_at, embedding)
  values (p_source, p_url, left(p_title, 300), left(p_error, 500), p_code, p_package, p_posted_at, p_embedding)
  on conflict (url) do nothing returning id into v_signal;
  if v_signal is null then return jsonb_build_object('action', 'duplicate'); end if;

  -- 1. it looks like a case we already know: add demand
  -- vectors find the neighbour, the error code keeps different failures that read alike apart
  select c.id, c.slug, c.status, c.funded_by, 1 - (c.embedding operator(extensions.<=>) p_embedding) as sim
  into v_case from public.cases c
  where c.embedding is not null
    and (p_code is null or c.error_code is null or c.error_code = p_code)
  order by c.embedding operator(extensions.<=>) p_embedding limit 1;

  -- without an error code the text alone has to be much closer
  v_need := p_case_threshold;
  if p_code is null then v_need := greatest(p_case_threshold, 0.93); end if;

  if found and v_case.sim >= v_need then
    update public.signals set case_id = v_case.id, similarity = v_case.sim where id = v_signal;
    update public.cases set
      signal_count = signal_count + 1,
      bounty_cents = case when status <> 'verified' and coalesce(funded_by, 'fixnet radar') = 'fixnet radar'
                          then least(bounty_cents + per_signal, cap) else bounty_cents end,
      funded_by = case when status <> 'verified' and funded_by is null then 'fixnet radar' else funded_by end
    where id = v_case.id;
    return jsonb_build_object('action', 'matched', 'case', v_case.slug, 'similarity', round(v_case.sim::numeric, 3));
  end if;

  -- 2. no known case: do enough unmatched signals agree with this one?
  select count(*) into v_n from public.signals s
  where s.case_id is null
    and s.error_code is not distinct from p_code
    and 1 - (s.embedding operator(extensions.<=>) p_embedding) >= p_cluster_threshold;

  if v_n < p_cluster_min then return jsonb_build_object('action', 'held', 'cluster_size', v_n); end if;

  v_code := lower(replace(coalesce(p_code, ''), '_', '-'));
  v_slug := concat_ws('-', nullif(p_package, ''), nullif(v_code, ''), left(md5(v_signal::text), 5));

  insert into public.cases(slug, title, error_code, error_message, package, versions, status,
                           bounty_cents, funded_by, embedding, signal_count, source)
  values (v_slug, left(p_error, 140), p_code, p_error,
          coalesce(p_package, 'unknown'), 'seen in the wild', 'investigating',
          least(v_n * per_signal, cap), 'fixnet radar', p_embedding, v_n, 'radar')
  returning id into v_new;

  update public.signals s set case_id = v_new,
         similarity = 1 - (s.embedding operator(extensions.<=>) p_embedding)
  where s.case_id is null
    and s.error_code is not distinct from p_code
    and 1 - (s.embedding operator(extensions.<=>) p_embedding) >= p_cluster_threshold;

  return jsonb_build_object('action', 'born', 'case', v_slug, 'cluster_size', v_n);
end
$fn$;

revoke all on function public.radar_ingest from public, anon, authenticated;
grant execute on function public.radar_ingest to service_role;
