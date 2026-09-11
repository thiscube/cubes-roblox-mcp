/**
 * The write gate, tested by behaviour rather than by label.
 *
 * This file exists because of a real regression. `script_edit` was rewritten as
 * a `localTool` so its find/replace could happen in TypeScript, which made
 * `capabilities()` read it as non-write-class — and it then overwrote script
 * source with the "Allow writes" toggle OFF, reaching Studio with a
 * `{ op: "set", props: { Source } }` batch. The declared capability was right
 * about the channel and wrong about the effect.
 *
 * So the assertion here is not "is this tool labelled correctly". It is: with
 * writes off, can ANY tool, by any route, get a mutate command to Studio.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createMcpServer } from "../../dist/server.js";
import { ALL_TOOLS } from "../../dist/tools/index.js";
import { capabilities } from "../../dist/registry.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { installFakeDump } from "./_fixtures.mjs";

installFakeDump();

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");


/**
 * Split a tool file into one text block per declared tool.
 *
 * A fixed-size window after `name: "x"` is not good enough: `macro_save` sits
 * directly above `macro_run`, so any window wide enough to cover a handler
 * reaches into the next tool's and reports a false positive. Each block runs
 * from its own name to the next one.
 */
function toolBlocks(text) {
  const marks = [...text.matchAll(/name:\s*"([a-z0-9_]+)"/g)];
  return marks.map((m, i) => ({
    name: m[1],
    body: text.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : text.length),
  }));
}

async function scanToolFiles(predicate) {
  const dir = join(SRC, "tools");
  const offenders = [];
  for (const file of (await readdir(dir)).filter((f) => f.endsWith(".ts"))) {
    const text = await readFile(join(dir, file), "utf8");
    for (const { name, body } of toolBlocks(text)) {
      const entry = ALL_TOOLS.find((t) => t.name === name);
      if (!entry) continue;
      const complaint = predicate(entry, body);
      if (complaint) offenders.push(`${file}: ${complaint}`);
    }
  }
  return offenders;
}

/** Commands the plugin treats as writes. */
const WRITE_COMMANDS = new Set(["mutate", "tune"]);

/** Arguments real enough to reach each handler rather than fail validation. */
const SAMPLE_ARGS = {
  run_code: { luau: "return 1" },
  read: { path: "Workspace" },
  search_tools: { query: "script" },
  mutate: { ops: [{ op: "set", target: "Workspace.P", props: { Anchored: true } }] },
  script_edit: { target: "Workspace.S", edits: [{ find: "local a", replace: "local b" }], confirm: true },
  script_write: { target: "Workspace.S", source: "print('x')", confirm: true },
  snapshot: { name: "s1", path: "Workspace" },
  diff: { from: "s1", to: "live" },
  macro_save: { name: "m1" },
  macro_run: { name: "m1", confirm: true },
  profile_update: { genre: "obby" },
  tune: { luau: "return 1" },
  docs_class: { class: "Part" },
  docs_member: { class: "Part", member: "Anchored" },
  docs_search: { query: "part" },
  docs_defaults: { class: "Part", properties: ["Name"] },
};

function harness(writeEnabled) {
  const sent = [];
  const transport = {
    connected: true,
    writeEnabled,
    sent,
    async send(tool, args) {
      sent.push({ tool, args });
      // A source read has to look real, or script_edit bails before it would
      // have written and the test proves nothing.
      if (tool === "eval") return { path: "Workspace.S", ref: "s1", source: "local a = 1" };
      if (tool === "snapshot") return { instances: [{ path: "Workspace.P", className: "Part", props: {} }] };
      return { ok: true, applied: 1, results: [] };
    },
  };
  const server = createMcpServer(transport);
  const handlers = server._requestHandlers;
  const signal = new AbortController().signal;
  return {
    sent,
    call: (name, args = {}) =>
      handlers.get(CallToolRequestSchema.shape.method.value)(
        { method: "tools/call", params: { name, arguments: args } },
        { signal },
      ),
    payloadOf: (res) => {
      try {
        return JSON.parse(res.content.find((c) => c.type === "text").text);
      } catch {
        return undefined;
      }
    },
  };
}

