// Executor only: runs one attempt in a fresh Vercel Sandbox and returns the verdict.
// It never touches the database. Supabase (the MCP Edge Function) calls it with a shared secret
// and records the verdict, the fix and the money in Postgres.
import { timingSafeEqual } from "node:crypto";
import { runEval } from "@/lib/eval.mjs";

export const maxDuration = 120;

function authorized(req: Request) {
  const got = Buffer.from(req.headers.get("x-eval-secret") ?? "");
  const want = Buffer.from(process.env.EVAL_SECRET ?? "");
  return want.length > 0 && got.length === want.length && timingSafeEqual(got, want);
}

export async function POST(req: Request) {
  if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { fixture, patch } = await req.json();
  try {
    const result = await runEval({ fixture, patch, snapshotId: fixture.snapshot_id ?? process.env.FIXNET_SNAPSHOT_ID });
    return Response.json(result);
  } catch (e) {
    return Response.json({ verdict: "error", note: "The sandbox failed to run this attempt.", error: String(e) }, { status: 500 });
  }
}
