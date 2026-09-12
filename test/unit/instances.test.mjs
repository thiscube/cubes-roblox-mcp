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
import { INSTANCES_TOOLS } from "../../dist/tools/instances.js";
import { capabilities } from "../../dist/registry.js";
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

  test("a window that stops polling is pruned, not remembered forever", async () => {
    // A plugin that restarts picks a new id, so without pruning the map keeps
    // every window the session has ever seen.
    const { bridge, post } = await makeBridge();
    try {
      poll(post, { instanceId: "win-gone" });
      await settle();
      assert.equal(bridge.listInstances().length, 1);

      // Reach past the heartbeat window without waiting 30 seconds for it.
      const [entry] = bridge.listInstances();
      entry.lastSeen = Date.now() - 10 * 60_000;
      assert.deepEqual(bridge.listInstances(), []);
    } finally {
      await bridge.stop();
    }
  });

  test("a new socket does not inherit the previous socket's identity", async () => {
    // Between adopting a socket and its `hello`, it has no identity. Inheriting
    // one would hand a command addressed to the window that just left to the
    // window that just arrived.
    const { bridge } = await makeBridge();
    const WebSocket = (await import("ws")).default;
    const url = `ws://127.0.0.1:${bridge.boundPort}/ws`;
    const open = (u) =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(u, { headers: { authorization: `Bearer ${bridge.token}` } });
        ws.once("open", () => resolve(ws));
        ws.once("error", reject);
      });
    try {
      const first = await open(url);
      first.send(JSON.stringify({ type: "hello", protocol: MAX_PROTOCOL_VERSION, instanceId: "win-a" }));
      await settle();
      assert.deepEqual(bridge.listInstances().map((i) => i.id), ["win-a"]);

      // A second socket, which has NOT said hello yet.
      const second = await open(url);
      await settle();
      const pending = bridge.send("read", {}, 300, "win-a").catch((e) => e.code);
      await settle(80);
      assert.equal(bridge.queueDepth, 1, "it must wait for win-a, not go to the new socket");
      assert.equal(await pending, "studio_timeout");
      second.close();
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
    // The note has to say the honest thing: the bridge can route by id, but no
    // tool accepts one yet, so a second window is a hazard rather than a target.
    assert.match(res.note, /answers first/);
    assert.match(res.note, /does not expose it/);
  });

  test("it is read-only, so the inspector build keeps it", async () => {
    const { capabilities } = await import("../../dist/registry.js");
    assert.equal(capabilities(tool).write, false);
    assert.equal(capabilities(tool).writesDisk, false);
  });
});

/**
 * CollectionService tags (gap #2).
 *
 * Tags are how most real places mark doors, spawners and interactables, and the
 * server had no way to see them at all. The split into two tools is the point:
 * reading tags is something the read-only build must be able to do, and it can
 * only claim that if the Luau it generates provably never writes — so the two
 * halves cannot share a tool with an `op` argument.
 */
describe("tags", () => {
  const find = INSTANCES_TOOLS.find((t) => t.name === "tags_find");
  const set = INSTANCES_TOOLS.find((t) => t.name === "tags_set");

  /** Run a tool against a bridge that records the Luau instead of sending it. */
  async function luauFor(tool, args) {
    let sent = "";
    await tool.handler(args, {
      bridge: {
        connected: true,
        writeEnabled: true,
        async send(_cmd, payload) {
          sent = String(payload?.luau ?? "");
          return {};
        },
      },
    });
    return sent;
  }

  test("reading is read-class and writing is not", () => {
    assert.equal(capabilities(find).write, false, "tags_find must survive the read-only build");
    assert.equal(capabilities(find).inspectorSafe, true);
    assert.equal(capabilities(set).write, true, "AddTag/RemoveTag mutate the place");
    assert.equal(capabilities(set).inspectorSafe, false);
  });

  test("the read tool generates Luau that never writes", async () => {
    const luau = await luauFor(find, { tag: "Door" });
    for (const forbidden of ["AddTag", "RemoveTag", "RemoveTags", ":Destroy", ".Parent ="]) {
      assert.ok(!luau.includes(forbidden), `tags_find must not emit ${forbidden}`);
    }
    assert.ok(luau.includes("GetTagged"), "it should actually read tags");
  });

  test("both branches of the read tool are reachable, and neither is silent", async () => {
    assert.match(await luauFor(find, { tag: "Door" }), /GetTagged/);
    assert.match(await luauFor(find, { target: "Workspace.Door" }), /GetTags/);
    // Neither argument given is a structured refusal, not an empty result that
    // reads like "there are no tags".
    assert.match(await luauFor(find, {}), /bad_args/);
  });

  test("the write tool takes an undo waypoint and cancels it on failure", async () => {
    const luau = await luauFor(set, { target: "Workspace.Door", add: ["Interactable"] });
    assert.match(luau, /TryBeginRecording/);
    assert.match(luau, /FinishRecording/);
    assert.match(luau, /Enum\.FinishRecordingOperation\.Cancel/, "a failed tag edit must not commit a waypoint");
  });

  test("tag arguments are embedded as data, never spliced into source", async () => {
    // luaJson exists because a tag named `"] end; game:Shutdown(); --` used to
    // end the string and keep going.
    const nasty = '"] end; game:Shutdown(); --';
    const luau = await luauFor(set, { target: "Workspace.Door", add: [nasty] });
    // The text is expected to appear — it is data. What must never appear is an
    // UNESCAPED closing quote, which is what would end the literal and turn the
    // rest of the tag name into statements.
    assert.doesNotMatch(luau, /(?<!\\)"\] end/, "the payload closed its own string literal");
    assert.match(luau, /\\"\] end/, "the quote should be present but escaped");
    assert.match(luau, /__MCP\.decode/, "arguments travel as decoded data, not as spliced source");
  });
});
