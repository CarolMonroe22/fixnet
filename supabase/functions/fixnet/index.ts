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
      const { data } = await db.from("cases").select("slug, title, bounty_cents, funded_by, status").neq("status", "verified").order("bounty_cents", { ascending: false });
      if (!data?.length) return text("No open cases right now.");
      return text(data.map((c) => `- ${c.slug}: ${c.title}${c.bounty_cents ? ` · ${usd(c.bounty_cents)} bounty by ${c.funded_by}` : ""}`).join("\n"));
    },
  });

  mcp.tool("get_case", {
    description: "Get the reproduction project for an open case: files, the command that fails, and the expected error. A hidden judge will test your fix with inputs you don't see.",
    inputSchema: z.object({ slug: z.string() }),
    handler: async ({ slug }: { slug: string }) => {
      const { data: c } = await db.from("cases").select("id, slug, title, error_message, versions, bounty_cents").eq("slug", slug).single();
      if (!c) return text("Case not found.");
      const { data: fx } = await db.from("case_fixtures").select("files, repro_cmd").eq("case_id", c.id).single();
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
      const { data: fx } = await db.from("case_fixtures").select("*").eq("case_id", c.id).single();
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

// Nightly re-verification (pg_cron → pg_net → here). Every verified fix runs through the eval again.
// A fix that no longer passes goes stale and its case reopens as a bounty.
mcpApp.post("/reverify", async (c) => {
  if (c.req.header("x-cron-secret") !== Deno.env.get("CRON_SECRET")) return c.json({ error: "unauthorized" }, 401);
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
  return c.json({ checked: results.length, results });
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