describe("write gate: behaviour, not labels", () => {
  test("with writes off, no tool can reach Studio with a write command", async () => {
    const names = [...ALL_TOOLS.map((t) => t.name), "mutate", "run_code", "read", "search_tools"];
    const leaks = [];
    for (const name of names) {
      const h = harness(false);
      await h.call(name, SAMPLE_ARGS[name] ?? {});
      for (const { tool } of h.sent) {
        if (WRITE_COMMANDS.has(tool)) leaks.push(`${name} -> ${tool}`);
      }
    }
    assert.deepEqual(leaks, [], `write commands sent with writes off: ${leaks.join(", ")}`);
  });

  test("script_edit specifically, since that is the one that leaked", async () => {
    const off = harness(false);
    const res = await off.call("script_edit", SAMPLE_ARGS.script_edit);
    assert.equal(off.payloadOf(res).error, "write_mode_disabled");
    assert.deepEqual(off.sent, [], "it must not even read the source");

    // And it still works when writes are on, so the fix is a gate, not a break.
    const on = harness(true);
    const ok = on.payloadOf(await on.call("script_edit", SAMPLE_ARGS.script_edit));
    assert.equal(ok.edited, true);
    assert.equal(ok.totalReplacements, 1);
    assert.deepEqual(
      on.sent.map((s) => s.tool),
      ["eval", "mutate"],
    );
    assert.deepEqual(on.sent[1].args.ops, [
      { op: "set", target: "Workspace.S", props: { Source: "local b = 1" } },
    ]);
  });

  test("the mutate pipeline refuses even when its caller was waved through", async () => {
    // Defence in depth: the gate is at the entrance to handleMutate, not only on
    // the `mutate` tool name, so a future tool on any channel is covered.
    const h = harness(false);
    const res = await h.call("macro_run", { name: "nope", confirm: true });
    assert.ok(h.payloadOf(res).error, "expected a refusal");
    assert.deepEqual(
      h.sent.filter((s) => WRITE_COMMANDS.has(s.tool)),
      [],
    );
  });

  test("every tool that routes through handleMutate is write-class", async () => {
    // Catches the declaration, not just the behaviour: a new localTool that
    // calls ctx.handleMutate should fail here before anyone has to notice it
    // writing with the toggle off.
    const offenders = await scanToolFiles((entry, body) =>
      body.includes("ctx.handleMutate") && !capabilities(entry).write
        ? `${entry.name} calls handleMutate but is not write-class`
        : null,
    );
    assert.deepEqual(offenders, [], offenders.join("; "));
  });

  test("no tool claims to be local while calling the bridge", async () => {
    // `local` means the effect stays in this process. A tool that talks to the
    // plugin is dispatch (with readOnly when it only reads), never local.
    const offenders = await scanToolFiles((entry, body) =>
      entry.channel === "local" && body.includes("ctx.bridge.send")
        ? `${entry.name} is channel "local" but calls the bridge`
        : null,
    );
    assert.deepEqual(offenders, [], offenders.join("; "));
  });

  test("the block splitter itself is not lying", async () => {
    // If toolBlocks silently matched nothing, both scans above would pass
    // vacuously. Prove it sees the tools it is meant to police.
    const seen = await scanToolFiles((entry, body) =>
      body.includes("ctx.handleMutate") ? entry.name : null,
    );
    assert.deepEqual(
      seen.map((s) => s.split(": ")[1]).sort(),
      ["macro_run", "script_edit"],
      "expected exactly the two tools that use the mutate pipeline",
    );
  });

  test("capabilities() still derives, and deny-by-default still holds", () => {
    for (const entry of ALL_TOOLS) {
      const cap = capabilities(entry);
      if (entry.channel === "local") {
        assert.equal(cap.write, false, `${entry.name}: local tools are not write-class`);
        assert.equal(cap.touchesStudio, false);
      } else if (entry.readOnly === undefined) {
        assert.equal(cap.write, true, `${entry.name}: a Studio channel is write-class by default`);
      } else {
        // Both opt-out levels are read-class. `true` is a pure read;
        // `"transient"` constructs something it never parents.
        assert.ok(
          entry.readOnly === true || entry.readOnly === "transient",
          `${entry.name}: readOnly must be true or "transient", got ${JSON.stringify(entry.readOnly)}`,
        );
        assert.equal(cap.write, false);
        assert.equal(cap.transient, entry.readOnly === "transient");
      }
    }
  });

  test("the /rpc allowlist is derived, not hand-listed", async () => {
    // CLAUDE.md: capability is derived and never labelled. The bridge used to
    // carry its own hardcoded Set, which drifted — sixteen read-only tools were
    // refused and two entries named commands that are not tools.
    const { rpcReadOnlyCommands } = await import("../../dist/rpc-policy.js");
    const allowed = new Set(rpcReadOnlyCommands());
    for (const entry of ALL_TOOLS) {
      assert.equal(
        allowed.has(entry.name),
        !capabilities(entry).write,
        `${entry.name}: /rpc allowlist disagrees with capabilities()`,
      );
    }
    assert.ok(allowed.has("read"), "the universal read verb must be allowed");
    assert.ok(!allowed.has("mutate") && !allowed.has("run_code"));
  });
});
