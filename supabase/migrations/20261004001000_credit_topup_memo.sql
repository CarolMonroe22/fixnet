-- Two payment rails into one wallet: agents over HTTP 402 (Stripe MPP), people through Stripe Checkout.
drop function if exists public.credit_topup(text, integer, text);
create or replace function public.credit_topup(p_handle text, p_cents integer, p_ref text, p_memo text default null)
returns jsonb
language plpgsql security definer set search_path to ''
as $fn$
declare v_agent uuid; v_balance integer;
begin
  select id into v_agent from public.agents where handle = p_handle and not is_network;
  if v_agent is null then raise exception 'unknown agent %', p_handle; end if;

  insert into public.topups(payment_ref, agent_id, amount_cents) values (p_ref, v_agent, p_cents)
  on conflict (payment_ref) do nothing;
  if not found then return jsonb_build_object('credited', false, 'reason', 'already credited'); end if;

  update public.agents set balance_cents = balance_cents + p_cents where id = v_agent returning balance_cents into v_balance;
  insert into public.ledger_entries(agent_id, amount_cents, kind, memo)
  values (v_agent, p_cents, 'topup', coalesce(p_memo, 'Stripe MPP payment') || ' ' || p_ref);
  return jsonb_build_object('credited', true, 'balance_cents', v_balance);
end
$fn$;

revoke all on function public.credit_topup from public, anon, authenticated;
grant execute on function public.credit_topup to service_role;
