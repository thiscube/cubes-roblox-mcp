/**
 * Script history: every version a write through handleMutate replaces is kept
 * on disk, and script_restore can put one back.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

// Isolates on-disk state (CUBES_MCP_HOME). Import for the side effect.
import "./_fixtures.mjs";
import { lineDiff, placeKeyOf, readBlob, readIndex, recordVersions } from "../../dist/script-history.js";
import { createMcpServer } from "../../dist/server.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

describe("lineDiff", () => {
  test("identical sources have no diff", () => {
    assert.equal(lineDiff("a\nb\nc", "a\nb\nc"), "");
  });

  test("a changed line shows as removed then added, with context", () => {
    const d = lineDiff("a\nb\nc\nd", "a\nB\nc\nd").split("\n");
    assert.match(d[0], /^@@ -1 \+1 @@$/);
    assert.deepEqual(d.slice(1), [" a", "-b", "+B", " c", " d"]);
  });

  test("an added tail and a removed head both show", () => {
    assert.match(lineDiff("x\ny", "y\nz"), /-x[\s\S]*\+z/);
  });

  test("a one-line change is numbered from line 1 on both sides", () => {
    assert.equal(lineDiff("return 1", "return 2"), "@@ -1 +1 @@\n-return 1\n+return 2");
  });
});

describe("recordVersions", () => {
  test("stores each distinct version once and skips a repeat of the newest", async () => {
    const place = placeKeyOf(0, `dedupe test ${Date.now()}`);
    assert.match(place, /^unsaved-dedupe_test_/);
    await recordVersions(place, [{ path: "Workspace.S", class: "Script", action: "before-edit", source: "print(1)" }]);
    await recordVersions(place, [{ path: "Workspace.S", class: "Script", action: "after-edit", source: "print(1)" }]);
    await recordVersions(place, [{ path: "Workspace.S", class: "Script", action: "after-edit", source: "print(2)" }]);
    const index = await readIndex(place);
    assert.equal(index.length, 2);
    assert.equal(await readBlob(place, index[0].hash), "print(1)");
    assert.equal(await readBlob(place, index[1].hash), "print(2)");
  });

  test("a delete is recorded even when the source has not changed", async () => {
    const place = placeKeyOf(0, `delete test ${Date.now()}`);
    await recordVersions(place, [{ path: "Workspace.S", class: "Script", action: "created", source: "x" }]);
    await recordVersions(place, [{ path: "Workspace.S", class: "Script", action: "before-delete", source: "x" }]);
    assert.deepEqual((await readIndex(place)).map((e) => e.action), ["created", "before-delete"]);
  });
});

/** A Studio that holds one script and records the mutates it is sent. */
class FakeStudio {
  connected = true;
  writeEnabled = true;
  mutates = [];
  constructor(placeName, source) {
    this.placeName = placeName;
    this.source = source;
  }
  async send(tool, args) {
    if (tool === "mutate") {
      this.mutates.push(args);
      const op = args.ops[0];
      if (op.op === "set") this.source = op.props.Source;
      return { changes: [] };
    }
    const luau = String(args.luau ?? "");
    if (luau.includes("items = {}")) {
      return {
        placeId: 0,
        placeName: this.placeName,
        items: [{ i: 0, kind: "set", path: "Workspace.Door", class: "Script", source: this.source }],
      };
    }
    if (luau.includes("parentExists")) return { exists: true, parentExists: true };
    return { placeId: 0, placeName: this.placeName };
  }
}

function caller(server) {
  const handler = server._requestHandlers.get(CallToolRequestSchema.shape.method.value);
  const signal = new AbortController().signal;
  return async (name, args) => {
    const res = await handler({ method: "tools/call", params: { name, arguments: args } }, { signal });
    return res.structuredContent;
  };
}

describe("history through the tools", () => {
  test("an edit saves the old and new source, and restore puts the old one back", async () => {
    const studio = new FakeStudio(`restore test ${Date.now()}`, "local open = false");
    const call = caller(createMcpServer(studio));

    const edited = await call("mutate", {
      ops: [{ op: "set", target: "Workspace.Door", props: { Source: "local open = true" } }],
      confirm: true,
    });
    assert.deepEqual(edited.history, { saved: 2 });

    const list = await call("script_history", { target: "Door" });
    assert.equal(list.path, "Workspace.Door");
    assert.equal(list.total, 2);
    assert.deepEqual(list.versions.map((v) => v.action), ["after-edit", "before-edit"]);

    const v2 = await call("script_history", { target: "Workspace.Door", version: 2 });
    assert.match(v2.diff, /-local open = false\n\+local open = true/);

    const restored = await call("script_restore", { target: "Door", version: 1, confirm: true });
    assert.equal(restored.restored, true);
    assert.equal(studio.source, "local open = false");
    const last = studio.mutates.at(-1).ops[0];
    assert.equal(last.op, "set");
    assert.equal(last.target, "Workspace.Door");
  });

  test("a batch that touches no script source saves nothing and says nothing", async () => {
    const studio = new FakeStudio(`parts test ${Date.now()}`, "");
    const call = caller(createMcpServer(studio));
    const res = await call("mutate", { ops: [{ op: "set", target: "Workspace.Part", props: { Anchored: true } }] });
    assert.equal("history" in res, false);
  });
});
