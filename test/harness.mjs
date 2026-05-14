#!/usr/bin/env node
/**
 * End-to-end test harness for cube's mcp.
 *
 * Spawns the MCP server, speaks MCP (JSON-RPC over stdio) to it, and exercises
 * every phase's features. The server it spawns ALSO listens on :44820, so the
 * Roblox Studio plugin connects to *this* server while the suite runs — watch
 * the place change in Studio as it goes.
 *
 *   npm run build          # the harness runs dist/index.js
 *   npm run test:e2e       # scripted suite
 *   npm run test:repl      # interactive prompt
 *
 * Prereqs for the Studio-dependent tests:
 *   - rojo build plugin.project.json into your Studio Plugins folder
 *   - a place open in Studio with the CubesMCP plugin connected
 *   - "Allow writes" toggled ON in the panel (for the mutate / run_code tests)
 *   - nothing else holding port 44820
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "dist", "index.js");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------------------
// Minimal MCP client over stdio.
// --------------------------------------------------------------------------
class McpClient {
  constructor() {
    this.proc = spawn("node", [SERVER], { cwd: ROOT, stdio: ["pipe", "pipe", "inherit"] });
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.proc.stdout.on("data", (chunk) => this._onData(chunk));
    this.proc.on("exit", (code) => {
      for (const { reject } of this.pending.values()) reject(new Error(`server process exited (code ${code})`));
      this.pending.clear();
    });
  }

  _onData(chunk) {
    this.buffer += chunk.toString("utf8");
    let nl;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // not JSON — ignore
      }
      const entry = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
      if (entry) {
        this.pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        else entry.resolve(msg.result);
      }
      // notifications (no id) are not asserted on here — just ignored
    }
  }

  request(method, params = {}, timeoutMs = 40_000) {
    if (this.proc.exitCode !== null) return Promise.reject(new Error("server is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => (clearTimeout(timer), resolve(r)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      try {
        this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  notify(method, params = {}) {
    try {
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    } catch {
      /* server gone — harmless here */
    }
  }

  async initialize() {
    const res = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "cubes-mcp-harness", version: "1.0" },
    });
    this.notify("notifications/initialized");
    return res;
  }

  /** Call a tool; unwrap the JSON payload from content[0].text. */
  async callTool(name, args = {}) {
    const res = await this.request("tools/call", { name, arguments: args });
    const text = res?.content?.[0]?.text;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  /** Read a resource; unwrap the JSON payload from contents[0].text. */
  async readResource(uri) {
    const res = await this.request("resources/read", { uri });
    const text = res?.contents?.[0]?.text;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  close() {
    try {
      this.proc.stdin.end();
    } catch {
      /* ignore */
    }
    this.proc.kill();
  }
}

// --------------------------------------------------------------------------
// Assertions.
// --------------------------------------------------------------------------
let passed = 0;
let failed = 0;
let skipped = 0;

function check(label, cond, detail) {
  if (cond) {
    console.log(`  \x1b[32mPASS\x1b[0m  ${label}`);
    passed += 1;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m  ${label}${detail ? `  — ${trunc(detail)}` : ""}`);
    failed += 1;
  }
}
function skip(label, why) {
  console.log(`  \x1b[33mSKIP\x1b[0m  ${label}${why ? `  — ${why}` : ""}`);
  skipped += 1;
}
function section(name) {
  console.log(`\n\x1b[1m== ${name} ==\x1b[0m`);
}
function trunc(v) {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 140 ? s.slice(0, 140) + "…" : s;
}

// --------------------------------------------------------------------------
// Wait for the Studio plugin to connect to our freshly-spawned server.
// --------------------------------------------------------------------------
async function waitForStudio(client, maxTries = 12) {
  for (let i = 0; i < maxTries; i += 1) {
    const probe = await client.callTool("read", { path: "Workspace" });
    if (!(probe && probe.error === "studio_not_connected")) return true;
    if (i === 0) process.stdout.write("  waiting for the Studio plugin to connect");
    else process.stdout.write(".");
    await delay(2500);
  }
  process.stdout.write("\n");
  return false;
}

// --------------------------------------------------------------------------
// The scripted suite.
// --------------------------------------------------------------------------
async function runSuite(client) {
  section("handshake");
  const init = await client.initialize();
  check("initialize returns serverInfo", init?.serverInfo?.name === "cubes-roblox-mcp", init?.serverInfo);

  section("discovery");
  const tools = (await client.request("tools/list")).tools ?? [];
  const toolNames = tools.map((t) => t.name);
  check(
    "the 4 core tools are present",
    ["search_tools", "read", "mutate", "run_code"].every((n) => toolNames.includes(n)),
    toolNames.join(", "),
  );
  const resources = (await client.request("resources/list")).resources ?? [];
  check("4 studio:// resources are listed", resources.length >= 4, resources.map((r) => r.uri).join(", "));

  section("bridge connectivity");
  const connected = await waitForStudio(client);
  if (!connected) {
    console.log("  \x1b[33mStudio is not connected to this server.\x1b[0m");
    console.log("  → Open Roblox Studio with a place + the CubesMCP plugin, make sure the");
    console.log("    panel shows 'Connected', and that nothing else holds port 44820.");
    console.log("  (skipping every Studio-dependent test)");
    return;
  }
  check("Studio plugin is connected", true);

  section("reads");
  const ws = await client.callTool("read", { path: "Workspace", children: true });
  check("read Workspace children returns items", Array.isArray(ws.items), ws.error ?? `${ws.count} items`);
  check("read response carries cost meta", typeof ws.meta?.elapsed_ms === "number", ws.meta);
  if (ws.snapshot) {
    const reread = await client.callTool("read", { path: "Workspace", children: true, since: ws.snapshot });
    check("snapshot re-read returns unchanged", reread.unchanged === true, reread);
  } else {
    skip("snapshot re-read", "no snapshot on the first read");
  }

  section("writes  (needs 'Allow writes' ON in the panel)");
  const created = await client.callTool("mutate", {
    ops: [
      {
        id: "a",
        op: "create",
        class: "Part",
        parent: "Workspace",
        name: "CubesMCP_TestPart",
        props: { Anchored: true, Position: [0, 50, 0] },
      },
    ],
  });
  if (created.error === "write_mode_disabled") {
    skip("mutate create", "writes are OFF — flip 'Allow writes' in the Studio panel");
    skip("read-back / set / delete / run_code / lint", "depends on write mode");
  } else {
    check("mutate create returns applied:true", created.applied === true, created);
    const ref = created.changes?.[0]?.ref;
    check("create returned a ref token", typeof ref === "string", ref);

    if (ref) {
      const back = await client.callTool("read", { ref });
      check("read back the created Part", back.items?.[0]?.name === "CubesMCP_TestPart", back.items?.[0]);

      const set = await client.callTool("mutate", { ops: [{ op: "set", target: ref, props: { Transparency: 0.5 } }] });
      check("mutate set property works", set.applied === true, set);

      const delNoConfirm = await client.callTool("mutate", { ops: [{ op: "delete", target: ref }] });
      check("delete without confirm → needs_confirmation", delNoConfirm.error === "needs_confirmation", delNoConfirm);

      const del = await client.callTool("mutate", { ops: [{ op: "delete", target: ref }], confirm: true });
      check("delete with confirm:true succeeds", del.applied === true, del);
    }

    const rc = await client.callTool("run_code", { luau: "return 6 * 7" });
    check("run_code returns 42", rc.result === 42, rc);

    // inline lint: a script write with a deliberate error should come back flagged
    const scriptMut = await client.callTool("mutate", {
      ops: [
        {
          id: "s",
          op: "create",
          class: "Script",
          parent: "Workspace",
          name: "CubesMCP_TestScript",
          props: { Source: "local x = 1\nprint(undefinedGlobalThing)\n" },
        },
      ],
    });
    check("script write returns a lint report", Array.isArray(scriptMut.lint), scriptMut.lint);
    check(
      "lint caught the undefined global",
      (scriptMut.lint?.[0]?.errorCount ?? 0) > 0,
      scriptMut.lint?.[0],
    );
    const scriptRef = scriptMut.changes?.[0]?.ref;
    if (scriptRef) {
      await client.callTool("mutate", { ops: [{ op: "delete", target: scriptRef }], confirm: true });
    }
  }

  section("search + specialist tools");
  const search = await client.callTool("search_tools", { query: "configure lighting brightness and fog" });
  check("search_tools unlocks specialists", (search.unlocked ?? []).length > 0, (search.unlocked ?? []).map((u) => u.name));
  check("successful response carries next_likely", Array.isArray(search.next_likely), search.next_likely);

  section("resources");
  const history = await client.readResource("studio://session/history");
  check("history resource has entries", Array.isArray(history.history) && history.history.length > 0, `${history.history?.length} entries`);
  const selection = await client.readResource("studio://selection");
  check("selection resource works", selection && !selection.error, selection);
  const errs = await client.readResource("studio://errors/recent");
  check("errors resource works", errs && !errs.error, errs?.runMode ? `runMode=${errs.runMode}` : errs);

  section("viewport grounding");
  const vp = await client.callTool("read", { viewport: true });
  check("viewport returns a camera", vp.camera && typeof vp.camera.fieldOfView === "number", vp.camera);
  check("viewport returns an instances array", Array.isArray(vp.instances), `${vp.instances?.length} on-screen`);
}

// --------------------------------------------------------------------------
// Interactive mode.
// --------------------------------------------------------------------------
async function repl(client) {
  await client.initialize();
  console.log("\nInteractive MCP harness — the spawned server is on :44820.");
  console.log("  <tool> <json-args>     e.g.  read {\"path\":\"Workspace\",\"children\":true}");
  console.log("  :res <uri>             e.g.  :res studio://session/history");
  console.log("  :tools                 list currently-visible tools");
  console.log("  :quit\n");
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "mcp> " });
  rl.prompt();
  for await (const line of rl) {
    const t = line.trim();
    if (!t) {
      rl.prompt();
      continue;
    }
    if (t === ":quit" || t === ":q") break;
    try {
      if (t === ":tools") {
        const tools = (await client.request("tools/list")).tools ?? [];
        console.log(tools.map((x) => x.name).join(", "));
      } else if (t.startsWith(":res ")) {
        console.log(JSON.stringify(await client.readResource(t.slice(5).trim()), null, 2));
      } else {
        const sp = t.indexOf(" ");
        const name = sp < 0 ? t : t.slice(0, sp);
        const args = sp < 0 ? {} : JSON.parse(t.slice(sp + 1));
        console.log(JSON.stringify(await client.callTool(name, args), null, 2));
      }
    } catch (err) {
      console.log("error:", err.message);
    }
    rl.prompt();
  }
  rl.close();
}

// --------------------------------------------------------------------------
// Entry point.
// --------------------------------------------------------------------------
async function main() {
  if (!existsSync(SERVER)) {
    console.error(`Build the server first: npm run build  (missing ${SERVER})`);
    process.exit(1);
  }
  const interactive = process.argv.includes("--interactive") || process.argv.includes("-i");
  const client = new McpClient();
  await delay(300); // let the server bind + wire its stdio transport

  try {
    if (interactive) {
      await repl(client);
    } else {
      await runSuite(client);
      console.log(`\n\x1b[1m${passed} passed, ${failed} failed, ${skipped} skipped\x1b[0m`);
    }
  } catch (err) {
    console.error(`\n\x1b[31mharness error:\x1b[0m ${err.message}`);
    failed += 1;
  } finally {
    client.close();
  }
  process.exit(failed > 0 ? 1 : 0);
}

main();
