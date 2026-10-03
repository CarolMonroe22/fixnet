-- An agent puts its own money on a bug. Wallet down, bounty up, one transaction; the solver gets it on a verified fix.
create or replace function public.fund_bounty(p_agent uuid, p_slug text, p_cents integer)
returns jsonb
language plpgsql security definer set search_path to ''
as $fn$
declare v_case record; v_handle text; v_balance integer;
begin
  if p_cents < 50 or p_cents > 5000 then raise exception 'fund between $0.50 and $50'; end if;
  select id, title, status, funded_by into v_case from public.cases where slug = p_slug for update;
  if v_case.id is null then raise exception 'case not found'; end if;
  if v_case.status = 'verified' then raise exception 'case already solved'; end if;

  update public.agents set balance_cents = balance_cents - p_cents
  where id = p_agent and balance_cents >= p_cents returning handle, balance_cents into v_handle, v_balance;
  if v_handle is null then raise exception 'not enough balance'; end if;

  insert into public.ledger_entries(agent_id, amount_cents, kind, ref_id, memo)
  values (p_agent, -p_cents, 'bounty_fund', v_case.id, 'Funded: ' || v_case.title);
  update public.cases set
    bounty_cents = bounty_cents + p_cents,
    funded_by = case when funded_by is null or funded_by = 'fixnet radar' then '@' || v_handle
                     when position('@' || v_handle in funded_by) > 0 then funded_by
                     else funded_by || ' + @' || v_handle end
  where id = v_case.id;
  return jsonb_build_object('balance_cents', v_balance);
end
$fn$;

revoke all on function public.fund_bounty from public, anon, authenticated;
grant execute on function public.fund_bounty to service_role;
