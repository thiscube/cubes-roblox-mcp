/**
 * Every tool, exercised (PLAN.md #12).
 *
 * Thirteen of the tool files had no test of their own. Writing a bespoke suite
 * per file would take a long time and still miss the class of bug that actually
 * appears — a tool that throws on plausible arguments, generates Luau that
 * cannot be parsed back, forgets its undo waypoint, or cannot be found by
 * searching for its own name.
 *
 * So this generates arguments from each tool's own inputSchema and runs all of
 * them through the real server. It is breadth, not depth: the depth is in the
 * per-area suites. But breadth is what was missing.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { createMcpServer } from "../../dist/server.js";
import { ALL_TOOLS } from "../../dist/tools/index.js";
import { capabilities } from "../../dist/registry.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { installFakeDump } from "./_fixtures.mjs";

installFakeDump();

/** A plausible value for one property, from its declared schema. */
function sampleFor(name, spec, depth = 0) {
  if (depth > 3) return null;
  if (Array.isArray(spec?.enum) && spec.enum.length > 0) return spec.enum[0];
  if (Array.isArray(spec?.oneOf)) return sampleFor(name, spec.oneOf[0], depth + 1);
  switch (spec?.type) {
    case "string":
      // Names that look like what the tool expects, so handlers reach their
      // real body instead of bailing on an obviously empty string.
      if (/target|path|parent|ref|instance/i.test(name)) return "Workspace.Sample";
      if (/luau|source|code/i.test(name)) return "return 1";
      if (/class/i.test(name)) return "Part";
      if (/material/i.test(name)) return "Plastic";
      if (/name|macro|snapshot|from|to|query|keyword/i.test(name)) return "sample";
      return "sample";
    case "number":
      return /line|limit|count|n$/i.test(name) ? 1 : 1;
    case "boolean":
      return false;
    case "array": {
      const item = sampleFor(`${name}Item`, spec.items ?? { type: "number" }, depth + 1);
      return item === null ? [] : [item, item, item];
    }
    case "object": {
      const out = {};
      for (const [k, v] of Object.entries(spec.properties ?? {})) {
        const value = sampleFor(k, v, depth + 1);
        if (value !== null) out[k] = value;
      }
      return out;
    }
    default:
      return null;
  }
}

/** Arguments satisfying a tool's required fields. */
function sampleArgs(tool) {
  const schema = tool.inputSchema ?? {};
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const args = {};
  for (const [key, spec] of Object.entries(props)) {
    // Required fields always; optional ones only when they are cheap and
    // unambiguous, so the call exercises the default paths too.
    if (!required.has(key) && !/confirm|allowMultiple/.test(key)) continue;
    const value = sampleFor(key, spec);
    if (value !== null) args[key] = value;
  }
  // Anything gated behind confirm should exercise the gated path, not the refusal.
  if ("confirm" in props) args.confirm = true;
  return args;
}

function harness() {
  const sent = [];
  const transport = {
    connected: true,
    writeEnabled: true,
    sent,
    async send(tool, args) {
      sent.push({ tool, args });
      // Shapes real enough that handlers which read the reply keep going.
      if (tool === "eval") return { path: "Workspace.Sample", ref: "s1", source: "local a = 1", ok: true };
      if (tool === "snapshot") return { instances: [{ path: "Workspace.P", className: "Part", props: {} }] };
      return { ok: true, applied: 1, changes: [] };
    },
  };
  const server = createMcpServer(transport);
  const handlers = server._requestHandlers;
  const signal = new AbortController().signal;
  return {
    sent,
    call: (name, args) =>
      handlers.get(CallToolRequestSchema.shape.method.value)(
        { method: "tools/call", params: { name, arguments: args } },
        { signal },
      ),
    list: () =>
      handlers.get(ListToolsRequestSchema.shape.method.value)(
        { method: "tools/list", params: {} },
        { signal },
      ),
    payloadOf: (res) => {
      const text = res?.content?.find((c) => c.type === "text")?.text;
      try {
        return JSON.parse(text);
      } catch {
        return undefined;
      }
    },
  };
}

