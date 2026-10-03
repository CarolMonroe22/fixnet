// fixnet MCP server, running on Supabase Edge Functions.
// Agents connect with:  claude mcp add --transport http fixnet https://<ref>.supabase.co/functions/v1/fixnet/mcp
// and sign in through Supabase Auth's OAuth 2.1 server (or pass --header "Authorization: Bearer fx_...").
// Supabase does the thinking and the money: pgvector matching, gte-small embeddings, atomic ledger in Postgres, Realtime for the UI.
// Vercel Sandbox only executes the eval (EVAL_URL).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { Hono } from "npm:hono@^4.6.14";
import { McpServer, StreamableHttpTransport } from "npm:mcp-lite@0.8.2";
import { z } from "npm:zod@^4.1.12";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const embedder = new Supabase.ai.Session("gte-small");
const PRICE = 50;

async function embed(text: string) {
  const out = await embedder.run(text.slice(0, 2000), { mean_pool: true, normalize: true });
  return JSON.stringify(Array.from(out as number[]));
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

async function ensureCaseEmbeddings() {
  const { data } = await db.from("cases").select("id, title, error_message").is("embedding", null);
  for (const c of data ?? []) {
    await db.from("cases").update({ embedding: await embed(`${c.error_message}\n${c.title}`) }).eq("id", c.id);
  }
}

// Cases born from the radar have demand but no reproduction yet: show where they were seen.
async function radarCaseText(c: { id: string; title: string; error_message: string; bounty_cents: number }) {
  const { data: seen } = await db.from("signals").select("source, title, url").eq("case_id", c.id).order("posted_at", { ascending: false }).limit(8);
  const list = (seen ?? []).map((s) => `- [${s.source}] ${s.title} ${s.url}`).join("\n");
  return `${c.error_message}\nSpotted by the fixnet radar, no reproduction yet.${c.bounty_cents ? ` Pledged bounty: ${usd(c.bounty_cents)}.` : ""}\n\nSeen in:\n${list}`;
}

function buildServer(agent: { id: string; handle: string }) {
  const mcp = new McpServer({
    name: "fixnet",
    version: "0.1.0",
    schemaAdapter: (schema) => z.toJSONSchema(schema as z.ZodType),
  });

  mcp.tool("ask_network", {
    description:
      "Ask the fixnet network whether another agent already solved this error. Returns verified fixes (reproduced and re-checked in an isolated sandbox) you can unlock, or the open bounty for it. Use this BEFORE spending time debugging a library/runtime error.",
    inputSchema: z.object({
      error: z.string().describe("The exact error message and code"),
      context: z.string().optional().describe("Package names and versions, runtime, what you were doing"),
    }),
    handler: async ({ error, context }: { error: string; context?: string }) => {
      const e = await embed(`${error}\n${context ?? ""}`);
      const { data: fixes } = await db.rpc("match_fixes", { p_embedding: e, p_threshold: 0.8, p_count: 3 });
      if (fixes?.length) {
        const lines = fixes.map(
          (f: any) =>
            `- fix_id ${f.fix_id}: "${f.title}" · verified for ${f.versions} · used ${f.unlock_count} times · ${usd(f.price_cents)} · match ${(f.similarity * 100).toFixed(0)}%`,
        );
        return text(
          `Verified fix found.\n${lines.join("\n")}\n\nCall unlock_fix with the fix_id to get the patch. Cheaper than re-solving it: it was already reproduced, fixed and checked by a hidden judge.`,
        );
      }
      await ensureCaseEmbeddings();
      const { data: cases } = await db.rpc("match_cases", { p_embedding: e, p_threshold: 0.8, p_count: 1 });
      if (cases?.length) {
        const c = cases[0];
        return text(
          `No verified fix yet. This matches the open case "${c.slug}" (${c.title})${c.bounty_cents ? ` with a ${usd(c.bounty_cents)} bounty` : ""}. Call get_case to see the reproduction and submit_fix to solve it and get paid.`,
        );
      }
      return text("Nobody in the network has seen this error yet. Solve it yourself, or come back later.");
    },
  });

  mcp.tool("unlock_fix", {
    description: `Buy a verified fix for ${usd(PRICE)} from your agent balance. 80% goes to the agent that solved it, 20% to the network. Buying the same fix twice is free.`,
    inputSchema: z.object({ fix_id: z.string().uuid() }),
    handler: async ({ fix_id }: { fix_id: string }) => {
      const { data, error } = await db.rpc("purchase_fix", { p_buyer: agent.id, p_fix: fix_id, p_idem: `${agent.id}:${fix_id}` });
      if (error) {
        if (error.message.includes("insufficient")) return text(`Payment required: your balance is too low for a ${usd(PRICE)} fix. Top up and retry.`);
        return text(`Could not unlock: ${error.message}`);
      }
      const files = (data.files as { path: string; content: string }[])
        .map((f) => `--- ${f.path}\n${f.content}`)
        .join("\n");
      const paid = data.already_owned ? "You already owned this fix, no charge." : `Paid ${usd(data.price_cents)}: ${usd(data.solver_cut_cents)} to the solver, ${usd(data.network_cut_cents)} to the network.`;
      return text(`${paid}\n\nWhy it works: ${data.explanation}\n\nPatched files:\n${files}`);
    },
  });

  mcp.tool("list_bounties", {
    description: "List open cases other agents need solved, with their bounty.",
    inputSchema: z.object({}),
    handler: async () => {
      const { data } = await db.from("cases").select("slug, title, bounty_cents, funded_by, status, signal_count").neq("status", "verified").order("bounty_cents", { ascending: false });
      if (!data?.length) return text("No open cases right now.");
      return text(
        data
          .map((c) => {
            const bounty = c.bounty_cents ? ` · ${usd(c.bounty_cents)} bounty by ${c.funded_by}` : "";
            const seen = c.signal_count ? ` · seen in ${c.signal_count} public threads` : "";
            const repro = c.status === "investigating" ? " · needs a reproduction" : "";
            return `- ${c.slug}: ${c.title}${bounty}${seen}${repro}`;
          })
          .join("\n"),
      );
    },
  });

  mcp.tool("get_case", {
    description: "Get the reproduction project for an open case: files, the command that fails, and the expected error. A hidden judge will test your fix with inputs you don't see.",
    inputSchema: z.object({ slug: z.string() }),
    handler: async ({ slug }: { slug: string }) => {
      const { data: c } = await db.from("cases").select("id, slug, title, error_message, versions, bounty_cents").eq("slug", slug).single();
      if (!c) return text("Case not found.");
      const { data: fx } = await db.from("case_fixtures").select("files, repro_cmd").eq("case_id", c.id).maybeSingle();
      if (!fx) return text(await radarCaseText(c));
      const { data: prev } = await db.from("attempts").select("id, status, summary, verdict_note").eq("case_id", c.id).order("created_at");
      const files = (fx!.files as { path: string; content: string }[]).map((f) => `--- ${f.path}\n${f.content}`).join("\n");
      const history = prev?.length ? `\n\nPrevious attempts (build on them):\n${prev.map((p) => `- ${p.id} [${p.status}] ${p.summary}${p.verdict_note ? ` → ${p.verdict_note}` : ""}`).join("\n")}` : "";
      return text(`${c.title}\nVersions: ${c.versions}\nRepro: \`${fx!.repro_cmd}\` fails with: ${c.error_message}\n\n${files}${history}\n\nSubmit only the files you change. package.json and node_modules are locked.`);
    },
  });

  mcp.tool("submit_fix", {
    description: "Submit a fix for an open case. It runs in a fresh isolated sandbox with no network: we reproduce the error, apply your patch, then run a hidden judge that checks correctness and security. If it passes first, you earn the bounty and 80% of every future unlock.",
    inputSchema: z.object({
      slug: z.string(),
      summary: z.string().describe("One sentence: what you changed and why"),
      files: z.array(z.object({ path: z.string(), content: z.string() })).describe("Full content of each file you changed"),
      parent_attempt_id: z.string().uuid().optional().describe("The previous attempt you built on, if any"),
    }),
    handler: async ({ slug, summary, files, parent_attempt_id }: any) => {
      const { data: c } = await db.from("cases").select("id, title, error_message").eq("slug", slug).single();
      if (!c) return text("Case not found.");
      const { data: fx } = await db.from("case_fixtures").select("*").eq("case_id", c.id).maybeSingle();
      if (!fx) return text("This case was spotted by the radar and has no reproduction yet, so there is nothing to judge a fix against. Call get_case to see where it was seen.");
      const { data: at, error } = await db
        .from("attempts")
        .insert({ case_id: c.id, agent_id: agent.id, summary, parent_attempt_id: parent_attempt_id ?? null, status: "running" })
        .select("id")
        .single();
      if (error) return text(`Could not submit: ${error.message}`);
      await db.from("attempt_patches").insert({ attempt_id: at.id, files });

      let r: any;
      try {
        const res = await fetch(Deno.env.get("EVAL_URL")!, {
          method: "POST",
          headers: { "content-type": "application/json", "x-eval-secret": Deno.env.get("EVAL_SECRET")! },
          body: JSON.stringify({ fixture: fx, patch: files }),
        });
        r = await res.json();
      } catch (e) {
        r = { verdict: "error", note: "The eval runner was unreachable.", checks: {}, duration_ms: 0 };
      }
      const passed = r.verdict === "passed";
      const { data: rec } = await db.rpc("record_verdict", {
        p_attempt: at.id,
        p_status: r.verdict,
        p_checks: r.checks ?? {},
        p_note: r.note,
        p_duration: r.duration_ms ?? 0,
        p_fix_title: passed ? c.title : null,
        p_explanation: passed ? summary : null,
        p_embedding: passed ? await embed(`${c.error_message}\n${c.title}`) : null,
      });
      const ch = r.checks ?? {};
      const marks = ["reproduced", "fixed", "correct", "secure", "simple"].map((k) => `${ch[k] ? "✓" : "✗"} ${k}`).join("  ");
      let tail = "";
      if (rec?.fix_id) tail = `\n\nYour fix is now the verified fix for this case.${rec.bounty_paid_cents ? ` Bounty paid: ${usd(rec.bounty_paid_cents)}.` : ""} You earn 80% of every unlock.`;
      else if (passed) tail = "\n\nPassed, but another agent verified a fix first.";
      return text(`Attempt ${at.id}: ${r.verdict.toUpperCase()} (${r.duration_ms} ms)\n${marks}\n${r.note}${tail}`);
    },
  });

  mcp.tool("get_balance", {
    description: "Your agent's balance and latest ledger entries: what it earned helping others and what it spent asking for help.",
    inputSchema: z.object({}),
    handler: async () => {
      const { data: a } = await db.from("agents").select("balance_cents").eq("id", agent.id).single();
      const { data: l } = await db.from("ledger_entries").select("amount_cents, kind, memo").eq("agent_id", agent.id).order("id", { ascending: false }).limit(8);
      const lines = (l ?? []).map((e) => `${e.amount_cents > 0 ? "+" : "−"}${usd(Math.abs(e.amount_cents))}  ${e.kind}  ${e.memo ?? ""}`);
      return text(`@${agent.handle} balance: ${usd(a!.balance_cents)}\n${lines.join("\n")}`);
    },
  });

  return mcp;
}

const app = new Hono();
const mcpApp = new Hono();

mcpApp.get("/", (c) => c.json({ name: "fixnet", mcp: "/functions/v1/fixnet/mcp" }));

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const MCP_URL = `${SUPABASE_URL}/functions/v1/fixnet/mcp`;
const RESOURCE_METADATA = `${SUPABASE_URL}/functions/v1/fixnet/.well-known/oauth-protected-resource`;

// MCP clients discover Supabase Auth (OAuth 2.1 + dynamic client registration) from here.
mcpApp.get("/.well-known/oauth-protected-resource", (c) =>
  c.json({
    resource: MCP_URL,
    authorization_servers: [`${SUPABASE_URL}/auth/v1`],
    scopes_supported: ["openid", "email"],
    bearer_methods_supported: ["header"],
    resource_name: "fixnet",
  }),
);

function unauthorized(c: any, message: string) {
  c.header("WWW-Authenticate", `Bearer resource_metadata="${RESOURCE_METADATA}"`);
  return c.json({ error: message }, 401);
}

// Two ways in: a Supabase Auth OAuth token (the agent acts as its owner), or a raw agent key (fx_...).
async function resolveAgent(token: string) {
  if (token.startsWith("fx_")) {
    const { data } = await db.rpc("agent_from_key", { p_key: token });
    return data as string | null;
  }
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) return null;
  const { data: id } = await db.rpc("agent_for_user", { p_user: data.user.id, p_email: data.user.email ?? null });
  return id as string | null;
}

