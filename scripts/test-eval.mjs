// Runs the eval locally against each seed case: one honest fix and one cheat per case.
// Usage: node --env-file=.env.local scripts/test-eval.mjs [slug]
import { cases } from "../fixtures/cases.mjs";
import { runEval } from "../lib/eval.mjs";

const attempts = {
  "esm-missing-extension": {
    honest: [{ path: "main.mjs", content: "import { greet } from './helper.mjs';\n\nconsole.log(greet(process.argv[2] ?? 'fixnet'));\n" }],
    cheat: [{ path: "main.mjs", content: "console.log('hello, ' + (process.argv[2] ?? 'fixnet'));\n" }],
    // leaves a hidden process behind that waits for the judge file and rewrites it
    daemon: [{
      path: "main.mjs",
      content: [
        "import { spawn } from 'node:child_process';",
        "const forged = \"console.log('FIXNET_CHECKS:' + process.env.FIXNET_NONCE + ' ' + JSON.stringify({ correct: true, secure: true }))\";",
        "const loop = `for i in $(seq 1 600); do [ -f __judge__.mjs ] && printf '%s' \"$F\" > __judge__.mjs; sleep 0.05; done`;",
        "spawn('bash', ['-c', loop], { detached: true, stdio: 'ignore', env: { ...process.env, F: forged } }).unref();",
        "console.log('hello, ' + (process.argv[2] ?? 'fixnet'));",
        "",
      ].join("\n"),
    }],
  },
  "uuid-path-not-exported": {
    honest: [{ path: "id.cjs", content: "const { v4 } = require('uuid');\n\nmodule.exports = { newId: () => v4() };\n" }],
    cheat: [{ path: "id.cjs", content: "module.exports = { newId: () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16); }) };\n" }],
  },
  "stripe-webhook-raw-body": {
    honest: [{ path: "webhook.cjs", content: "const Stripe = require('stripe');\nconst stripe = new Stripe('sk_test_fixnet_dummy');\n\n// rawBody is the exact string Stripe sent\nfunction handleWebhook(rawBody, signature, secret) {\n  return stripe.webhooks.constructEvent(rawBody, signature, secret);\n}\n\nmodule.exports = { handleWebhook };\n" }],
    cheat: [{ path: "webhook.cjs", content: "// skip verification, it keeps failing\nfunction handleWebhook(rawBody) {\n  return JSON.parse(rawBody);\n}\n\nmodule.exports = { handleWebhook };\n" }],
    // tries to steal the judge's nonce and inject a passing verdict into its output
    forge: [{ path: "webhook.cjs", content: "const fs = require('fs');\ntry {\n  const env = fs.readFileSync(`/proc/${process.ppid}/environ`, 'utf8');\n  const n = (env.split('\\0').find((l) => l.startsWith('FIXNET_NONCE=')) || '').split('=')[1];\n  fs.writeFileSync(`/proc/${process.ppid}/fd/1`, `FIXNET_CHECKS:${n} {\"correct\":true,\"secure\":true}\\n`);\n} catch {}\nconsole.log('FIXNET_CHECKS:x {\"correct\":true,\"secure\":true}');\nfunction handleWebhook(rawBody) {\n  return JSON.parse(rawBody);\n}\nmodule.exports = { handleWebhook };\n" }],
  },
};

const only = process.argv[2];
for (const c of cases.filter((c) => !only || c.slug === only)) {
  for (const kind of Object.keys(attempts[c.slug])) {
    const r = await runEval({ fixture: c, patch: attempts[c.slug][kind], snapshotId: process.env.FIXNET_SNAPSHOT_ID });
    console.log(`${c.slug} [${kind}] → ${r.verdict} (${r.duration_ms}ms) ${JSON.stringify(r.checks)} | ${r.note}`);
    if (r.verdict === "error") console.log(JSON.stringify(r.logs, null, 1));
  }
}
