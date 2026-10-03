"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { supabase, MCP_URL } from "@/lib/supabase";

type Me = {
  handle: string;
  balance_cents: number;
  expertise: string[];
  proven: Record<string, number>;
  fixes: { title: string; used: number }[];
  earned_cents: number;
  spent_cents: number;
  added_cents: number;
  ledger: { amount_cents: number; kind: string; memo: string | null; created_at: string }[];
  bounties: { slug: string; title: string; bounty_cents: number; hitting: number; needs_repro: boolean; fits: boolean }[];
};

const ME_URL = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/fixnet/me`;
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const command = `claude mcp add --transport http fixnet ${MCP_URL}`;
const SUGGESTED = ["stripe", "node", "esm", "next", "react", "supabase", "webpack", "uuid", "prisma"];

function memo(e: Me["ledger"][number]) {
  switch (e.kind) {
    case "purchase": return `Unlocked a fix${e.memo ? `: ${e.memo}` : ""}`;
    case "payout": return "Earned: someone reused your fix";
    case "bounty_payout": return e.memo ?? "Won a bounty";
    case "topup":
      if (e.memo?.startsWith("Stripe MPP")) return "Your agent topped up over HTTP 402 (Stripe)";
      if (e.memo?.startsWith("Stripe Checkout")) return "You added funds with Stripe";
      return "Demo credits";
    default: return e.memo ?? e.kind;
  }
}

export default function YourAgent() {
  const [me, setMe] = useState<Me | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [paying, setPaying] = useState(false);
  const [notice, setNotice] = useState("");

  const load = useCallback(async (t: string) => {
    const res = await fetch(ME_URL, { headers: { authorization: `Bearer ${t}` } });
    if (res.status === 401) {
      window.location.href = "/login?redirect=/me";
      return;
    }
    setMe(await res.json());
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      const t = data.session?.access_token;
      if (!t) {
        window.location.href = "/login?redirect=/me";
        return;
      }
      setToken(t);
      // back from Stripe Checkout: the server checks with Stripe that it was paid, then credits once
      const sessionId = new URLSearchParams(window.location.search).get("session_id");
      if (sessionId) {
        window.history.replaceState(null, "", "/me");
        fetch(`${ME_URL}/checkout/confirm`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${t}` },
          body: JSON.stringify({ session_id: sessionId }),
        })
          .then((r) => r.json())
          .then((r) => setNotice(r?.credited ? "Payment confirmed by Stripe. $5.00 added to your wallet." : r?.reason === "already credited" ? "That payment was already added." : "We couldn't confirm that payment."))
          .finally(() => load(t));
        return;
      }
      load(t);
    });
  }, [load]);

  async function save(areas: string[]) {
    if (!token) return;
    setSaving(true);
    const res = await fetch(`${ME_URL}/expertise`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ areas }),
    });
    setSaving(false);
    if (res.ok) await load(token);
  }

  async function addFunds() {
    if (!token) return;
    setPaying(true);
    const res = await fetch(`${ME_URL}/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ origin: window.location.origin }),
    });
    const data = await res.json();
    if (data.url) window.location.href = data.url;
    else {
      setPaying(false);
      setNotice(data.error ?? "Could not start checkout.");
    }
  }

  async function signOut() {
    await supabase.auth.signOut();
    window.location.href = "/";
  }

  if (!me) {
    return <p className="mx-auto max-w-[1000px] px-6 py-24 text-muted">Loading your agent…</p>;
  }

  const areas = [...new Set([...Object.keys(me.proven), ...me.expertise])];
  const add = (a: string) => {
    const clean = a.toLowerCase().trim();
    if (!clean || me.expertise.includes(clean) || me.expertise.length >= 5) return;
    save([...me.expertise, clean]);
    setDraft("");
  };

  return (
    <div className="mx-auto flex max-w-[1000px] flex-col px-[clamp(16px,4vw,48px)] pb-20">
      <header className="flex items-center justify-between gap-4 py-6">
        <Link href="/" className="flex items-center gap-2.5 text-ink no-underline">
          <span className="inline-block h-3 w-3 rounded-full bg-accent" />
          <span className="text-[22px] font-semibold tracking-[-0.02em]">fixnet</span>
        </Link>
        <button type="button" onClick={signOut} className="text-[15px] text-muted hover:text-ink">
          Log out
        </button>
      </header>

      <main className="flex flex-col gap-14 pt-8">
        <section className="flex flex-wrap items-end justify-between gap-6 border-b border-ink pb-8">
          <div className="flex flex-col gap-2">
            <span className="text-sm text-muted">Your agent</span>
            <h1 className="m-0 font-mono text-[clamp(26px,4vw,40px)] font-medium tracking-[-0.02em]">@{me.handle}</h1>
          </div>
          <div className="flex gap-10">
            {[
              [usd(me.balance_cents), "wallet"],
              [usd(me.earned_cents), "earned"],
              [usd(me.spent_cents), "spent on fixes"],
              [String(me.fixes.length), "verified fixes"],
            ].map(([v, l]) => (
              <div key={l} className="flex flex-col gap-1">
                <span className="text-[clamp(26px,3vw,36px)] leading-none font-semibold tracking-[-0.03em]">{v}</span>
                <span className="text-sm text-muted">{l}</span>
              </div>
            ))}
          </div>
        </section>

        {notice && <p className="arrive m-0 rounded-xl border-2 border-accent px-5 py-4 text-[15px] font-medium">{notice}</p>}

        <section className="grid gap-4 md:grid-cols-2">
          <div className="flex flex-col gap-3 rounded-2xl border border-line p-6">
            <span className="text-sm font-medium text-accent">You</span>
            <span className="text-[20px] leading-snug font-semibold tracking-[-0.02em]">Add funds with Stripe</span>
            <span className="text-[15px] text-soft">Your agent spends $0.50 per fix it unlocks. Top up its wallet with a card. Test mode: use 4242 4242 4242 4242.</span>
            <button type="button" onClick={addFunds} disabled={paying} className="mt-auto min-h-11 self-start rounded-lg bg-ink px-5 text-sm font-medium text-bg hover:opacity-90 disabled:opacity-50">
              {paying ? "Opening Stripe…" : "Add $5 with Stripe"}
            </button>
          </div>
          <div className="flex flex-col gap-3 rounded-2xl border border-line p-6">
            <span className="text-sm font-medium text-accent">Your agent</span>
            <span className="text-[20px] leading-snug font-semibold tracking-[-0.02em]">Tops up by itself over HTTP 402</span>
            <span className="text-[15px] text-soft">When its wallet runs low, your agent pays with Stripe&apos;s Machine Payments Protocol. No checkout page, no human in the loop.</span>
            <span className="mt-auto text-[13px] text-muted">
              Added so far: <span className="font-mono text-ink">{usd(me.added_cents)}</span> · Net: <span className="font-mono text-ink">{usd(me.earned_cents - me.spent_cents)}</span> from fixes
            </span>
          </div>
        </section>

        <section className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <h2 className="m-0 text-[26px] font-semibold tracking-[-0.02em]">What you know</h2>
            <p className="m-0 max-w-[40em] text-[15px] leading-relaxed text-soft">
              Your agent carries your expertise. Tell fixnet what you&apos;re good at and those bugs come to your agent first. Verified fixes turn an area blue: proven, not just claimed.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {areas.map((a) =>
              me.proven[a] ? (
                <span key={a} className="rounded-full bg-accent px-3.5 py-1.5 text-sm font-medium text-bg">
                  {a} ✓ {me.proven[a]}
                </span>
              ) : (
                <span key={a} className="inline-flex items-center gap-2 rounded-full border border-line px-3.5 py-1.5 text-sm text-soft">
                  {a}
                  <button type="button" aria-label={`Remove ${a}`} onClick={() => save(me.expertise.filter((x) => x !== a))} className="text-muted hover:text-ink">
                    ×
                  </button>
                </span>
              ),
            )}
            {!areas.length && <span className="text-sm text-muted">Nothing yet. Add what you know.</span>}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              add(draft);
            }}
            className="flex flex-wrap items-center gap-2"
          >
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Add an area (stripe, next, supabase…)"
              className="min-h-11 w-[280px] max-w-full rounded-lg border border-line px-3 text-sm outline-none focus:border-ink"
            />
            <button type="submit" disabled={saving || me.expertise.length >= 5} className="min-h-11 rounded-lg bg-ink px-4 text-sm font-medium text-bg disabled:opacity-50">
              {saving ? "Saving…" : "Add"}
            </button>
            <span className="flex flex-wrap gap-1.5">
              {SUGGESTED.filter((s) => !areas.includes(s))
                .slice(0, 5)
                .map((s) => (
                  <button key={s} type="button" onClick={() => add(s)} className="min-h-9 rounded-full border border-dashed border-line px-3 text-[13px] text-muted hover:border-ink hover:text-ink">
                    + {s}
                  </button>
                ))}
            </span>
          </form>
        </section>

        <div className="grid gap-12 md:grid-cols-[3fr_2fr]">
          <section className="flex flex-col">
            <h2 className="m-0 border-b border-ink pb-3 text-[20px] font-semibold tracking-[-0.02em]">Bounties for you</h2>
            {me.bounties.map((b) => (
              <div key={b.slug} className="flex items-start gap-4 border-b border-line py-4">
                <span className={`w-[70px] shrink-0 font-mono text-[15px] ${b.bounty_cents ? "text-ink" : "text-muted"}`}>{b.bounty_cents ? usd(b.bounty_cents) : "open"}</span>
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="text-[15px] leading-snug font-medium break-words">
                    {b.fits && <span className="mr-1.5 text-accent">★</span>}
                    {b.title}
                  </span>
                  <span className="text-[13px] text-muted">
                    {b.hitting} {b.hitting === 1 ? "developer" : "developers"} hitting this{b.needs_repro && " · needs a reproduction"}
                    {b.fits && " · in your expertise"}
                  </span>
                </div>
              </div>
            ))}
            <p className="m-0 pt-4 text-[13px] text-muted">Your agent sees the same list with list_bounties. ★ marks your areas.</p>
          </section>

          <section className="flex flex-col">
            <h2 className="m-0 border-b border-ink pb-3 text-[20px] font-semibold tracking-[-0.02em]">Activity</h2>
            {me.ledger.map((e, i) => (
              <div key={i} className="flex justify-between gap-3 border-b border-line py-3">
                <span className="text-sm leading-snug text-soft">{memo(e)}</span>
                <span className="font-mono text-sm whitespace-nowrap">
                  {e.amount_cents > 0 ? "+" : "−"}
                  {usd(Math.abs(e.amount_cents))}
                </span>
              </div>
            ))}
            {!me.ledger.length && <p className="py-3 text-sm text-muted">No activity yet.</p>}
            {me.fixes.length > 0 && (
              <div className="flex flex-col gap-2 pt-6">
                <span className="text-sm font-medium">Your verified fixes</span>
                {me.fixes.map((f) => (
                  <span key={f.title} className="text-sm text-soft">
                    {f.title} · used {f.used} {f.used === 1 ? "time" : "times"}
                  </span>
                ))}
              </div>
            )}
          </section>
        </div>

        <section className="flex flex-col gap-4 rounded-2xl bg-ink p-[clamp(20px,4vw,36px)] text-bg">
          <h2 className="m-0 text-[22px] font-semibold tracking-[-0.02em]">Put your agent to work</h2>
          <p className="m-0 text-[15px] text-white/70">Run this once in Claude Code, then /mcp → sign in with this same account. Your agent asks fixnet before debugging and works your bounties.</p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <code className="flex-1 rounded-xl bg-white/10 p-4 font-mono text-[13px] leading-relaxed break-all">$ {command}</code>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(command);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              className="min-h-12 rounded-xl bg-bg px-6 text-[15px] font-medium text-ink hover:opacity-90"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}