// Fails closed when the secret is missing, compares in constant time.
function secretMatches(got: string | undefined, want: string | undefined) {
  if (!want || !got || got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

// Nightly re-verification (pg_cron → pg_net → here). Every verified fix runs through the eval again.
// A fix that no longer passes goes stale and its case reopens as a bounty.
mcpApp.post("/reverify", async (c) => {
  if (!secretMatches(c.req.header("x-cron-secret"), Deno.env.get("CRON_SECRET"))) return c.json({ error: "unauthorized" }, 401);
  const { data: fixes } = await db.from("fixes").select("id, case_id, title").eq("status", "verified");
  const results = await Promise.all(
    (fixes ?? []).map(async (f) => {
      const [{ data: fx }, { data: content }] = await Promise.all([
        db.from("case_fixtures").select("*").eq("case_id", f.case_id).single(),
        db.from("fix_contents").select("files").eq("fix_id", f.id).single(),
      ]);
      let r: any;
      try {
        const res = await fetch(Deno.env.get("EVAL_URL")!, {
          method: "POST",
          headers: { "content-type": "application/json", "x-eval-secret": Deno.env.get("EVAL_SECRET")! },
          body: JSON.stringify({ fixture: fx, patch: content!.files }),
        });
        r = await res.json();
      } catch {
        return { fix: f.title, verdict: "skipped", note: "eval runner unreachable" };
      }
      // an infrastructure error is not evidence the fix broke, so only a clear rejection marks it stale
      if (r.verdict === "passed" || r.verdict === "rejected") {
        await db.rpc("mark_fix_checked", { p_fix: f.id, p_passed: r.verdict === "passed", p_note: r.note });
      }
      return { fix: f.title, verdict: r.verdict, note: r.note };
    }),
  );
  // aggregate counts only: eval notes stay in the database
  const count = (v: string) => results.filter((r) => r.verdict === v).length;
  return c.json({ checked: results.length, passed: count("passed"), stale: count("rejected"), skipped: results.length - count("passed") - count("rejected") });
});

// Radar (pg_cron → pg_net → here). Public GitHub issues and Reddit posts about library errors become
// signals; Postgres + pgvector decide whether each one adds demand to a known case or births a new one.
const RADAR = [
  { q: '"ERR_PACKAGE_PATH_NOT_EXPORTED" "./v4"', pkg: "uuid" },
  { q: '"No signatures found matching the expected signature for payload"', pkg: "stripe" },
  { q: '"ERR_MODULE_NOT_FOUND" "Did you mean to import"', pkg: "node" },
  { q: '"ERR_REQUIRE_ESM"', pkg: "node" },
  { q: '"ERR_UNSUPPORTED_DIR_IMPORT"', pkg: "node" },
];
// An actual error line ("TypeError: …", "Error [ERR_X]: …"), not prose that mentions one.
const ERROR_LINE = /(?:^|[\s(>`'"])((?:[A-Z][A-Za-z]*)?(?:Error|Exception)(?: \[[A-Z_]+\])?: [^\n]{8,})/m;

// The first error line, with machine-specific paths and positions stripped, and its code:
// the Node ERR_* code when there is one, else the error class (generic Error/TypeError carry no code).
function extractError(t: string) {
  const m = t.match(ERROR_LINE);
  if (!m) return null;
  const line = m[1];
  const cls = line.match(/^([A-Za-z]+)/)![1];
  const code = line.match(/\bERR_[A-Z_]{3,}/)?.[0] ?? (["Error", "TypeError", "SyntaxError", "ReferenceError", "RangeError"].includes(cls) ? null : cls);
  const error = line
    .replace(/[`*>#]/g, "")
    .replace(/(?<=^|[\s'"(])(?:file:\/\/)?(?:[A-Za-z]:\\|\/[\w.@-]+\/)[^\s'"`),]+/g, "<path>")
    .replace(/:\d+(?::\d+)?/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
  return { error, code };
}

type Post = { source: "github" | "reddit"; url: string; title: string; body: string; posted_at: string | null };

async function searchGithub(q: string): Promise<Post[]> {
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "fixnet-radar" };
  const token = Deno.env.get("GITHUB_TOKEN");
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com/search/issues?q=${encodeURIComponent(`${q} is:issue`)}&sort=created&order=desc&per_page=15`, { headers });
  if (!res.ok) throw new Error(`github ${res.status}`);
  const { items } = await res.json();
  return (items ?? []).map((i: any) => ({ source: "github", url: i.html_url, title: i.title, body: (i.body ?? "").slice(0, 6000), posted_at: i.created_at }));
}

async function searchReddit(q: string): Promise<Post[]> {
  const res = await fetch(`https://www.reddit.com/search.json?q=${encodeURIComponent(q)}&sort=new&limit=4&type=link`, { headers: { "user-agent": "fixnet-radar/0.1" } });
  if (!res.ok) throw new Error(`reddit ${res.status}`);
  const { data } = await res.json();
  return (data?.children ?? []).map(({ data: p }: any) => ({
    source: "reddit",
    url: `https://www.reddit.com${p.permalink}`,
    title: p.title,
    body: (p.selftext ?? "").slice(0, 6000),
    posted_at: p.created_utc ? new Date(p.created_utc * 1000).toISOString() : null,
  }));
}

mcpApp.post("/radar", async (c) => {
  if (!secretMatches(c.req.header("x-cron-secret"), Deno.env.get("CRON_SECRET"))) return c.json({ error: "unauthorized" }, 401);
  await ensureCaseEmbeddings();
  // Embeddings are CPU-bound and an Edge Function has a small CPU budget, so each call runs one query.
  const opts = await c.req.json().catch(() => ({}));
  const i = Number.isInteger(opts.query) ? opts.query : Math.floor(Date.now() / 3_600_000) % RADAR.length;
  const { q, pkg } = RADAR[i % RADAR.length];
  const tally: Record<string, number> = {};
  const errors: string[] = [];
  const born: string[] = [];
  {
    for (const search of [searchGithub, searchReddit]) {
      let posts: Post[] = [];
      try {
        posts = await search(q);
      } catch (e) {
        errors.push(String((e as Error).message));
        continue;
      }
      const { data: known } = await db.from("signals").select("url").in("url", posts.map((p) => p.url));
      const seen = new Set((known ?? []).map((k) => k.url));
      for (const p of posts) {
        if (seen.has(p.url)) {
          tally.duplicate = (tally.duplicate ?? 0) + 1;
          continue;
        }
        const found = extractError(`${p.title}\n${p.body}`);
        if (!found) {
          tally.no_error_line = (tally.no_error_line ?? 0) + 1;
          continue;
        }
        const { data, error: rpcError } = await db.rpc("radar_ingest", {
          p_source: p.source,
          p_url: p.url,
          p_title: p.title,
          p_error: found.error,
          p_code: found.code,
          p_package: pkg,
          p_posted_at: p.posted_at,
          p_embedding: await embed(`${found.error}\n${pkg}`),
          // calibrated on real issues: gte-small puts unrelated errors of one family around 0.85
          p_case_threshold: opts.case_threshold ?? 0.87,
          p_cluster_threshold: opts.cluster_threshold ?? 0.88,
        });
        if (rpcError) {
          errors.push(rpcError.message);
          continue;
        }
        tally[data.action] = (tally[data.action] ?? 0) + 1;
        if (data.action === "born") born.push(data.case);
      }
    }
  }
  return c.json({ query: q, ...tally, born, errors: [...new Set(errors)] });
});

mcpApp.all("/mcp", async (c) => {
  const token = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return unauthorized(c, "Sign in to connect your agent.");
  const agentId = await resolveAgent(token);
  if (!agentId) return unauthorized(c, "Invalid or expired credentials.");
  const { data: agent } = await db.from("agents").select("id, handle").eq("id", agentId).single();
  const handler = new StreamableHttpTransport().bind(buildServer(agent!));
  return handler(c.req.raw);
});

app.route("/fixnet", mcpApp);
Deno.serve(app.fetch);
