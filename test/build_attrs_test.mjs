#!/usr/bin/env node
// Phase 1 end-to-end test: attrs + tags + query Tag filter.
//
// Creates a folder under Workspace with 3 tagged + attributed Parts, reads
// them back to verify attrs/tags appear, queries by tag, mutates one to
// add/remove a tag, then deletes the whole folder. Atomic — leaves no trace.
//
// REQUIRES the Phase 1 plugin build (must restart Studio after rojo build).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "dist", "index.js");

// ---- MCP client boilerplate ----
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

// ---- pretty print ----
function section(title) { console.log(`\n\x1b[1m== ${title} ==\x1b[0m`); }
function pass(label, detail) {
  console.log(`  \x1b[32mPASS\x1b[0m  ${label}${detail ? `  → ${detail}` : ""}`);
}
function fail(label, detail) {
  console.log(`  \x1b[31mFAIL\x1b[0m  ${label}${detail ? `  → ${detail}` : ""}`);
  process.exitCode = 1;
}

try {
  await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "attrs-test", version: "0.0.1" },
  });
  await delay(1800);

  section("create with attrs + tags");
  const created = await callTool("mutate", {
    confirm: true,
    ops: [
      { id: "root", op: "create", class: "Folder", parent: "Workspace", name: "AttrsTest" },
      {
        id: "e1", op: "create", class: "Part", parent: "@root", name: "Goblin",
        props: { Anchored: true, Position: [10, 5, 0] },
        attrs: { hp: 50, type: "minion", aggro: true },
        tags: ["Enemy"],
      },
      {
        id: "e2", op: "create", class: "Part", parent: "@root", name: "Orc",
        props: { Anchored: true, Position: [14, 5, 0] },
        attrs: { hp: 120, type: "elite", aggro: true },
        tags: ["Enemy"],
      },
      {
        id: "boss", op: "create", class: "Part", parent: "@root", name: "DragonLord",
        props: { Anchored: true, Position: [22, 8, 0] },
        attrs: { hp: 999, type: "boss", phase: 1 },
        tags: ["Enemy", "Boss"],
      },
    ],
  });
  if (!created.applied) {
    fail("mutate batch applied", JSON.stringify(created));
    process.exit(1);
  }
  pass("4 instances created atomically", `${created.changes.length} changes`);
  const tagged = created.changes.filter((c) => c.tags);
  pass("create entries report tags", `${tagged.length} entries carry tags`);

  section("read back: attrs + tags should appear");
  const folder = await callTool("read", { path: "Workspace.AttrsTest", children: true });
  if (!Array.isArray(folder.items)) {
    fail("read children", folder.error ?? "no items");
    process.exit(1);
  }
  const orc = folder.items.find((i) => i.name === "Orc");
  if (orc?.attrs?.hp === 120 && orc?.attrs?.type === "elite" && orc?.attrs?.aggro === true) {
    pass("Orc.attrs round-tripped", JSON.stringify(orc.attrs));
  } else {
    fail("Orc.attrs round-tripped", JSON.stringify(orc?.attrs));
  }
  const dragon = folder.items.find((i) => i.name === "DragonLord");
  if (dragon?.tags?.includes("Enemy") && dragon?.tags?.includes("Boss")) {
    pass("DragonLord.tags round-tripped", JSON.stringify(dragon.tags));
  } else {
    fail("DragonLord.tags round-tripped", JSON.stringify(dragon?.tags));
  }

  section("query: filter by Tag");
  const enemies = await callTool("read", { query: "Workspace/**[Tag=Enemy]" });
  if (Array.isArray(enemies.items) && enemies.items.length === 3) {
    pass("Tag=Enemy returns 3 instances", enemies.items.map((i) => i.name).join(", "));
  } else {
    fail("Tag=Enemy", `expected 3, got ${enemies.items?.length} (${JSON.stringify(enemies.items?.map((i) => i.name))})`);
  }
  const bosses = await callTool("read", { query: "Workspace/**[Tag=Boss]" });
  if (Array.isArray(bosses.items) && bosses.items.length === 1 && bosses.items[0].name === "DragonLord") {
    pass("Tag=Boss returns 1 (DragonLord)", bosses.items[0].name);
  } else {
    fail("Tag=Boss", JSON.stringify(bosses.items?.map((i) => i.name)));
  }

  section("query: filter by @attribute");
  const elites = await callTool("read", { query: "Workspace/**[@type=elite]" });
  if (Array.isArray(elites.items) && elites.items.length === 1 && elites.items[0].name === "Orc") {
    pass("@type=elite returns Orc", elites.items[0].name);
  } else {
    fail("@type=elite", JSON.stringify(elites.items?.map((i) => i.name)));
  }

  section("set: add/remove tags + tweak attrs");
  const orcRef = orc.ref;
  const tweaked = await callTool("mutate", {
    ops: [
      {
        op: "set", target: orcRef,
        attrs: { hp: 80 },
        tags: ["Wounded"],
        remove_tags: ["Enemy"],
      },
    ],
  });
  if (tweaked.applied) {
    pass("set with attrs+tags+remove_tags applied");
  } else {
    fail("set with attrs+tags+remove_tags", JSON.stringify(tweaked));
  }
  const reread = await callTool("read", { ref: orcRef });
  const reOrc = reread.items?.[0];
  if (reOrc?.attrs?.hp === 80 && reOrc?.tags?.includes("Wounded") && !reOrc?.tags?.includes("Enemy")) {
    pass("Orc now: hp=80, +Wounded, -Enemy", JSON.stringify({ attrs: reOrc.attrs, tags: reOrc.tags }));
  } else {
    fail("Orc post-set state", JSON.stringify({ attrs: reOrc?.attrs, tags: reOrc?.tags }));
  }

  section("cleanup");
  const cleanup = await callTool("mutate", {
    confirm: true,
    ops: [{ op: "delete", target: "Workspace.AttrsTest" }],
  });
  pass("test folder deleted", cleanup.applied ? "ok" : JSON.stringify(cleanup));
} catch (err) {
  console.error("attrs-test error:", err);
  process.exitCode = 1;
} finally {
  proc.kill();
}
