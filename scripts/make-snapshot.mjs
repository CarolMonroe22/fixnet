// Builds the eval snapshot once: Node 24 + pinned deps for the seed cases.
// Evals boot from this snapshot with the network cut, so nothing is installed at eval time.
// Usage: node --env-file=.env.local scripts/make-snapshot.mjs
import { Sandbox } from "@vercel/sandbox";

const sandbox = await Sandbox.create({ image: "vercel/sandbox/node:24", timeout: 300_000, persistent: false });
const pkg = { name: "fixnet-base", private: true, dependencies: { uuid: "9.0.1", stripe: "16.12.0" } };

await sandbox.writeFiles([{ path: "/vercel/sandbox/base/package.json", content: Buffer.from(JSON.stringify(pkg)) }]);
const install = await sandbox.runCommand({ cmd: "npm", args: ["install", "--no-audit", "--no-fund"], cwd: "/vercel/sandbox/base" });
if (install.exitCode !== 0) {
  console.error(await install.stderr());
  await sandbox.stop();
  process.exit(1);
}
const snap = await sandbox.snapshot({ snapshotExpiration: 0 });
console.log("FIXNET_SNAPSHOT_ID=" + snap.snapshotId);
