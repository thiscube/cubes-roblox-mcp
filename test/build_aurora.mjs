#!/usr/bin/env node
// Build a glowing aurora arch in Workspace via a single atomic mutate batch.
// Demonstrates: ref tokens within a batch, multi-class instance creation,
// neon material, point lights, attribute writes.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "dist", "index.js");

const PILLAR_COUNT = 12;
const ARCH_WIDTH = 18;
const ARCH_HEIGHT = 7;
const ARCH_Z = -25;

// Rainbow gradient (RGB 0..1) for the pillars.
const RAINBOW = [
  [1.00, 0.25, 0.30],
  [1.00, 0.45, 0.20],
  [1.00, 0.85, 0.15],
  [0.60, 1.00, 0.20],
  [0.20, 1.00, 0.45],
  [0.15, 1.00, 0.85],
  [0.20, 0.65, 1.00],
  [0.35, 0.30, 1.00],
  [0.60, 0.20, 1.00],
  [0.90, 0.25, 1.00],
  [1.00, 0.30, 0.80],
  [1.00, 0.50, 0.55],
];

const ops = [
  { id: "portal", op: "create", class: "Model", parent: "Workspace", name: "AuroraPortal" },
];

for (let i = 0; i < PILLAR_COUNT; i += 1) {
  const t = i / (PILLAR_COUNT - 1);
  const theta = t * Math.PI;
  const x = (t - 0.5) * ARCH_WIDTH;
  const height = Math.sin(theta) * ARCH_HEIGHT + 1.0;
  const y = height / 2;
  ops.push({
    id: `p${i}`,
    op: "create",
    class: "Part",
    parent: "@portal",
    name: `Pillar${i + 1}`,
    props: {
      Anchored: true,
      CanCollide: false,
      Material: "Neon",
      Size: [0.9, Number(height.toFixed(3)), 0.9],
      Position: [Number(x.toFixed(3)), Number(y.toFixed(3)), ARCH_Z],
      Color: RAINBOW[i],
    },
  });
}

// Floating core at the arch apex.
ops.push({
  id: "core",
  op: "create",
  class: "Part",
  parent: "@portal",
  name: "Core",
  props: {
    Anchored: true,
    CanCollide: false,
    Material: "Neon",
    Shape: "Ball",
    Size: [2.5, 2.5, 2.5],
    Position: [0, ARCH_HEIGHT + 1.8, ARCH_Z],
    Color: [0.25, 0.85, 1.0],
    Transparency: 0.15,
  },
});

// Glow light parented to the core.
ops.push({
  id: "light",
  op: "create",
  class: "PointLight",
  parent: "@core",
  props: {
    Brightness: 6,
    Range: 35,
    Color: [0.25, 0.85, 1.0],
  },
});

// Second light, parented to the middle pillar, for an extra wash of color from below.
ops.push({
  id: "underlight",
  op: "create",
  class: "PointLight",
  parent: `@p${Math.floor(PILLAR_COUNT / 2)}`,
  props: {
    Brightness: 3,
    Range: 20,
    Color: [0.7, 0.4, 1.0],
  },
});

// ---- MCP client (compact) -----------------------------------------------
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
    clientInfo: { name: "build-aurora", version: "0.0.1" },
  });
  // Give the Studio plugin a moment to poll in.
  await delay(1800);

  // Retry until the plugin's connected.
  let result;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    result = await callTool("mutate", { ops });
    if (result?.error === "studio_not_connected") {
      await delay(1500);
      continue;
    }
    break;
  }

  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error("build error:", err);
  process.exitCode = 1;
} finally {
  proc.kill();
}
