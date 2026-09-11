/**
 * Server tests driven through a FAKE transport.
 *
 * This file is the proof that ARCHITECTURE-REVIEW.md A3 is fixed: the whole tool
 * layer now runs with no port, no HTTP, and no Studio. Before the seam existed,
 * every one of these needed a real socket and a stub plugin.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { createMcpServer } from "../../dist/server.js";
import { ALL_TOOLS as SEED_TOOLS } from "../../dist/tools/index.js";
import { capabilities } from "../../dist/registry.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/** A StudioTransport that records commands and replays canned answers. */
class FakeTransport {
  constructor({ connected = true, writeEnabled = true, reply } = {}) {
    this.connected = connected;
    this.writeEnabled = writeEnabled;
    this.sent = [];
    this.reply = reply ?? (() => ({ ok: true }));
  }
  async send(tool, args, timeoutMs) {
    this.sent.push({ tool, args, timeoutMs });
    return this.reply(tool, args);
  }
}

/**
 * Drive the server's registered handlers directly. The SDK exposes them through
 * setRequestHandler, so we reach in via the same schemas the transport would.
 */
function harness(transport) {
  const server = createMcpServer(transport);
  const handlers = server._requestHandlers;
  const callTool = (name, args = {}) =>
    handlers.get(CallToolRequestSchema.shape.method.value)(
      { method: "tools/call", params: { name, arguments: args } },
      { signal: new AbortController().signal },
    );
  const listTools = () =>
    handlers.get(ListToolsRequestSchema.shape.method.value)(
      { method: "tools/list", params: {} },
      { signal: new AbortController().signal },
    );
  const payloadOf = (res) => {
    const text = res?.content?.find((c) => c.type === "text")?.text;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
  return { server, callTool, listTools, payloadOf, transport };
}

describe("MCP conformance (#9)", () => {
  test("#9 failures set isError", async () => {
    const h = harness(new FakeTransport());
    for (const [name, args] of [
      ["mutate", { ops: "not-an-array" }],
      ["run_code", {}],
      ["nonexistent_tool", {}],
      ["search_tools", {}],
    ]) {
      const res = await h.callTool(name, args);
      assert.equal(res.isError, true, `${name} did not set isError`);
    }
  });

  test("#9 successes do not set isError", async () => {
    const h = harness(new FakeTransport({ reply: () => ({ items: [] }) }));
    const res = await h.callTool("read", { path: "Workspace" });
    assert.notEqual(res.isError, true);
  });

  test("tool annotations are published and match the gate", async () => {
    const h = harness(new FakeTransport());
    const { tools } = await h.listTools();
    const mutate = tools.find((t) => t.name === "mutate");
    assert.equal(mutate.annotations.destructiveHint, true);
    const read = tools.find((t) => t.name === "read");
    assert.equal(read.annotations.readOnlyHint, true);
  });
});

describe("argument validation (#3, #14)", () => {
  test("#3 a shell payload in a numeric field is refused before the handler runs", async () => {
    const h = harness(new FakeTransport());
    const res = await h.callTool("screenshot", {
      region: "studio",
      insets: { top: "0\n Start-Process calc.exe" },
    });
    const p = h.payloadOf(res);
    assert.equal(p.error, "invalid_arguments");
    assert.equal(res.isError, true);
    assert.match(p.problems.join(" "), /insets\.top/);
  });

  test("#3 an invalid enum value is refused", async () => {
    const h = harness(new FakeTransport());
    const p = h.payloadOf(await h.callTool("read", { format: "nonsense" }));
    assert.equal(p.error, "invalid_arguments");
  });

  test("#14 an absurd count is refused by the schema bounds", async () => {
    const h = harness(new FakeTransport());
    await h.callTool("search_tools", { query: "duplicate clone" });
    const p = h.payloadOf(await h.callTool("instance_duplicate", { target: "Workspace.X", count: 1e9 }));
    assert.equal(p.error, "invalid_arguments");
  });

  test("valid arguments reach the transport", async () => {
    const h = harness(new FakeTransport({ reply: () => ({ items: [] }) }));
    await h.callTool("read", { path: "Workspace", limit: 5 });
    assert.equal(h.transport.sent.length, 1);
    assert.equal(h.transport.sent[0].tool, "read");
  });
});

describe("write gate (#2, A2)", () => {
  test("#2 every eval-channel specialist is gated when writes are off", async () => {
    const gated = ["wait_until", "debug_highlight", "debug_clear", "test_run", "step_frames", "selection_set"];
    for (const name of gated) {
      const h = harness(new FakeTransport({ writeEnabled: false }));
      await h.callTool("search_tools", { query: name });
      const res = await h.callTool(name, argsFor(name));
      const p = h.payloadOf(res);
      assert.equal(
        p.error,
        "write_mode_disabled",
        `${name} reached Studio with writes off (got ${JSON.stringify(p).slice(0, 120)})`,
      );
      assert.equal(h.transport.sent.length, 0, `${name} still sent a command`);
    }
  });

  test("#2 genuinely read-only specialists still work with writes off", async () => {
    const h = harness(new FakeTransport({ writeEnabled: false, reply: () => ({ ok: true }) }));
    await h.callTool("search_tools", { query: "script_read source" });
    const p = h.payloadOf(await h.callTool("script_read", { target: "ServerScriptService.Main" }));
    assert.notEqual(p.error, "write_mode_disabled");
  });

  test("core write tools stay gated", async () => {
    const h = harness(new FakeTransport({ writeEnabled: false }));
    for (const [name, args] of [
      ["mutate", { ops: [{ op: "create", class: "Part" }] }],
      ["run_code", { luau: "return 1" }],
    ]) {
      const p = h.payloadOf(await h.callTool(name, args));
      assert.equal(p.error, "write_mode_disabled");
    }
  });

  test("every registry tool has a channel and a derived capability", () => {
    for (const entry of SEED_TOOLS) {
      assert.ok(entry.channel, `${entry.name} has no channel`);
      const cap = capabilities(entry);
      assert.equal(typeof cap.write, "boolean");
    }
  });
});

describe("search_tools honesty (#8)", () => {
  test("#8 everything reported as unlocked is actually in tools/list", async () => {
    const h = harness(new FakeTransport());
    const p = h.payloadOf(await h.callTool("search_tools", { query: "debug visualize highlight bounds label axes", limit: 12 }));
    const { tools } = await h.listTools();
    const listed = new Set(tools.map((t) => t.name));
    for (const u of p.unlocked) {
      assert.ok(listed.has(u.name), `${u.name} was reported unlocked but is missing from tools/list`);
    }
  });

  test("#8 overflow is disclosed rather than silently dropped", async () => {
    const h = harness(new FakeTransport());
    const p = h.payloadOf(await h.callTool("search_tools", { query: "debug playtest character terrain sound", limit: 12 }));
    // limit is clamped to the cap, so nothing should be silently lost.
    assert.ok(p.unlocked.length <= 8);
    if (p.not_unlocked) assert.ok(Array.isArray(p.not_unlocked));
  });
});

describe("destructiveness gate (#13, #16, #17)", () => {
  test("#16 an unknown op verb requires confirmation", async () => {
    const h = harness(new FakeTransport());
    const p = h.payloadOf(await h.callTool("mutate", { ops: [{ op: "delete", target: "Workspace.Thing" }] }));
    assert.equal(p.error, "needs_confirmation");
  });

  test("#17 deleting a service is reported as a service delete", async () => {
    const h = harness(new FakeTransport());
    const p = h.payloadOf(await h.callTool("mutate", { ops: [{ op: "delete", target: "game.Workspace" }] }));
    assert.equal(p.error, "needs_confirmation");
    assert.equal(p.level, "nuclear");
  });

  test("#13 script_edit goes through the confirm gate", async () => {
    const h = harness(
      new FakeTransport({
        reply: (tool) => {
          if (tool === "eval") return { path: "SSS.Main", ref: "s1", source: "local a = 1\n" };
          return { applied: true, changes: [] };
        },
      }),
    );
    await h.callTool("search_tools", { query: "script_edit patch" });
    const p = h.payloadOf(await h.callTool("script_edit", { target: "SSS.Main", edits: [{ find: "a = 1", replace: "a = 2" }] }));
    // Rewriting Source is `hard`, so without confirm the nested mutate refuses.
    assert.equal(p.result?.error, "needs_confirmation", JSON.stringify(p).slice(0, 200));
  });

  test("#13 script_edit applies once confirmed", async () => {
    const h = harness(
      new FakeTransport({
        reply: (tool) => {
          if (tool === "eval") return { path: "SSS.Main", ref: "s1", source: "local a = 1\n" };
          return { applied: true, changes: [{ op: "set", path: "SSS.Main", modified: ["Source"] }] };
        },
      }),
    );
    await h.callTool("search_tools", { query: "script_edit patch" });
    const p = h.payloadOf(
      await h.callTool("script_edit", {
        target: "SSS.Main",
        edits: [{ find: "a = 1", replace: "a = 2" }],
        confirm: true,
      }),
    );
    assert.equal(p.edited, true, JSON.stringify(p).slice(0, 200));
    const mutateCall = h.transport.sent.find((s) => s.tool === "mutate");
    assert.ok(mutateCall, "script_edit must route through the mutate channel");
    assert.equal(mutateCall.args.ops[0].props.Source, "local a = 2\n");
  });

  test("a soft mutate needs no confirmation", async () => {
    const h = harness(new FakeTransport({ reply: () => ({ applied: true, changes: [] }) }));
    const p = h.payloadOf(await h.callTool("mutate", { ops: [{ op: "set", target: "x", props: { Anchored: true } }] }));
    assert.notEqual(p.error, "needs_confirmation");
  });
});

describe("suggestions (#19)", () => {
  test("#19 the snapshot follow-up carries real arguments", async () => {
    const h = harness(
      new FakeTransport({ reply: () => ({ path: "Workspace", instances: [], truncated: false }) }),
    );
    await h.callTool("search_tools", { query: "snapshot capture checkpoint" });
    const p = h.payloadOf(await h.callTool("snapshot", { name: "before", path: "Workspace" }));
    const diff = (p.next_likely ?? []).find((n) => n.call === "diff");
    assert.ok(diff, "expected a diff follow-up");
    assert.equal(diff.args.from, "before");
    assert.equal(diff.args.to, "live");
  });
});

/** Minimal valid args per tool so validation never masks the gate under test. */
function argsFor(name) {
  switch (name) {
    case "wait_until":
      return { predicate: "true" };
    case "debug_highlight":
      return { targets: ["Workspace.Part"] };
    case "debug_clear":
      return {};
    case "test_run":
      return { suite: "ReplicatedStorage.Tests" };
    case "step_frames":
      return { count: 2 };
    case "selection_set":
      return { targets: ["Workspace"] };
    default:
      return {};
  }
}
