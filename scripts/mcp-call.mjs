// Tiny MCP client for testing: node scripts/mcp-call.mjs <agent-key> <tool> '<json args>'
const [key, tool, args = "{}"] = process.argv.slice(2);
const URL = process.env.FIXNET_MCP_URL ?? "https://kbxnrqqoffgmwwzywgtn.supabase.co/functions/v1/fixnet/mcp";
const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${key}` };

async function rpc(method, params, id = 1) {
  const res = await fetch(URL, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  const body = await res.text();
  const json = body.startsWith("{") ? JSON.parse(body) : JSON.parse(body.split("\n").find((l) => l.startsWith("data:")).slice(5));
  return { status: res.status, json };
}

await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixnet-test", version: "0" } });
const r = tool === "list" ? await rpc("tools/list", {}, 2) : await rpc("tools/call", { name: tool, arguments: JSON.parse(args) }, 2);
if (r.json.result?.content) console.log(r.json.result.content.map((c) => c.text).join("\n"));
else console.log(r.status, JSON.stringify(r.json.result ?? r.json.error ?? r.json, null, 1));
