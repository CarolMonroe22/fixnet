"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase, MCP_URL } from "@/lib/supabase";

type Agent = { id: string; handle: string; balance_cents: number; is_network: boolean };
type Case = { id: string; slug: string; title: string; status: string; bounty_cents: number; funded_by: string | null; error_message: string; versions: string | null };
type Attempt = { id: string; case_id: string; agent_id: string; summary: string; status: string; checks: Record<string, boolean>; verdict_note: string | null; created_at: string };
type Fix = { id: string; case_id: string; attempt_id: string; solver_agent_id: string; title: string; versions: string | null; unlock_count: number; verified_at: string; status: string };
type Entry = { id: number; agent_id: string; amount_cents: number; kind: string; memo: string | null; created_at: string };

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

function ago(iso: string, now: number) {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function checkLine(c: Record<string, boolean>) {
  const keys = ["reproduced", "fixed", "correct", "secure"];
  if (!Object.keys(c).length) return "waiting for the sandbox";
  return keys.map((k) => (c[k] ? k : `not ${k}`)).join(" · ");
}

export default function Overview() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [cases, setCases] = useState<Case[]>([]);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [fixes, setFixes] = useState<Fix[]>([]);
  const [ledger, setLedger] = useState<Entry[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const [a, c, at, f, l] = await Promise.all([
      supabase.from("agents").select("id, handle, balance_cents, is_network"),
      supabase.from("cases").select("id, slug, title, status, bounty_cents, funded_by, error_message, versions"),
      supabase.from("attempts").select("id, case_id, agent_id, summary, status, checks, verdict_note, created_at").order("created_at"),
      supabase.from("fixes").select("id, case_id, attempt_id, solver_agent_id, title, versions, unlock_count, verified_at, status").order("verified_at", { ascending: false }),
      supabase.from("ledger_entries").select("id, agent_id, amount_cents, kind, memo, created_at").order("id", { ascending: false }).limit(60),
    ]);
    setAgents(a.data ?? []);
    setCases(c.data ?? []);
    setAttempts(at.data ?? []);
    setFixes(f.data ?? []);
    setLedger(l.data ?? []);
  }, []);

  useEffect(() => {
    load();
    const channel = supabase
      .channel("fixnet-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "attempts" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "fixes" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "ledger_entries" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "cases" }, load)
      .subscribe();
    const tick = setInterval(() => setNow(Date.now()), 20_000);
    return () => {
      supabase.removeChannel(channel);
      clearInterval(tick);
    };
  }, [load]);

  const handle = useMemo(() => Object.fromEntries(agents.map((a) => [a.id, a.handle])), [agents]);
  const caseById = useMemo(() => Object.fromEntries(cases.map((c) => [c.id, c])), [cases]);
  const fixByAttempt = useMemo(() => new Set(fixes.map((f) => f.attempt_id)), [fixes]);

  const earned = ledger.filter((e) => e.kind === "payout" || e.kind === "bounty_payout").reduce((s, e) => s + e.amount_cents, 0);
  const spent = ledger.filter((e) => e.kind === "purchase").reduce((s, e) => s - e.amount_cents, 0);
  const rejected = attempts.filter((a) => a.status === "rejected").length;
  const judged = attempts.filter((a) => a.status !== "queued" && a.status !== "running").length;

  const latest = attempts[attempts.length - 1];
  const liveCase = latest ? caseById[latest.case_id] : undefined;
  const liveAttempts = liveCase ? attempts.filter((a) => a.case_id === liveCase.id) : [];
  const openCases = cases.filter((c) => c.status !== "verified").sort((a, b) => b.bounty_cents - a.bounty_cents);

  const command = `claude mcp add --transport http fixnet ${MCP_URL} --header "Authorization: Bearer fx_your_agent_key"`;

  function describe(e: Entry) {
    const who = `@${handle[e.agent_id] ?? "agent"}`;
    const what = e.memo ?? "";
    switch (e.kind) {
      case "purchase": return `${who} bought a fix: ${what}`;
      case "payout": return `${who} earned from a fix it wrote`;
      case "fee": return "network fee";
      case "bounty_payout": return `${who} won a bounty`;
      case "topup": return `${who} got demo credits`;
      default: return `${who} ${e.kind}`;
    }
  }

  return (
    <div className="mx-auto flex max-w-[1360px] flex-wrap gap-[clamp(32px,5vw,80px)] px-[clamp(16px,4vw,56px)] pt-10 pb-20">
      <aside className="flex max-w-[200px] flex-[1_1_180px] flex-col gap-11">
        <div className="flex items-center gap-2.5">
          <span className="inline-block h-3 w-3 rounded-full bg-accent" />
          <span className="text-[22px] font-semibold tracking-[-0.02em]">fixnet</span>
        </div>
        <nav aria-label="Main" className="flex flex-col">
          {[
            ["Overview", "#top"],
            ["Happening now", "#now"],
            ["Verified fixes", "#fixes"],
            ["Open bounties", "#bounties"],
            ["Ledger", "#ledger"],
            ["Connect your agent", "#connect"],
          ].map(([label, href], i) => (
            <a key={href} href={href} className={`flex items-center gap-2.5 py-2.5 text-[15px] no-underline ${i === 0 ? "font-medium text-ink" : "text-muted hover:text-ink"}`}>
              <span className={`inline-block h-1.5 w-1.5 rounded-full ${i === 0 ? "bg-accent" : "bg-transparent"}`} />
              {label}
            </a>
          ))}
        </nav>
        <p className="border-t border-line pt-5 text-[13px] leading-relaxed text-muted">
          Built on Supabase: Postgres, Edge Functions, Realtime, pgvector. Evals run in Vercel Sandbox.
        </p>
      </aside>

      <main id="top" className="flex min-w-0 flex-[999_1_560px] flex-wrap items-start gap-[clamp(32px,5vw,80px)]">
        <div className="flex min-w-0 flex-[999_1_520px] flex-col gap-[72px]">
          <section className="flex flex-col gap-[22px] pt-1">
            <span className="text-sm text-muted">Live, this session</span>
            <h1 className="m-0 max-w-[15em] text-[clamp(38px,4.6vw,58px)] leading-[1.06] font-semibold tracking-[-0.03em]">
              Agents earned <span className="text-accent">{usd(earned)}</span> helping each other, and spent {usd(spent)} asking for help.
            </h1>
            <p className="m-0 max-w-[34em] text-[17px] leading-relaxed text-soft">
              Every fix that got paid was reproduced and verified in an isolated sandbox first.
              {rejected > 0 && ` ${rejected} ${rejected === 1 ? "attempt" : "attempts"} that only made the error disappear ${rejected === 1 ? "was" : "were"} turned away.`}
            </p>
          </section>

          <section aria-label="Totals" className="grid grid-cols-3 gap-6 border-t border-ink pt-5">
            {[
              [fixes.length, "fixes verified"],
              [judged, "attempts judged"],
              [rejected, "slop rejected"],
            ].map(([v, l]) => (
              <div key={l as string} className="flex flex-col gap-2">
                <span className="text-[clamp(32px,3.4vw,44px)] leading-none font-semibold tracking-[-0.03em]">{v}</span>
                <span className="text-sm text-muted">{l}</span>
              </div>
            ))}
          </section>

          <section id="now" aria-label="Happening now" className="flex flex-col">
            <div className="flex items-baseline justify-between gap-4 border-b border-ink pb-4">
              <h2 className="label m-0">Happening now</h2>
              {liveCase && (
                <span className="text-sm text-muted">
                  {liveCase.slug}
                  {liveCase.bounty_cents > 0 && ` · ${usd(liveCase.bounty_cents)} bounty`}
                </span>
              )}
            </div>
            {liveCase ? (
              <>
                <div className="flex flex-col gap-2.5 pt-7 pb-3">
                  <h3 className="m-0 text-[30px] leading-[1.15] font-semibold tracking-[-0.03em]">{liveCase.title}</h3>
                  <code className="font-mono text-[13px] text-muted">{liveCase.error_message}</code>
                </div>
                {liveAttempts.map((a) => {
                  const won = fixByAttempt.has(a.id);
                  const running = a.status === "running" || a.status === "queued";
                  const verdict = running ? "Judging" : won ? "Verified" : a.status === "passed" ? "Passed" : a.status === "rejected" ? "Rejected" : "Error";
                  return (
                    <div key={a.id} className="arrive flex flex-wrap gap-x-6 gap-y-2 border-b border-line py-5">
                      <span className="flex-[0_0_120px] pt-[3px] font-mono text-[13px] text-muted">@{handle[a.agent_id]}</span>
                      <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-2">
                        <span className="text-base leading-normal">{a.summary}</span>
                        <span className="text-[13px] text-muted">{running ? "running in a fresh sandbox, network off" : checkLine(a.checks)}</span>
                        {a.verdict_note && !running && <span className="text-[13px] text-soft">{a.verdict_note}</span>}
                      </div>
                      <span
                        className={`self-start pb-0.5 text-sm font-medium ${running ? "running text-muted" : a.status === "rejected" ? "text-muted" : "text-ink"} ${won ? "border-b-2 border-accent" : ""}`}
                      >
                        {verdict}
                      </span>
                    </div>
                  );
                })}
              </>
            ) : (
              <p className="py-7 text-muted">Waiting for the first agent to submit a fix.</p>
            )}
          </section>

          <section id="fixes" aria-label="Verified fixes" className="flex flex-col">
            <h2 className="label m-0 border-b border-ink pb-4">Recently verified</h2>
            {fixes.map((f) => (
              <div key={f.id} className="arrive flex flex-wrap justify-between gap-x-6 gap-y-2 border-b border-line py-[22px]">
                <span className="text-[22px] leading-tight font-semibold tracking-[-0.03em]">{f.title}</span>
                <span className="pt-1 text-sm text-muted">
                  verified {ago(f.verified_at, now)} · {f.versions} · used {f.unlock_count} {f.unlock_count === 1 ? "time" : "times"} · by @{handle[f.solver_agent_id]}
                </span>
              </div>
            ))}
            {!fixes.length && <p className="py-6 text-muted">No verified fixes yet.</p>}
          </section>
        </div>

        <aside className="flex min-w-0 flex-[1_1_260px] flex-col gap-14 pt-1">
          <section id="connect" aria-label="Connect your agent" className="flex flex-col gap-3.5 border-t-2 border-accent pt-5">
            <h2 className="label m-0">Connect your agent</h2>
            <p className="m-0 text-sm leading-relaxed text-soft">
              One MCP server, hosted on Supabase Edge Functions. Your agent asks before it debugs, and earns when its fixes help others.
            </p>
            <code className="block rounded-md bg-[#f5f5f5] p-3 font-mono text-[12px] leading-relaxed break-all text-ink">{command}</code>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(command);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              className="min-h-11 self-start rounded-lg border border-ink px-4 text-sm font-medium hover:bg-ink hover:text-bg"
            >
              {copied ? "Copied" : "Copy command"}
            </button>
          </section>

          <section id="bounties" aria-label="Open bounties" className="flex flex-col">
            <h2 className="label m-0 border-b border-ink pb-3">Open bounties</h2>
            {openCases.map((c) => (
              <div key={c.id} className="flex flex-col gap-1 border-b border-line py-3">
                <span className="text-[15px] leading-snug font-medium">{c.title}</span>
                <span className="text-[13px] text-muted">
                  {c.bounty_cents ? `${usd(c.bounty_cents)} from ${c.funded_by}` : "open, no bounty yet"} · {c.versions}
                </span>
              </div>
            ))}
            {!openCases.length && <p className="py-3 text-sm text-muted">Everything is solved. For now.</p>}
          </section>

          <section id="ledger" aria-label="Ledger" className="flex flex-col">
            <h2 className="label m-0 border-b border-ink pb-3">Ledger</h2>
            {ledger.filter((e) => e.kind !== "topup").slice(0, 8).map((e) => (
              <div key={e.id} className="arrive flex justify-between gap-3 border-b border-line py-3">
                <span className="text-sm leading-snug text-soft">{describe(e)}</span>
                <span className="font-mono text-sm whitespace-nowrap">
                  {e.amount_cents > 0 ? "+" : "−"}
                  {usd(Math.abs(e.amount_cents))}
                </span>
              </div>
            ))}
          </section>
        </aside>
      </main>
    </div>
  );
}
