// Seed cases for fixnet. Each case ships:
//  - files:        the starting project with the bug (what the solver sees)
//  - repro_cmd:    must FAIL with expected_error before the patch, and exit 0 after it
//  - judge_files:  hidden files copied in AFTER the patch (solvers never see them)
//  - judge_cmd:    prints `FIXNET_CHECKS {...}` and exits 0 only if the fix is correct and safe
// Dependencies (uuid@9.0.1, stripe@16.12.0) are preinstalled in the sandbox snapshot, never at eval time.

export const cases = [
  {
    slug: "esm-missing-extension",
    title: "ESM import fails without a file extension",
    package: "node",
    versions: "node 24",
    error_code: "ERR_MODULE_NOT_FOUND",
    error_message: "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/app/helper' imported from /app/main.mjs",
    files: [
      { path: "package.json", content: JSON.stringify({ name: "app", private: true, type: "module" }, null, 2) },
      { path: "helper.mjs", content: "export function greet(name) {\n  return `hello, ${name}`;\n}\n" },
      { path: "main.mjs", content: "import { greet } from './helper';\n\nconsole.log(greet(process.argv[2] ?? 'fixnet'));\n" },
    ],
    repro_cmd: "node main.mjs",
    expected_error: "ERR_MODULE_NOT_FOUND",
    judge_files: [
      // hidden: a different helper, so hardcoding the output can't pass
      { path: "helper.mjs", content: "export function greet(name) {\n  return `hola, ${name}`;\n}\n" },
      {
        path: "__judge__.mjs",
        content: `import { execFileSync } from 'node:child_process';
const checks = { correct: false, secure: true };
try {
  const out = execFileSync('node', ['main.mjs', 'judge-7731'], { encoding: 'utf8' }).trim();
  checks.correct = out === 'hola, judge-7731';
} catch {}
console.log('FIXNET_CHECKS ' + JSON.stringify(checks));
process.exit(checks.correct && checks.secure ? 0 : 1);
`,
      },
    ],
    judge_cmd: "node __judge__.mjs",
  },
  {
    slug: "uuid-path-not-exported",
    title: "require('uuid/v4') breaks after upgrading to uuid 9",
    package: "uuid",
    versions: "uuid 9.0.1, node 24",
    error_code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
    error_message: "Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './v4' is not defined by \"exports\" in node_modules/uuid/package.json",
    files: [
      { path: "package.json", content: JSON.stringify({ name: "app", private: true, dependencies: { uuid: "9.0.1" } }, null, 2) },
      { path: "id.cjs", content: "const v4 = require('uuid/v4');\n\nmodule.exports = { newId: () => v4() };\n" },
      { path: "main.cjs", content: "const { newId } = require('./id.cjs');\n\nconsole.log(newId());\n" },
    ],
    repro_cmd: "node main.cjs",
    expected_error: "ERR_PACKAGE_PATH_NOT_EXPORTED",
    judge_files: [
      {
        path: "__judge__.cjs",
        content: `const fs = require('fs');
const checks = { correct: false, secure: false };
try {
  const { newId } = require('./id.cjs');
  const a = newId(), b = newId();
  const re = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  checks.correct = re.test(a) && re.test(b) && a !== b;
  const src = fs.readFileSync(__dirname + '/id.cjs', 'utf8');
  // a hand-rolled Math.random "uuid" is not a fix, it's a collision waiting to happen
  checks.secure = /require\\(['"]uuid['"]\\)/.test(src) && !/Math\\.random/.test(src);
} catch {}
console.log('FIXNET_CHECKS ' + JSON.stringify(checks));
process.exit(checks.correct && checks.secure ? 0 : 1);
`,
      },
    ],
    judge_cmd: "node __judge__.cjs",
  },
  {
    slug: "stripe-webhook-raw-body",
    title: "Stripe webhook signature fails after JSON body parsing",
    package: "stripe",
    versions: "stripe 16.12.0, node 24",
    error_code: "StripeSignatureVerificationError",
    error_message: "StripeSignatureVerificationError: No signatures found matching the expected signature for payload. Are you passing the raw request body you received from Stripe?",
    files: [
      { path: "package.json", content: JSON.stringify({ name: "app", private: true, dependencies: { stripe: "16.12.0" } }, null, 2) },
      {
        path: "webhook.cjs",
        content: `const Stripe = require('stripe');
const stripe = new Stripe('sk_test_fixnet_dummy');

// rawBody is the exact string Stripe sent
function handleWebhook(rawBody, signature, secret) {
  const payload = JSON.stringify(JSON.parse(rawBody)); // body parser already touched it
  return stripe.webhooks.constructEvent(payload, signature, secret);
}

module.exports = { handleWebhook };
`,
      },
      {
        path: "repro.cjs",
        content: `const Stripe = require('stripe');
const stripe = new Stripe('sk_test_fixnet_dummy');
const { handleWebhook } = require('./webhook.cjs');

const secret = 'whsec_fixnet_demo';
const raw = JSON.stringify({ id: 'evt_demo', object: 'event', type: 'checkout.session.completed' }, null, 2);
const header = stripe.webhooks.generateTestHeaderString({ payload: raw, secret });
console.log('ok', handleWebhook(raw, header, secret).id);
`,
      },
    ],
    repro_cmd: "node repro.cjs",
    expected_error: "No signatures found matching the expected signature",
    judge_files: [
      {
        path: "__judge__.cjs",
        content: `const Stripe = require('stripe');
const stripe = new Stripe('sk_test_fixnet_dummy');
const { handleWebhook } = require('./webhook.cjs');
const checks = { correct: false, secure: false };
const secret = 'whsec_judge_' + Math.floor(Math.random() * 1e6);
const raw = JSON.stringify({ id: 'evt_judge_91', object: 'event', type: 'invoice.paid' }, null, 4);
try {
  const header = stripe.webhooks.generateTestHeaderString({ payload: raw, secret });
  checks.correct = handleWebhook(raw, header, secret).id === 'evt_judge_91';
} catch {}
try {
  // forged: signed with the wrong secret. A real fix must still reject it.
  const forged = stripe.webhooks.generateTestHeaderString({ payload: raw, secret: 'whsec_attacker' });
  handleWebhook(raw, forged, secret);
  checks.secure = false;
} catch { checks.secure = true; }
console.log('FIXNET_CHECKS ' + JSON.stringify(checks));
process.exit(checks.correct && checks.secure ? 0 : 1);
`,
      },
    ],
    judge_cmd: "node __judge__.cjs",
  },
];
