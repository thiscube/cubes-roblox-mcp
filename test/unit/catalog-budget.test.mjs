/**
 * The tool catalog has a size budget, and this test is the budget.
 *
 * PLAN.md #6. Every visible tool's schema is re-sent on every turn, so the
 * catalog is a recurring per-turn cost, not a one-off. Progressive disclosure
 * used to hide most of it, but the tool set is grow-only now: over a long
 * session everything the agent has ever touched stays in `tools/list`. That
 * makes the whole catalog a realistic steady state rather than a worst case.
 *
 * Nothing enforced a limit on any individual description before. One tool ran
 * to 507 characters. These caps are deliberately tight: keywords drive search
 * (registry.ts), so a description only has to say what the tool does, when to
 * reach for it, and where the sharp edge is.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { createMcpServer } from "../../dist/server.js";
import { installFakeDump } from "./_fixtures.mjs";
import { ALL_TOOLS } from "../../dist/tools/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// Docs tools must answer from a fixture, never from Roblox's CDN.
installFakeDump();

/**
 * Hard ceiling on the serialized `tools/list` payload with every tool visible.
 * Not a target — if the catalog is anywhere near this, the tool list has become
 * the dominant per-turn cost and tools need cutting, not trimming.
 */
const MAX_CATALOG_CHARS = 64_000;
/**
 * Mean serialized chars per tool. This is the budget that actually bites: it
 * scales with the tool count, so adding tools never relaxes it and one bloated
 * tool has to be paid for by trimming another.
 */
const MAX_MEAN_TOOL_CHARS = 850;
/** Serialized chars for one specialist (name + description + schema + annotations). */
const MAX_TOOL_CHARS = 1_500;
/**
 * Core tools are always visible and carry more weight: `run_code` documents the
 * whole `__MCP` surface, and `read`/`mutate` are the universal verbs every other
 * tool is described against. A larger allowance, not an exemption.
 */
const MAX_CORE_TOOL_CHARS = 2_400;
/** Chars in one specialist's description. */
const MAX_TOOL_DESCRIPTION = 240;
/** Chars in one specialist argument's description. */
const MAX_ARG_DESCRIPTION = 120;
/** Core arguments carry grammars (`read.query`'s selector syntax) and get more room. */
const MAX_CORE_ARG_DESCRIPTION = 340;

const CORE = new Set(["search_tools", "read", "screenshot", "mutate", "run_code"]);

class FakeTransport {
  connected = true;
  writeEnabled = true;
  async send() {
    return { ok: true };
  }
}

/** tools/list with every specialist unlocked: the steady state of a long session. */
async function fullCatalog() {
  const server = createMcpServer(new FakeTransport());
  const handlers = server._requestHandlers;
  const signal = new AbortController().signal;
  // Unlock everything the way the agent would: one search per category, then
  // call-by-name for anything search didn't surface.
  for (const t of ALL_TOOLS) {
    await handlers.get(CallToolRequestSchema.shape.method.value)(
      { method: "tools/call", params: { name: t.name, arguments: {} } },
      { signal },
    );
  }
  return handlers.get(ListToolsRequestSchema.shape.method.value)(
    { method: "tools/list", params: {} },
    { signal },
  );
}

describe("catalog size budget (PLAN #6)", () => {
  test("every tool is visible once it has been called", async () => {
    const { tools } = await fullCatalog();
    assert.equal(tools.length, ALL_TOOLS.length + CORE.size);
  });

  test("the whole catalog stays under the hard ceiling", async () => {
    const { tools } = await fullCatalog();
    const chars = JSON.stringify(tools).length;
    assert.ok(
      chars <= MAX_CATALOG_CHARS,
      `catalog is ${chars} chars, ceiling is ${MAX_CATALOG_CHARS}. Cut tools, don't just trim words.`,
    );
  });

  test("mean cost per tool stays under budget", async () => {
    const { tools } = await fullCatalog();
    const mean = Math.round(JSON.stringify(tools).length / tools.length);
    assert.ok(
      mean <= MAX_MEAN_TOOL_CHARS,
      `mean is ${mean} chars/tool, budget is ${MAX_MEAN_TOOL_CHARS}. A new tool has to pay for itself.`,
    );
  });

  test("no single tool busts its per-tool cap", async () => {
    const { tools } = await fullCatalog();
    const over = tools
      .map((t) => [t.name, JSON.stringify(t).length])
      .filter(([name, size]) => size > (CORE.has(name) ? MAX_CORE_TOOL_CHARS : MAX_TOOL_CHARS))
      .map(([name, size]) => `${name} (${size})`);
    assert.deepEqual(over, [], `over the per-tool cap: ${over.join(", ")}`);
  });

  test("no specialist description busts its cap", () => {
    const over = ALL_TOOLS.filter((t) => t.description.length > MAX_TOOL_DESCRIPTION).map(
      (t) => `${t.name} (${t.description.length})`,
    );
    assert.deepEqual(over, [], `over ${MAX_TOOL_DESCRIPTION} chars: ${over.join(", ")}`);
  });

  test("no argument description busts its cap", async () => {
    const { tools } = await fullCatalog();
    const over = [];
    for (const t of tools) {
      const cap = CORE.has(t.name) ? MAX_CORE_ARG_DESCRIPTION : MAX_ARG_DESCRIPTION;
      for (const [key, spec] of Object.entries(t.inputSchema?.properties ?? {})) {
        const d = spec?.description;
        if (typeof d === "string" && d.length > cap) over.push(`${t.name}.${key} (${d.length})`);
      }
    }
    assert.deepEqual(over, [], `over the argument cap: ${over.join(", ")}`);
  });

  test("every tool actually has a description and a schema", () => {
    for (const t of ALL_TOOLS) {
      assert.ok(t.description?.trim().length > 20, `${t.name} needs a real description`);
      assert.equal(t.inputSchema?.type, "object", `${t.name} needs an object inputSchema`);
    }
  });

  test("descriptions do not open with the tool's own name", () => {
    // "part_create: creates a part" spends the budget restating the name.
    const echoes = ALL_TOOLS.filter((t) =>
      t.description.toLowerCase().startsWith(t.name.toLowerCase()),
    ).map((t) => t.name);
    assert.deepEqual(echoes, [], `descriptions restating their name: ${echoes.join(", ")}`);
  });
});
