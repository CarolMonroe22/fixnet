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
const SAFE_PATH = /^[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;

export function validatePatch(patch) {
  if (!Array.isArray(patch) || patch.length === 0) return "empty patch";
  if (patch.length > MAX_FILES) return `patch touches more than ${MAX_FILES} files`;
  for (const f of patch) {
    if (typeof f?.path !== "string" || typeof f?.content !== "string") return "malformed file";
    // allowlist: plain relative segments only, no "." or ".." segments, no "./" prefixes, at most 3 levels deep
    if (!SAFE_PATH.test(f.path) || f.path.split("/").length > 3) return `illegal path ${f.path}`;
    if (PROTECTED.test(f.path) || f.path === "node_modules") return `patch touches protected file ${f.path}`;
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

// Privilege model inside the microVM:
//  - every file is staged in a 700 directory the candidate can't read (the hidden judge lives there too)
//  - the work dir is copied in by root and is read-only for everyone else
//  - candidate code ALWAYS runs as `nobody`, and every `nobody` process is killed between steps,
//    so nothing it starts can survive to tamper with a later step
//  - the judge runs as root with a secret nonce in its env, and only spawns candidate code as `nobody`
const STAGE = "/vercel/sandbox/stage";
const toBuf = (dir, files) => files.map((f) => ({ path: `${STAGE}/${dir}/${f.path}`, content: Buffer.from(f.content) }));

async function root(sandbox, script, env) {
  const r = await sandbox.runCommand({ cmd: "bash", args: ["-c", `${script} 2>&1`], sudo: true, ...(env ? { env } : {}) });
  return { exitCode: r.exitCode, out: (await r.stdout()).slice(-4000) };
}

// copy a staged dir into the work dir as root, read-only for candidate code
const install = (dir) => `cp -a ${STAGE}/${dir}/. ${WORK}/ && chown -R root:root ${WORK} && chmod -R a+rX,go-w ${WORK}`;
const killCandidate = "pkill -9 -u nobody || true";
const asCandidate = (cmd) => `cd ${WORK} && timeout 20 runuser -u nobody -- env -i PATH="$(dirname "$(command -v node)"):/usr/bin:/bin" HOME=/tmp ${cmd}`;

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
    await sandbox.writeFiles([...toBuf("base", fixture.files), ...toBuf("patch", patch), ...toBuf("judge", fixture.judge_files)]);
    await root(sandbox, `chmod 700 ${STAGE} && mkdir -p ${WORK} && ln -s /vercel/sandbox/base/node_modules ${WORK}/node_modules && ${install("base")}`);

    const before = await root(sandbox, asCandidate(fixture.repro_cmd));
    await root(sandbox, killCandidate);
    logs.push({ step: "repro (before)", ...before });
    checks.reproduced = before.exitCode !== 0 && before.out.includes(fixture.expected_error);
    if (!checks.reproduced) return done("error", "Could not reproduce the original error, so nothing can be verified.");

    await root(sandbox, install("patch"));
    const after = await root(sandbox, asCandidate(fixture.repro_cmd));
    await root(sandbox, killCandidate);
    logs.push({ step: "repro (after patch)", ...after });
    checks.fixed = after.exitCode === 0;

    // A verdict only counts if it carries the nonce, and exactly once (a second copy means tampering).
    const nonce = randomBytes(16).toString("hex");
    const judgeFiles = fixture.judge_files.filter((f) => f.path.startsWith("__judge__")).map((f) => `${WORK}/${f.path}`).join(" ");
    const judge = await root(
      sandbox,
      `${install("judge")} && chmod 600 ${judgeFiles} && cd ${WORK} && timeout 30 ${fixture.judge_cmd}`,
      { FIXNET_NONCE: nonce },
    );
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
