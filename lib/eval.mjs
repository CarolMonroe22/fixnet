// The fixnet eval. One fresh microVM per attempt, network cut, hidden judge.
// reproduced → the original project fails with the expected error
// fixed      → after the patch, the repro command exits 0
// correct    → the hidden judge passes (different inputs than the solver ever saw)
// secure     → the hidden judge's security probe passes (mandatory, never traded for speed)
// simple     → small diff (bonus, not required)
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

async function sh(sandbox, cmd) {
  const r = await sandbox.runCommand({ cmd: "bash", args: ["-c", `cd ${WORK} && timeout 20 ${cmd} 2>&1`] });
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

    await sandbox.writeFiles(toBuf(fixture.judge_files));
    const judge = await sh(sandbox, fixture.judge_cmd);
    logs.push({ step: "hidden judge", ...judge });
    const line = judge.out.split("\n").find((l) => l.startsWith("FIXNET_CHECKS "));
    const j = line ? JSON.parse(line.slice("FIXNET_CHECKS ".length)) : {};
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
