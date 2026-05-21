#!/usr/bin/env node
// One-shot probe: spawn the MCP server, call a single tool, print the result.
// Usage: node test/probe.mjs <tool> '<json-args>'
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "dist", "index.js");

const tool = process.argv[2];
const args = JSON.parse(process.argv[3] ?? "{}");
if (!tool) {
  console.error("usage: node test/probe.mjs <tool> '<json-args>'");
  process.exit(1);
}

const proc = spawn("node", [SERVER], { cwd: ROOT, stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
const pending = new Map();
let nextId = 1;

proc.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const entry = pending.get(msg.id);
    if (entry) {
      pending.delete(msg.id);
      msg.error ? entry.reject(msg.error) : entry.resolve(msg.result);
    }
  }
});

function send(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "probe", version: "0.0.1" },
  });
  // The bridge needs a moment for the Studio plugin to poll in.
  await delay(1500);

  // Retry: bridge.connected has a heartbeat window; if the plugin's mid-cycle, retry.
  let result;
  for (let i = 0; i < 4; i += 1) {
    const r = await send("tools/call", { name: tool, arguments: args });
    const text = r?.content?.[0]?.text;
    const parsed = typeof text === "string" ? JSON.parse(text) : r;
    if (parsed && parsed.error === "studio_not_connected") {
      await delay(1500);
      continue;
    }
    result = parsed;
    break;
  }
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error("probe error:", err);
} finally {
  proc.kill();
}
