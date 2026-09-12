/**
 * Several Studio windows, one server (PLAN.md #11).
 *
 * The plugin half that reports distinct ids per window is not in this repo, so
 * what is testable here is the server half: that a window is recorded, that a
 * targeted command reaches only that window, and — most importantly — that a
 * plugin which sends no id at all behaves exactly as it always has. That last
 * one is the whole compatibility story, since protocol 5 is additive.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { StudioBridge } from "../../dist/bridge.js";
import { MAX_PROTOCOL_VERSION } from "../../dist/protocol.js";
import { rpcReadOnlyCommands } from "../../dist/rpc-policy.js";
import { SESSION_TOOLS } from "../../dist/tools/session.js";
import "./_fixtures.mjs";

async function makeBridge() {
  const bridge = new StudioBridge(0, { readOnlyCommands: rpcReadOnlyCommands() });
  await bridge.start();
  const base = `http://127.0.0.1:${bridge.boundPort}`;
  const post = (path, body) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bridge.token}` },
      body: JSON.stringify(body),
    });
  return { bridge, post };
}

/**
 * A plugin that polls once and reports what it was handed.
 *
 * Not awaited by the caller: a poll with nothing queued long-holds for 25s.
 */
function poll(post, identity = {}) {
  return post("/poll", {
    protocol: MAX_PROTOCOL_VERSION,
    writeEnabled: true,
    ...identity,
  })
    .then(async (res) => (res.status === 204 ? null : res.json()))
    // A poll still parked when the bridge stops rejects afterwards. Swallowing
    // it here keeps that from surfacing as an unhandled rejection that fails the
    // whole file rather than any one test.
    .catch(() => null);
}

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

describe("studio instances", () => {
  test("a plugin that sends no id still works, filed under one default", async () => {
    const { bridge, post } = await makeBridge();
    try {
      const handed = poll(post);
      await settle();

      const listed = bridge.listInstances();
      assert.equal(listed.length, 1);
      assert.equal(listed[0].transport, "long-poll");
      assert.equal(listed[0].writeEnabled, true);
      assert.equal(listed[0].protocol, MAX_PROTOCOL_VERSION);

      // And an untargeted command still reaches it, exactly as before.
      const sent = bridge.send("read", { path: "Workspace" }, 3000);
      const cmd = await handed;
      assert.equal(cmd.tool, "read");
      await post("/result", { id: cmd.id, ok: true, result: { ok: true } });
      assert.deepEqual(await sent, { ok: true });
    } finally {
      await bridge.stop();
    }
  });

  test("identity is recorded when the plugin sends it", async () => {
    const { bridge, post } = await makeBridge();
    try {
      poll(post, { instanceId: "win-a", placeId: 4242, placeName: "Lobby", role: "edit" });
      await settle();
      const [only] = bridge.listInstances();
      assert.equal(only.id, "win-a");
      assert.equal(only.placeId, 4242);
      assert.equal(only.placeName, "Lobby");
      assert.equal(only.role, "edit");
    } finally {
      await bridge.stop();
    }
  });

  test("two windows are tracked separately", async () => {
    const { bridge, post } = await makeBridge();
    try {
      poll(post, { instanceId: "win-a", role: "edit" });
      poll(post, { instanceId: "win-b", role: "server" });
      await settle();
      assert.deepEqual(
        bridge.listInstances().map((i) => i.id).sort(),
        ["win-a", "win-b"],
      );
    } finally {
      await bridge.stop();
    }
  });

  test("a targeted command goes only to the window it names", async () => {
    const { bridge, post } = await makeBridge();
    try {
      const a = poll(post, { instanceId: "win-a" });
      const b = poll(post, { instanceId: "win-b" });
      await settle();

      bridge.send("read", { which: "b" }, 3000, "win-b").catch(() => {});
      const forB = await b;
      assert.equal(forB.args.which, "b", "win-b should have been handed it");

      // win-a is still parked, holding nothing.
      const raced = await Promise.race([a, settle(120).then(() => "still parked")]);
      assert.equal(raced, "still parked");
    } finally {
      await bridge.stop();
    }
  });

  test("a command for an absent window waits rather than going to the wrong one", async () => {
    const { bridge, post } = await makeBridge();
    try {
      const a = poll(post, { instanceId: "win-a" });
      await settle();

      const pending = bridge.send("read", {}, 400, "win-elsewhere").catch((e) => e.code);
      await settle(120);
      assert.equal(bridge.queueDepth, 1, "it must queue, not divert");

      const raced = await Promise.race([a, settle(80).then(() => "still parked")]);
      assert.equal(raced, "still parked", "win-a must not be handed someone else's command");
      assert.equal(await pending, "studio_timeout");
    } finally {
      await bridge.stop();
    }
  });

  test("an untargeted command still goes to whoever is parked", async () => {
    const { bridge, post } = await makeBridge();
    try {
      const a = poll(post, { instanceId: "win-a" });
      await settle();
      bridge.send("read", {}, 3000).catch(() => {});
      const cmd = await a;
      assert.equal(cmd.tool, "read");
    } finally {
      await bridge.stop();
    }
  });

  test("/health reports the connected windows", async () => {
    const { bridge, post } = await makeBridge();
    try {
      poll(post, { instanceId: "win-a", placeName: "Lobby" });
      await settle();
      const health = await (await fetch(`http://127.0.0.1:${bridge.boundPort}/health`, { method: "POST" })).json();
      assert.equal(health.protocol, MAX_PROTOCOL_VERSION);
      assert.equal(health.instances.length, 1);
      assert.equal(health.instances[0].placeName, "Lobby");
    } finally {
      await bridge.stop();
    }
  });
});

describe("studio_instances tool", () => {
  const tool = SESSION_TOOLS.find((t) => t.name === "studio_instances");

  test("it reads through the seam, and copes with a transport that has none", async () => {
    // Optional on StudioTransport on purpose: a fake in a test has no windows,
    // and a second transport (Open Cloud) has no notion of one.
    const res = await tool.handler({}, { bridge: { connected: true, writeEnabled: true } });
    assert.deepEqual(res.instances, []);
    assert.equal(res.count, 0);
    assert.match(res.hint, /No Studio window/);
  });

  test("it reports age and warns when several windows are connected", async () => {
    const now = Date.now();
    const res = await tool.handler(
      {},
      {
        bridge: {
          connected: true,
          writeEnabled: true,
          listInstances: () => [
            { id: "a", role: "edit", transport: "long-poll", writeEnabled: true, lastSeen: now - 3000, protocol: 5 },
            { id: "b", role: "server", transport: "websocket", writeEnabled: false, lastSeen: now, protocol: 5 },
          ],
        },
      },
    );
    assert.equal(res.count, 2);
    assert.equal(res.instances[0].secondsSinceSeen, 3);
    assert.match(res.note, /polls first/);
  });

  test("it is read-only, so the inspector build keeps it", async () => {
    const { capabilities } = await import("../../dist/registry.js");
    assert.equal(capabilities(tool).write, false);
    assert.equal(capabilities(tool).writesDisk, false);
  });
});
