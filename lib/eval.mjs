// The fixnet eval. One fresh microVM per attempt, network cut, hidden judge.
// reproduced → the original project fails with the expected error
// fixed      → after the patch, the repro command exits 0
// correct    → the hidden judge passes (different inputs than the solver ever saw)
// secure     → the hidden judge's security probe passes (mandatory, never traded for speed)
// simple     → small diff (bonus, not required)
import { randomBytes } from "node:crypto";
import { Sandbox } from "@vercel/sandbox";

const WORK = "/vercel/sandbox/work";
const MAX_FILES = 5;
const MAX_BYTES = 20_000;
const PROTECTED = /^(package\.json|package-lock\.json|node_modules\/|__judge__)/;

export function validatePatch(patch) {
  if (!Array.isArray(patch) || patch.length === 0) return "empty patch";
  if (patch.length > MAX_FILES) return `patch touches more than ${MAX_FILES} files`;
  for (const f of patch) {
    if (typeof f?.path !== "string" || typeof f?.content !== "string") return "malformed file";
    if (f.path.startsWith("/") || f.path.includes("..") || f.path.includes("\\")) return `illegal path ${f.path}`;
    if (PROTECTED.test(f.path)) return `patch touches protected file ${f.path}`;
    if (f.content.length > MAX_BYTES) return `file too large ${f.path}`;
  }
  return null;
}

function changedLines(original, patch) {
  let n = 0;
  for (const f of patch) {
    const before = (original.find((o) => o.path === f.path)?.content ?? "").split("\n");
    const after = f.content.split("\n");
    const len = Math.max(before.length, after.length);
    for (let i = 0; i < len; i++) if (before[i] !== after[i]) n++;
  }
  return n;
}

const toBuf = (files) => files.map((f) => ({ path: `${WORK}/${f.path}`, content: Buffer.from(f.content) }));

async function sh(sandbox, cmd, opts = {}) {
  const r = await sandbox.runCommand({ cmd: "bash", args: ["-c", `cd ${WORK} && timeout 20 ${cmd} 2>&1`], ...opts });
  return { exitCode: r.exitCode, out: (await r.stdout()).slice(-4000) };
}

export async function runEval({ fixture, patch, snapshotId }) {
  const t0 = Date.now();
  const checks = { reproduced: false, fixed: false, correct: false, secure: false, simple: false };
  const logs = [];
  const done = (verdict, note) => ({ verdict, note, checks, logs, duration_ms: Date.now() - t0 });

  const invalid = validatePatch(patch);
  if (invalid) return done("rejected", `Patch refused: ${invalid}.`);

  const sandbox = await Sandbox.create({
    source: { type: "snapshot", snapshotId },
    networkPolicy: "deny-all",
    timeout: 120_000,
    resources: { vcpus: 1 },
    persistent: false,
  });
  try {
    await sandbox.runCommand({ cmd: "bash", args: ["-c", `mkdir -p ${WORK} && ln -s /vercel/sandbox/base/node_modules ${WORK}/node_modules`] });
    await sandbox.writeFiles(toBuf(fixture.files));

    const before = await sh(sandbox, fixture.repro_cmd);
    logs.push({ step: "repro (before)", ...before });
    checks.reproduced = before.exitCode !== 0 && before.out.includes(fixture.expected_error);
    if (!checks.reproduced) return done("error", "Could not reproduce the original error, so nothing can be verified.");

    await sandbox.writeFiles(toBuf(patch));
    const after = await sh(sandbox, fixture.repro_cmd);
    logs.push({ step: "repro (after patch)", ...after });
    checks.fixed = after.exitCode === 0;

    // The judge runs as root with a secret nonce in its env; candidate code runs as `nobody` in child processes.
    // A verdict only counts if it carries the nonce, and exactly once (a second copy means tampering).
    await sandbox.writeFiles(toBuf(fixture.judge_files));
    const nonce = randomBytes(16).toString("hex");
    const judge = await sh(sandbox, fixture.judge_cmd, { sudo: true, env: { FIXNET_NONCE: nonce } });
    logs.push({ step: "hidden judge", exitCode: judge.exitCode, out: judge.out.replaceAll(nonce, "<nonce>") });
    const tag = `FIXNET_CHECKS:${nonce} `;
    const lines = judge.out.split("\n").filter((l) => l.startsWith(tag));
    if (lines.length > 1) return done("rejected", "Tried to tamper with the judge's verdict.");
    const j = lines.length ? JSON.parse(lines[0].slice(tag.length)) : {};
    checks.correct = j.correct === true;
    checks.secure = j.secure === true;
    checks.simple = changedLines(fixture.files, patch) <= 6;

    if (!checks.fixed) return done("rejected", "The original error still happens after the patch.");
    if (!checks.secure) return done("rejected", "Makes the error disappear, but fails the security probe.");
    if (!checks.correct) return done("rejected", "Passes the visible repro, fails the hidden judge.");
    return done("passed", checks.simple ? "Reproduced, fixed, correct and secure. Small diff." : "Reproduced, fixed, correct and secure.");
  } finally {
    await sandbox.stop();
  }
}
