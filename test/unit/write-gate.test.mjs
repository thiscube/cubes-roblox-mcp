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
import { StudioBridge } from "../../dist/bridge.js";
import { MAX_PROTOCOL_VERSION } from "../../dist/protocol.js";
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
      return { ok: true, applied: 1, changes: [] };
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

  test("no tool file sets `channel` by hand", async () => {
    // ToolEntry.channel says "set by the constructor, never by hand", and six
    // tools were doing exactly that. It is not cosmetic: writing them as raw
    // literals is how `pluginCommand` came to be missing from `snapshot` and
    // `diff`, which left them out of the /rpc policy entirely.
    const dir = join(SRC, "tools");
    const offenders = [];
    for (const file of (await readdir(dir)).filter((f) => f.endsWith(".ts"))) {
      const text = await readFile(join(dir, file), "utf8");
      for (const [, line] of text.split("\n").entries()) {
        if (/^\s*channel:\s*"/.test(line)) offenders.push(`${file}: ${line.trim()}`);
      }
    }
    assert.deepEqual(offenders, [], `hand-set channels: ${offenders.join(", ")}`);
  });

  test("only named modules may reach outside the process at all", async () => {
    // This is the half that generalises, and it is an ALLOWLIST of modules
    // rather than a denylist of identifiers. The previous version matched
    // eleven function names inside one directory, which meant a helper exported
    // from src/ under any other name was invisible — and that is exactly the
    // shape asset_upload had. Verification evaded it seven ways out of ten.
    //
    // So: node:fs, node:child_process and the HTTP modules may only be imported
    // by modules that exist to do that. Every other file in src/ reaches the
    // outside world through one of these or not at all.
    const OUTWARD_MODULES = /from "node:(fs|fs\/promises|child_process|http|https|net|dgram|dns)"/;
    const ALLOWED = new Set([
      "assets.ts", // Roblox HTTP + the upload read
      "bridge.ts", // the HTTP listener itself
      "docs.ts", // the API dump fetch + cache
      "install-plugin.ts", // copies the plugin into Studio's folder
      "lint.ts", // spawns selene
      "mesh.ts", // reads and writes .obj / .glb files under the project root
      "profile.ts", // per-place profiles
      "sourcemap.ts", // reads sourcemap.json
      "vision.ts", // spawns the capture tool, writes a temp PNG
    ]);

    const srcFiles = [];
    for (const dir of [SRC, join(SRC, "tools")]) {
      for (const f of (await readdir(dir)).filter((n) => n.endsWith(".ts"))) {
        srcFiles.push({ name: f, path: join(dir, f) });
      }
    }
    const unexpected = [];
    for (const { name, path } of srcFiles) {
      const text = await readFile(path, "utf8");
      if (!OUTWARD_MODULES.test(text)) continue;
      if (!ALLOWED.has(name)) unexpected.push(name);
    }
    assert.deepEqual(
      unexpected,
      [],
      `these reach outside the process and are not on the allowlist: ${unexpected.join(", ")}. ` +
        `Route it through one of the named modules, or add it here with a reason.`,
    );

    // And the allowlist must not rot: an entry that no longer reaches out is a
    // permission nobody is using.
    const stale = [];
    for (const name of ALLOWED) {
      const match = srcFiles.find((f) => f.name === name);
      if (!match) {
        stale.push(`${name} (no such file)`);
        continue;
      }
      if (!OUTWARD_MODULES.test(await readFile(match.path, "utf8"))) stale.push(name);
    }
    assert.deepEqual(stale, [], `stale allowlist entries: ${stale.join(", ")}`);
  });

  test("a tool whose file imports an outward module has to declare an effect", async () => {
    // The second half: given the allowlist above, a tool file that imports one
    // of those modules is reaching outside, whatever it calls it. Import edges,
    // not function names — so a new export from src/assets.ts is covered the
    // moment it is imported, without anyone remembering to add its name.
    const EFFECT_MODULES = {
      "../assets.js": "network",
      "../docs.js": "network",
      "../profile.js": "state",
      "../vision.js": "process",
      "../lint.js": "process",
      "../install-plugin.js": "state",
    };
    const dir = join(SRC, "tools");
    const offenders = [];
    for (const file of (await readdir(dir)).filter((f) => f.endsWith(".ts"))) {
      const text = await readFile(join(dir, file), "utf8");
      const reaching = Object.entries(EFFECT_MODULES).filter(([mod]) => text.includes(`from "${mod}"`));
      if (reaching.length === 0) continue;
      // Which tools in this file actually call into it. Fall back to "all of
      // them" only when the file has one tool, where there is no ambiguity.
      const blocks = toolBlocks(text);
      for (const { name, body } of blocks) {
        const entry = ALL_TOOLS.find((t) => t.name === name);
        if (!entry) continue;
        const cap = capabilities(entry);
        const declares =
          cap.writesDisk !== false || cap.network !== "none" || cap.spawnsProcess;
        // A tool that plainly does not use the import is fine: an eval template
        // in the same file as a network call reaches nothing.
        const usesIt = reaching.some(([mod]) => {
          const symbols = new RegExp(
            `import\\s*\\{([^}]+)\\}\\s*from\\s*"${mod.replace(/[.*+?^$()|[\]\\]/g, "\\$&")}"`,
          ).exec(text);
          if (!symbols) return false;
          return symbols[1]
            .split(",")
            .map((s) => s.trim().split(/\s+as\s+/).pop().trim())
            .filter((s) => s && !s.startsWith("type "))
            .some((s) => new RegExp(`\\b${s}\\s*\\(`).test(body));
        });
        if (usesIt && !declares) {
          offenders.push(`${file}: ${name} calls into an outward module and declares no effect`);
        }
      }
    }
    assert.deepEqual(offenders, [], offenders.join("; "));
  });

  test("that scan sees the tools it is meant to police", async () => {
    // If the import resolution silently matched nothing, the test above would
    // pass vacuously — which is how the version before it passed.
    const declared = ALL_TOOLS.filter((t) => {
      const c = capabilities(t);
      return c.writesDisk !== false || c.network !== "none" || c.spawnsProcess;
    }).map((t) => t.name);
    assert.ok(declared.includes("profile_update"), "the state case must be visible");
    assert.ok(declared.includes("docs_class"), "the cache-plus-network case must be visible");
    assert.ok(declared.includes("asset_upload"), "the outward-write case must be visible");
    assert.ok(!declared.includes("asset_insert"), "an eval tool in the same file must NOT be swept up");
    assert.ok(!declared.includes("macro_save"), "nor a local tool beside one that persists");
  });

  test("the read-only build excludes every outward effect, not just Studio writes", async () => {
    // Tested as a class rather than as the one instance that was found. The
    // filter asked only about Studio, which is how profile_update shipped in the
    // inspector build, and then asset_upload — a tool that reads a file and
    // posts it to Roblox.
    const { createMcpServer } = await import("../../dist/server.js");
    const transport = { connected: true, writeEnabled: true, async send() { return { ok: true }; } };
    const server = createMcpServer(transport, { readOnly: true });
    const { ListToolsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
    for (const t of ALL_TOOLS) {
      await server._requestHandlers.get(CallToolRequestSchema.shape.method.value)(
        { method: "tools/call", params: { name: t.name, arguments: {} } },
        { signal: new AbortController().signal },
      );
    }
    const { tools } = await server._requestHandlers.get(ListToolsRequestSchema.shape.method.value)(
      { method: "tools/list", params: {} },
      { signal: new AbortController().signal },
    );
    const { INSPECTOR_EXEMPTIONS } = await import("../../dist/session.js");
    const listed = new Set(tools.map((t) => t.name));
    const leaked = ALL_TOOLS.filter(
      (t) => listed.has(t.name) && !capabilities(t).inspectorSafe && !INSPECTOR_EXEMPTIONS.includes(t.name),
    );
    assert.deepEqual(
      leaked.map((t) => `${t.name} (${JSON.stringify(capabilities(t))})`),
      [],
      "these can change the place, persist user data, spawn a process, or send bytes out",
    );

    // The exemption list has to be exactly the tools that need one — no stale
    // entries, and nothing exempt that derivation already allows.
    const { screenshotTool } = await import("../../dist/vision.js");
    const coreDefs = { screenshot: screenshotTool };
    for (const name of INSPECTOR_EXEMPTIONS) {
      const entry = ALL_TOOLS.find((t) => t.name === name) ?? coreDefs[name];
      assert.ok(entry, `${name} is exempt but does not exist`);
      assert.equal(
        capabilities(entry).inspectorSafe,
        false,
        `${name} is on the exemption list but derivation already allows it — remove it`,
      );
      assert.ok(listed.has(name), `${name} is exempt but not actually in the build`);
    }
    for (const t of ALL_TOOLS) {
      const cap = capabilities(t);
      // `writesDisk: "cache"` is the one disk write that stays safe: the
      // server's own copy of a public file, not the user's data. Anything else
      // that leaves the process disqualifies.
      const disqualifying = cap.write || cap.writesDisk === true || cap.network === "write" || cap.spawnsProcess;
      assert.equal(
        cap.inspectorSafe,
        !disqualifying,
        `${t.name}: inspectorSafe disagrees with its effects — ${JSON.stringify(cap)}`,
      );
    }
  });

  test("capabilities() fails closed on anything that is not a known opt-out", async () => {
    // `entry.readOnly === undefined` read nicely and made `readOnly: false` —
    // which means "not read-only" to any human — produce a READ-class tool.
    for (const bad of [false, null, 0, "", "typo", {}, []]) {
      const cap = capabilities({ channel: "eval", readOnly: bad });
      assert.equal(cap.write, true, `readOnly: ${JSON.stringify(bad)} must stay write-class`);
    }
    assert.equal(capabilities({ channel: "eval" }).write, true);
    assert.equal(capabilities({ channel: "eval", readOnly: true }).write, false);
    assert.equal(capabilities({ channel: "eval", readOnly: "transient" }).write, false);
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

  test("the /rpc allowlist is derived, and in the right namespace", async () => {
    // CLAUDE.md: capability is derived and never labelled. But /rpc queues a
    // command straight to the plugin, so it speaks the PLUGIN COMMAND
    // namespace. Deriving tool NAMES put 14 inert entries in the list and left
    // out `capture`, so a read-only build could not screenshot over /rpc.
    const { rpcReadOnlyCommands } = await import("../../dist/rpc-policy.js");
    const { screenshotTool } = await import("../../dist/vision.js");
    const allowed = new Set(rpcReadOnlyCommands());

    for (const entry of ALL_TOOLS) {
      if (!entry.pluginCommand) continue;
      assert.equal(
        allowed.has(entry.pluginCommand),
        !capabilities(entry).write,
        `${entry.name} (command ${entry.pluginCommand}): allowlist disagrees with capabilities()`,
      );
    }

    // Every entry must be a command something actually sends, not a tool name.
    const commands = new Set([
      ...ALL_TOOLS.map((t) => t.pluginCommand).filter(Boolean),
      screenshotTool.pluginCommand,
      // Dispatched by the server itself, with no tool of their own.
      "read",
      "diagnostics",
      "viewport",
    ]);
    for (const name of allowed) {
      assert.ok(commands.has(name), `${name} is in the /rpc allowlist but nothing sends it`);
    }

    assert.ok(allowed.has("read"), "the universal read verb must be allowed");
    assert.ok(allowed.has("capture"), "a read-only build must still be able to screenshot");
    assert.ok(!allowed.has("mutate") && !allowed.has("eval") && !allowed.has("tune"));
  });

  test("the transport refuses writes too, not just its callers", async () => {
    // Defence in depth: handleMutate's guard is `connected && !writeEnabled`, so
    // a disconnected bridge falls through it into send(). If the plugin
    // reconnects before the queue drains, the command lands with the toggle off.
    const { StudioBridge } = await import("../../dist/bridge.js");
    const { rpcReadOnlyCommands } = await import("../../dist/rpc-policy.js");
    const { MAX_PROTOCOL_VERSION } = await import("../../dist/protocol.js");
    const bridge = new StudioBridge(0, { readOnlyCommands: rpcReadOnlyCommands() });
    await bridge.start();
    try {
      // A plugin polling with the toggle OFF: the state the window opens in.
      // Not awaited — a poll with nothing queued long-holds for 25 seconds.
      void fetch(`http://127.0.0.1:${bridge.boundPort}/poll`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${bridge.token}` },
        body: JSON.stringify({ protocol: MAX_PROTOCOL_VERSION, writeEnabled: false }),
      }).catch(() => {});
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(bridge.connected, true);
      assert.equal(bridge.writeEnabled, false);

      // BridgeError carries the machine-readable reason on `code`; the message
      // is the sentence a human reads. Assert on the code.
      const codeOf = async (fn) => {
        try {
          await fn();
          return "resolved";
        } catch (err) {
          return err.code ?? "no_code";
        }
      };
      assert.equal(await codeOf(() => bridge.send("mutate", { ops: [] }, 500)), "write_mode_disabled");
      assert.equal(await codeOf(() => bridge.send("eval", { luau: "x" }, 500)), "write_mode_disabled");
      assert.equal(bridge.queueDepth, 0, "a refused write must never reach the queue");

      // A read still gets as far as the queue: the gate is about writes.
      assert.equal(await codeOf(() => bridge.send("read", { path: "Workspace" }, 250)), "studio_timeout");
    } finally {
      await bridge.stop();
    }
  });

  test("the connected check still wins, so the error stays actionable", async () => {
    // With no plugin at all, "Studio is not connected" is far more useful than
    // "writes are off", so that check has to come first.
    const { StudioBridge } = await import("../../dist/bridge.js");
    const { rpcReadOnlyCommands } = await import("../../dist/rpc-policy.js");
    const bridge = new StudioBridge(0, { readOnlyCommands: rpcReadOnlyCommands() });
    await bridge.start();
    try {
      const err = await bridge.send("mutate", { ops: [] }, 300).catch((e) => e);
      assert.equal(err.code, "studio_not_connected");
    } finally {
      await bridge.stop();
    }
  });
});

/**
 * CUBES_MCP_ALLOW_UNAUTHENTICATED exists for plugins too old to send a token.
 * Verification reproduced the cost end to end: with it set, an unauthenticated
 * POST to /poll carrying `writeEnabled: true` forged the user's toggle, and a
 * following /rpc mutate passed the write gate. The toggle cannot be
 * authenticated without authenticating the plugin, so in that mode it is not
 * believed at all — the hatch buys reads.
 */
describe("unauthenticated mode cannot forge writes", () => {
  const withFlag = async (fn) => {
    const prev = process.env.CUBES_MCP_ALLOW_UNAUTHENTICATED;
    process.env.CUBES_MCP_ALLOW_UNAUTHENTICATED = "1";
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.CUBES_MCP_ALLOW_UNAUTHENTICATED;
      else process.env.CUBES_MCP_ALLOW_UNAUTHENTICATED = prev;
    }
  };

  test("a forged toggle no longer enables writes", async () => {
    await withFlag(async () => {
      const bridge = new StudioBridge(0, {});
      await bridge.start();
      try {
        const port = bridge.boundPort;
        const ctrl = new AbortController();
        const inflight = fetch(`http://127.0.0.1:${port}/poll`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ protocol: MAX_PROTOCOL_VERSION, writeEnabled: true }),
          signal: ctrl.signal,
        }).catch(() => {});
        for (let i = 0; i < 100 && !bridge.connected; i++) {
          await new Promise((r) => setTimeout(r, 10));
        }
        ctrl.abort();
        await inflight;
        assert.equal(bridge.connected, true, "the poll should still register a plugin");
        assert.equal(bridge.writeEnabled, false, "but its write toggle must not be believed");
      } finally {
        await bridge.stop();
      }
    });
  });

  test("the mode is entered only by an exact '1', never by a truthy-looking value", async () => {
    // A disconnected bridge reports writeEnabled false regardless, so the flag
    // itself is what gets asserted, read back off /health where it is public.
    for (const value of ["true", "TRUE", "yes", "0", " 1", "1 ", ""]) {
      const prev = process.env.CUBES_MCP_ALLOW_UNAUTHENTICATED;
      process.env.CUBES_MCP_ALLOW_UNAUTHENTICATED = value;
      const bridge = new StudioBridge(0, {});
      await bridge.start();
      try {
        const body = await fetch(`http://127.0.0.1:${bridge.boundPort}/health`, {
          method: "POST",
          headers: { "content-type": "application/json" },
        }).then((r) => r.json());
        assert.equal(
          body.unauthenticatedMode,
          undefined,
          `${JSON.stringify(value)} must not enter unauthenticated mode`,
        );
        assert.equal(body.authRequired, true);
      } finally {
        await bridge.stop();
        if (prev === undefined) delete process.env.CUBES_MCP_ALLOW_UNAUTHENTICATED;
        else process.env.CUBES_MCP_ALLOW_UNAUTHENTICATED = prev;
      }
    }
  });

  test("the mode announces itself without needing the credential it disabled", async () => {
    await withFlag(async () => {
      const bridge = new StudioBridge(0, {});
      await bridge.start();
      try {
        const body = await fetch(`http://127.0.0.1:${bridge.boundPort}/health`, {
          method: "POST",
          headers: { "content-type": "application/json" },
        }).then((r) => r.json());
        assert.equal(body.unauthenticatedMode, true);
        assert.equal(body.writesForcedOff, true);
        assert.equal(body.authRequired, false);
      } finally {
        await bridge.stop();
      }
    });
  });
});
