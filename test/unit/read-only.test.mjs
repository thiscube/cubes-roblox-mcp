/**
 * The read-only build (PLAN.md #13).
 *
 * The promise is stronger than "writes are gated": in this mode the write tools
 * are not in the process. There is no toggle to flip, no gate to get wrong, and
 * nothing for a determined model to argue its way past. These tests check that
 * promise from both doors — the MCP surface and the bridge's `/rpc` — because a
 * read-only MCP server in front of a writable `/rpc` would be no guarantee at
 * all.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { createMcpServer } from "../../dist/server.js";
import { StudioBridge } from "../../dist/bridge.js";
import { MAX_PROTOCOL_VERSION } from "../../dist/protocol.js";
import { rpcReadOnlyCommands } from "../../dist/rpc-policy.js";
import { ALL_TOOLS } from "../../dist/tools/index.js";
import { capabilities } from "../../dist/registry.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { installFakeDump } from "./_fixtures.mjs";

installFakeDump();

const WRITE_COMMANDS = new Set(["mutate", "tune"]);

function harness(readOnly) {
  const sent = [];
  const transport = {
    connected: true,
    // Writes allowed at the transport level on purpose: if anything gets through,
    // it is the build that failed, not the toggle.
    writeEnabled: true,
    async send(tool, args) {
      sent.push({ tool, args });
      if (tool === "eval") return { path: "Workspace.S", ref: "s1", source: "local a = 1" };
      return { ok: true, applied: 1, results: [] };
    },
  };
  const server = createMcpServer(transport, { readOnly });
  const handlers = server._requestHandlers;
  const signal = new AbortController().signal;
  return {
    sent,
    name: server._serverInfo?.name,
    call: (name, args = {}) =>
      handlers.get(CallToolRequestSchema.shape.method.value)(
        { method: "tools/call", params: { name, arguments: args } },
        { signal },
      ),
    list: () =>
      handlers.get(ListToolsRequestSchema.shape.method.value)(
        { method: "tools/list", params: {} },
        { signal },
      ),
    payloadOf: (res) => JSON.parse(res.content.find((c) => c.type === "text").text),
  };
}

describe("read-only build: the MCP surface", () => {
  test("the core surface loses mutate and run_code", async () => {
    const ro = harness(true);
    const { tools } = await ro.list();
    assert.deepEqual(tools.map((t) => t.name), ["search_tools", "read", "screenshot"]);

    const full = harness(false);
    const all = (await full.list()).tools.map((t) => t.name);
    assert.ok(all.includes("mutate") && all.includes("run_code"));
  });

  test("calling a write core tool by name is unknown_tool, not a refusal", async () => {
    // The distinction matters. "Refused" invites a retry with different
    // arguments; "not here" tells the model to stop.
    const ro = harness(true);
    for (const name of ["mutate", "run_code"]) {
      const p = ro.payloadOf(await ro.call(name, { ops: [], luau: "return 1" }));
      assert.equal(p.error, "unknown_tool", `${name} should not exist`);
    }
    assert.deepEqual(ro.sent, [], "nothing should have reached the transport");
  });

  test("no write specialist can be called, searched for, or unlocked", async () => {
    const ro = harness(true);
    const writers = ALL_TOOLS.filter((t) => capabilities(t).write);
    assert.ok(writers.length > 20, "sanity: most specialists are write-class");

    for (const t of writers) {
      const p = ro.payloadOf(await ro.call(t.name, {}));
      assert.equal(p.error, "unknown_tool", `${t.name} should be absent`);
    }
    assert.deepEqual(
      ro.sent.filter((s) => WRITE_COMMANDS.has(s.tool)),
      [],
    );

    const found = ro.payloadOf(
      await ro.call("search_tools", { query: "create part delete terrain fill anchor", limit: 12 }),
    );
    const surfaced = found.unlocked.map((u) => u.name);
    const leaked = surfaced.filter((n) => writers.some((w) => w.name === n));
    assert.deepEqual(leaked, [], `search surfaced write tools: ${leaked.join(", ")}`);
  });

  test("tools that only write to disk are filtered too", async () => {
    // "Local" is not the same as "harmless". profile_update never touches the
    // DataModel, so the Studio-only filter let it through — and it wrote a file
    // in the user's home directory from a build called read-only.
    const ro = harness(true);
    const p = ro.payloadOf(await ro.call("profile_update", { genre: "rpg" }));
    assert.equal(p.error, "unknown_tool");

    const full = harness(false);
    const allowed = full.payloadOf(await full.call("profile_update", { genre: "rpg" }));
    assert.equal(allowed.error, undefined, "it still works in the normal build");
  });

  test("read tools still work, so the build is useful and not just safe", async () => {
    const ro = harness(true);
    assert.equal(ro.payloadOf(await ro.call("read", { path: "Workspace" })).error, undefined);
    const docs = ro.payloadOf(await ro.call("docs_class", { class: "BasePart" }));
    assert.equal(docs.error, undefined);
    assert.ok(docs.members.length > 0);
    const surfaced = ro.payloadOf(await ro.call("search_tools", { query: "read script source", limit: 5 }));
    assert.ok(surfaced.unlocked.length > 0, "there must still be specialists to find");
  });

  test("it identifies itself differently, so a client can tell which build it got", () => {
    assert.equal(harness(true).name, "cubes-roblox-mcp-inspector");
    assert.equal(harness(false).name, "cubes-roblox-mcp");
  });

  test("CUBES_MCP_READ_ONLY selects the build when no option is passed", async () => {
    const before = process.env.CUBES_MCP_READ_ONLY;
    process.env.CUBES_MCP_READ_ONLY = "1";
    try {
      const transport = { connected: true, writeEnabled: true, async send() { return { ok: true }; } };
      const server = createMcpServer(transport);
      const { tools } = await server._requestHandlers.get(ListToolsRequestSchema.shape.method.value)(
        { method: "tools/list", params: {} },
        { signal: new AbortController().signal },
      );
      assert.equal(tools.length, 3);
    } finally {
      if (before === undefined) delete process.env.CUBES_MCP_READ_ONLY;
      else process.env.CUBES_MCP_READ_ONLY = before;
    }
  });
});

describe("read-only build: the /rpc door", () => {
  // Port 0: the OS picks a free one. Fixed ports collide because test files run
  // in parallel. The bridge still binds 127.0.0.1 only.
  const post = (p, path, token, body) =>
    fetch(`http://127.0.0.1:${p}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

  /**
   * Turn the Studio panel's write toggle ON the only way it can be turned on:
   * a /poll carrying writeEnabled. Not awaited, because a poll with no queued
   * command long-holds for 25 seconds.
   */
  function enableWrites(p, token) {
    void post(p, "/poll", token, { protocol: MAX_PROTOCOL_VERSION, writeEnabled: true }).catch(
      () => {},
    );
    return new Promise((r) => setTimeout(r, 50));
  }

  test("/rpc refuses writes even with the Studio toggle ON", async () => {
    const bridge = new StudioBridge(0, { readOnly: true, readOnlyCommands: rpcReadOnlyCommands() });
    await bridge.start();
    const p = bridge.boundPort;
    try {
      await enableWrites(p, bridge.token);
      assert.equal(bridge.writeEnabled, true, "the toggle really is on for this test");

      const res = await post(p, "/rpc", bridge.token, { tool: "mutate", args: { ops: [] } });
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.equal(body.error, "read_only_build");
      assert.match(body.hint, /CUBES_MCP_READ_ONLY/);
    } finally {
      await bridge.stop();
    }
  });

  test("a read command still goes through on a read-only bridge", async () => {
    const bridge = new StudioBridge(0, { readOnly: true, readOnlyCommands: rpcReadOnlyCommands() });
    await bridge.start();
    const p = bridge.boundPort;
    try {
      await enableWrites(p, bridge.token);
      // `read` is on the allowlist, so this must get past the gate. It then
      // queues for a plugin that will never answer, so a short timeout is the
      // pass condition: the gate did not reject it.
      const raced = await Promise.race([
        post(p, "/rpc", bridge.token, { tool: "read", args: { path: "Workspace" } }).then((r) => r.status),
        new Promise((r) => setTimeout(() => r("queued"), 300)),
      ]);
      assert.equal(raced, "queued", "a read must not be refused outright");
    } finally {
      await bridge.stop();
    }
  });

  test("a writable build refuses on the toggle instead, with the other error", async () => {
    const bridge = new StudioBridge(0, { readOnlyCommands: rpcReadOnlyCommands() });
    await bridge.start();
    const p = bridge.boundPort;
    try {
      const res = await post(p, "/rpc", bridge.token, { tool: "mutate", args: { ops: [] } });
      assert.equal(res.status, 403);
      assert.equal((await res.json()).error, "write_mode_disabled");
    } finally {
      await bridge.stop();
    }
  });
});
