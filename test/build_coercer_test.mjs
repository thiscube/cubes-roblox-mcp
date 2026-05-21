#!/usr/bin/env node
// Minimal mutate-only smoke test for the new property coercers
// (UDim, NumberRange, ColorSequence, NumberSequence). Builds a small probe
// instance under Workspace then deletes it.
//
// REQUIRES the new plugin build (post-Mutate.luau coercer extension) — run
// after restarting Studio so the fresh CubesMCP.rbxm is loaded.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "dist", "index.js");

const ops = [
  // Container so we can sweep everything up in one delete.
  {
    id: "probe",
    op: "create",
    class: "Folder",
    parent: "Workspace",
    name: "CoercerProbe",
  },
  // UIGradient on a ScreenGui: exercises ColorSequence keypoints + NumberSequence keypoints.
  {
    id: "sgui",
    op: "create",
    class: "ScreenGui",
    parent: "@probe",
    name: "Sg",
  },
  {
    id: "frame",
    op: "create",
    class: "Frame",
    parent: "@sgui",
    name: "Frame",
    props: {
      Size: [0, 200, 0, 200], // UDim2
      BackgroundColor3: [0.5, 0.5, 0.5],
    },
  },
  // UICorner: tests UDim coercer.
  {
    id: "corner",
    op: "create",
    class: "UICorner",
    parent: "@frame",
    props: {
      CornerRadius: [0, 12], // UDim
    },
  },
  // UIGradient: tests ColorSequence keypoints + NumberSequence keypoints.
  {
    id: "grad",
    op: "create",
    class: "UIGradient",
    parent: "@frame",
    props: {
      Color: {
        keypoints: [
          { time: 0, value: [0.9, 0.3, 0.3] },
          { time: 1, value: [0.3, 0.3, 0.9] },
        ],
      },
      Transparency: {
        keypoints: [
          { time: 0, value: 0 },
          { time: 1, value: 0.6 },
        ],
      },
    },
  },
  // ParticleEmitter: tests NumberRange + ColorSequence single-color + NumberSequence simple form.
  {
    id: "part",
    op: "create",
    class: "Part",
    parent: "@probe",
    props: {
      Anchored: true,
      Transparency: 1, // invisible probe part
    },
  },
  {
    id: "emitter",
    op: "create",
    class: "ParticleEmitter",
    parent: "@part",
    props: {
      Rate: 5,
      Lifetime: [1, 2], // NumberRange
      Speed: 3, // NumberRange via scalar shortcut
      Color: [0.2, 0.9, 0.5], // ColorSequence single-color
      Size: [0, 1], // NumberSequence two-keypoint min/max envelope
    },
  },
];

// Delete it after — atomic test, no garbage left behind.
ops.push({ op: "delete", target: "@probe" });

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
    clientInfo: { name: "coercer-test", version: "0.0.1" },
  });
  await delay(1800);
  let result;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    result = await callTool("mutate", { ops, confirm: true });
    if (result?.error === "studio_not_connected") {
      await delay(1500);
      continue;
    }
    break;
  }
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result?.applied ? 0 : 1;
} catch (err) {
  console.error("coercer-test error:", err);
  process.exitCode = 1;
} finally {
  proc.kill();
}