describe("every tool, on plausible arguments", () => {
  test("none of them throws out of the handler", async () => {
    const broken = [];
    for (const tool of ALL_TOOLS) {
      const h = harness();
      const args = sampleArgs(tool);
      let res;
      try {
        res = await h.call(tool.name, args);
      } catch (err) {
        broken.push(`${tool.name}: threw ${err?.message}`);
        continue;
      }
      const payload = h.payloadOf(res);
      if (payload === undefined) broken.push(`${tool.name}: unreadable result`);
      // An `unknown_tool` here would mean the registry and ALL_TOOLS disagree.
      else if (payload.error === "unknown_tool") broken.push(`${tool.name}: not registered`);
    }
    assert.deepEqual(broken, [], broken.join("\n"));
  });

  test("none of them is rejected by its own argument schema", async () => {
    // If a generated-from-schema call fails validation, the schema describes
    // something the tool cannot actually be called with.
    const rejected = [];
    for (const tool of ALL_TOOLS) {
      const h = harness();
      const payload = h.payloadOf(await h.call(tool.name, sampleArgs(tool)));
      if (payload?.error === "invalid_arguments") {
        rejected.push(`${tool.name}: ${JSON.stringify(payload.problems ?? payload)}`);
      }
    }
    assert.deepEqual(rejected, [], rejected.join("\n"));
  });

  test("every tool can be found by searching for its own name", async () => {
    // A tool nobody can discover is a tool that does not exist. `search_tools`
    // is the only route to the 70-odd specialists.
    const h = harness();
    const missing = [];
    for (const tool of ALL_TOOLS) {
      const payload = h.payloadOf(await h.call("search_tools", { query: tool.name.replace(/_/g, " ") }));
      if (!payload.unlocked?.some((u) => u.name === tool.name)) missing.push(tool.name);
    }
    assert.deepEqual(missing, [], `not findable by name: ${missing.join(", ")}`);
  });

  test("every write-class tool that edits the DataModel takes one undo waypoint", async () => {
    // A change without a waypoint cannot be undone, which is the single most
    // user-hostile thing a Studio tool can do.
    const MUTATING = /:Destroy\(\)|\.Parent\s*=|Instance\.new|:PivotTo|:FillBlock|:FillBall|:FillCylinder|:WriteVoxels|:Clear\(\)/;
    const missing = [];
    for (const tool of ALL_TOOLS) {
      if (tool.channel !== "eval" || !capabilities(tool).write) continue;
      const luau = await Promise.resolve(harnessLuauFor(tool));
      if (!luau) continue;
      // `undo: "none"` is the declared exception, for scaffolding that
      // deliberately stays out of the user's edit history.
      if (tool.undo === "none") continue;
      if (MUTATING.test(luau) && !/ChangeHistoryService|__MCP\.waypoint/.test(luau)) {
        missing.push(tool.name);
      }
    }
    assert.deepEqual(missing, [], `mutating Luau with no undo waypoint: ${missing.join(", ")}`);
  });

  test("the undo exemption is used sparingly and only where it is explained", async () => {
    // Without this, `undo: "none"` becomes the way to silence the test above.
    const exempt = ALL_TOOLS.filter((t) => t.undo === "none").map((t) => t.name);
    assert.ok(exempt.length <= 8, `too many undo exemptions: ${exempt.join(", ")}`);
    for (const name of exempt) {
      assert.ok(
        /^(debug_|breakpoint_)/.test(name),
        `${name} claims undo: "none" but is not debug scaffolding`,
      );
    }
  });

  test("no generated Luau leaks an instance it only needed to borrow", async () => {
    // animation_play parented an Animation under the Animator to load a track,
    // and left it there. Every play added another dead child.
    const luau = await harnessLuauFor(ALL_TOOLS.find((t) => t.name === "animation_play"));
    assert.ok(luau, "expected animation_play to generate Luau");
    assert.doesNotMatch(luau, /anim\.Parent\s*=/, "the borrowed Animation must not be parented");
    assert.match(luau, /LoadAnimation/);
  });

  test("the sample generator is not producing empty calls", async () => {
    // Without this the suite above could be green because every call was `{}`
    // and bailed on a missing argument.
    const withRequired = ALL_TOOLS.filter((t) => (t.inputSchema?.required ?? []).length > 0);
    assert.ok(withRequired.length > 30, "most tools should have required arguments");
    for (const tool of withRequired) {
      const args = sampleArgs(tool);
      for (const key of tool.inputSchema.required) {
        assert.ok(key in args, `${tool.name}: generator produced no value for required '${key}'`);
      }
    }
  });
});

/** Capture the Luau an eval tool generates for sample arguments. */
async function harnessLuauFor(tool) {
  let luau = null;
  const ctx = {
    bridge: {
      connected: true,
      writeEnabled: true,
      async send(name, args) {
        if (name === "eval" && typeof args?.luau === "string") luau = args.luau;
        return { ok: true, source: "local a = 1", path: "Workspace.Sample" };
      },
    },
    memory: { getMacro: () => null, saveMacro: () => ({ name: "m", opCount: 0 }), listSnapshots: () => [] },
    handleMutate: async () => ({ applied: 1 }),
    getPlaceContext: async () => ({ placeId: 1, placeName: "t" }),
  };
  try {
    await tool.handler(sampleArgs(tool), ctx);
  } catch {
    /* the point is the Luau, not the result */
  }
  return luau;
}
