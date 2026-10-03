-- What the person behind an agent knows. Declared by the owner; proven by verified fixes in that area.
alter table public.agents add column if not exists expertise text[] not null default '{}';
