// Run: npm run build && node --expose-gc test/bench/startup.mjs [runs]
//
// Cold start and baseline memory. The MCP client spawns the server at the start
// of every session, so the time to the `initialize` reply is paid every time.
//
//   cold   : spawn dist/index.js over stdio, time to the initialize reply and
//            to the tools/list reply (median of N runs).
//   memory : in-process, RSS and heapUsed after createMcpServer, and after 100
//            typical calls against a fake bridge.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const RUNS = Number(process.argv[2] ?? 9);
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const HOME = mkdtempSync(join(tmpdir(), "cubes-bench-"));
process.env.CUBES_MCP_HOME = HOME;
process.env.CUBES_MCP_OFFLINE = "1";

const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const line = (o) => JSON.stringify(o) + "\n";

async function coldOnce(port) {
  const t0 = performance.now();
  const child = spawn(process.execPath, [join(ROOT, "dist", "index.js")], {
    env: { ...process.env, CUBES_MCP_PORT: String(port), CUBES_MCP_TOKEN: "bench" },
    stdio: ["pipe", "pipe", "ignore"],
  });
  let buf = "";
  let init = 0;
  const list = await new Promise((done, fail) => {
    child.on("exit", () => fail(new Error("server exited early")));
    child.stdout.on("data", (d) => {
      buf += d;
      for (let k; (k = buf.indexOf("\n")) >= 0; buf = buf.slice(k + 1)) {
        const msg = JSON.parse(buf.slice(0, k));
        if (msg.id === 1) {
          init = performance.now() - t0;
          child.stdin.write(line({ jsonrpc: "2.0", method: "notifications/initialized" }));
          child.stdin.write(line({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
        } else if (msg.id === 2) done(performance.now() - t0);
      }
    });
    child.stdin.write(
      line({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bench", version: "1" } },
      }),
    );
  });
  child.removeAllListeners("exit");
  child.kill();
  return { init, list };
}

const cold = [];
for (let i = 0; i < RUNS; i++) cold.push(await coldOnce(46100 + i));
console.log(
  `cold start (median of ${RUNS}): initialize ${median(cold.map((c) => c.init)).toFixed(1)} ms, ` +
    `tools/list ${median(cold.map((c) => c.list)).toFixed(1)} ms`,
);

// ---- memory, in-process against a fake bridge ----
const mb = (n) => (n / 1048576).toFixed(1);
const snap = (label) => {
  globalThis.gc?.();
  const m = process.memoryUsage();
  console.log(`${label.padEnd(22)} rss ${mb(m.rss)} MB, heapUsed ${mb(m.heapUsed)} MB`);
};

const { createMcpServer } = await import("../../dist/server.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");

class FakeTransport {
  connected = true;
  writeEnabled = true;
  async send(tool) {
    if (tool === "read") return { path: "Workspace", className: "Workspace", children: [{ name: "Baseplate", className: "Part" }] };
    return { ok: true };
  }
}

const server = createMcpServer(new FakeTransport());
const h = server._requestHandlers;
const ctx = () => ({ signal: new AbortController().signal });
const call = (name, args) =>
  h.get(CallToolRequestSchema.shape.method.value)({ method: "tools/call", params: { name, arguments: args } }, ctx());
const list = () => h.get(ListToolsRequestSchema.shape.method.value)({ method: "tools/list", params: {} }, ctx());

await list();
snap("after startup");
const QUERIES = ["move a part", "terrain fill", "lighting", "play test", "animation", "sound", "camera"];
for (let i = 0; i < 100; i++) {
  if (i % 4 === 0) await call("search_tools", { query: QUERIES[i % QUERIES.length] });
  else if (i % 4 === 1) await call("read", { path: "Workspace" });
  else if (i % 4 === 2) await list();
  else await call("read", { path: "Workspace.Baseplate" });
}
snap("after 100 calls");
process.exit(0);
