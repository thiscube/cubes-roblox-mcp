#!/usr/bin/env node
// Build the placeholder Shop UI by sending shop.luau through run_code.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "dist", "index.js");
const LUAU = readFileSync(join(ROOT, "test", "shop.luau"), "utf8");

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
    try { msg = JSON.parse(line); } catch { continue; }
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
async function callTool(name, args) {
  const r = await send("tools/call", { name, arguments: args });
  const text = r?.content?.[0]?.text;
  return typeof text === "string" ? JSON.parse(text) : r;
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "build-shop", version: "0.0.1" },
  });
  await delay(1800);
  let result;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    result = await callTool("run_code", { luau: LUAU });
    if (result?.error === "studio_not_connected") {
      await delay(1500);
      continue;
    }
    break;
  }
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error("shop error:", err);
  process.exitCode = 1;
} finally {
  proc.kill();
}
