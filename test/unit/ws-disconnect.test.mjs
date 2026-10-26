/**
 * A socket that closes with commands in flight fails them with
 * studio_disconnected after a short grace, instead of making each wait out its
 * full timeout. If the plugin comes back inside the grace (here: by posting the
 * result over HTTP), the command is answered normally.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";

import { StudioBridge } from "../../dist/bridge.js";
import { MAX_PROTOCOL_VERSION } from "../../dist/protocol.js";
import { rpcReadOnlyCommands } from "../../dist/rpc-policy.js";
import "./_fixtures.mjs";

async function setup() {
  const bridge = new StudioBridge(0, { readOnlyCommands: rpcReadOnlyCommands() });
  await bridge.start();
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.boundPort}/ws`, {
    headers: { authorization: `Bearer ${bridge.token}` },
  });
  await new Promise((r) => ws.once("open", r));
  const commands = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "command") commands.push(msg);
  });
  ws.send(JSON.stringify({ type: "hello", protocol: MAX_PROTOCOL_VERSION, writeEnabled: false }));
  await new Promise((r) => setTimeout(r, 50));
  return { bridge, ws, commands };
}

describe("websocket disconnect", () => {
  test("in-flight commands fail fast with studio_disconnected", async () => {
    const { bridge, ws } = await setup();
    try {
      const started = Date.now();
      const p = bridge.send("read", { path: "Workspace" }, 20_000);
      await new Promise((r) => setTimeout(r, 50));
      ws.close();
      await assert.rejects(p, (e) => e.code === "studio_disconnected");
      assert.ok(Date.now() - started < 5_000, "should not wait out the 20s timeout");
    } finally {
      await bridge.stop();
    }
  });

  test("a result posted over HTTP within the grace still resolves", async () => {
    const { bridge, ws, commands } = await setup();
    try {
      const p = bridge.send("read", { path: "Workspace" }, 20_000);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(commands.length, 1);
      ws.close();
      await new Promise((r) => setTimeout(r, 200));
      const res = await fetch(`http://127.0.0.1:${bridge.boundPort}/result`, {
        method: "POST",
        headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
        body: JSON.stringify({ id: commands[0].id, ok: true, result: { late: true } }),
      });
      assert.ok(res.ok);
      assert.deepEqual(await p, { late: true });
    } finally {
      await bridge.stop();
    }
  });
});
