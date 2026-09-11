/**
 * The regression test for ARCHITECTURE-REVIEW.md A1.
 *
 * Generated Luau is still built from template strings, but the `__MCP` surface it
 * calls is now declared in one place, and this test fails the build if a template
 * calls something undeclared or if the surface advertised to the model drifts from
 * the surface that exists. That is the specific failure A1 described: rename a
 * helper, miss a template, discover it at runtime inside Studio as an opaque error.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { MCP_API, MCP_API_NAMES } from "../../dist/tools/mcp-api.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

async function toolSources() {
  const dir = join(SRC, "tools");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".ts"));
  const out = [];
  for (const f of files) out.push({ file: f, text: await readFile(join(dir, f), "utf8") });
  out.push({ file: "server.ts", text: await readFile(join(SRC, "server.ts"), "utf8") });
  return out;
}

describe("__MCP contract (A1)", () => {
  test("every __MCP helper a template calls is declared", async () => {
    const unknown = [];
    for (const { file, text } of await toolSources()) {
      for (const m of text.matchAll(/__MCP\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
        if (!MCP_API_NAMES.has(m[1])) unknown.push(`${file}: __MCP.${m[1]}`);
      }
    }
    assert.deepEqual(unknown, [], `undeclared __MCP helpers: ${unknown.join(", ")}`);
  });

  test("the surface advertised to the model matches the declaration", async () => {
    const server = await readFile(join(SRC, "server.ts"), "utf8");
    const desc = server.slice(server.indexOf("run_code: {"), server.indexOf("screenshot: {"));
    const advertised = [...desc.matchAll(/\b([a-zA-Z]+)\([a-zA-Z, ]*\)/g)]
      .map((m) => m[1])
      .filter((n) => MCP_API_NAMES.has(n));
    for (const helper of MCP_API) {
      assert.ok(
        advertised.includes(helper.name),
        `${helper.name} is declared but not advertised in the run_code description`,
      );
    }
  });

  test("helpers flagged as exercised really are called by a template", async () => {
    const all = (await toolSources()).map((s) => s.text).join("\n");
    for (const helper of MCP_API) {
      const called = all.includes(`__MCP.${helper.name}`);
      assert.equal(
        called,
        helper.exercisedByTemplates,
        `${helper.name}: exercisedByTemplates says ${helper.exercisedByTemplates} but templates ${called ? "do" : "do not"} call it`,
      );
    }
  });

  test("no template builds Luau by splicing a raw argument into source text", async () => {
    // Arguments must travel through luaJson (which emits a safe literal), never
    // through bare interpolation of a caller-controlled value.
    const offenders = [];
    for (const { file, text } of await toolSources()) {
      for (const m of text.matchAll(/\$\{([^}]+)\}/g)) {
        const expr = m[1].trim();
        const safe =
          expr.startsWith("luaJson(") ||
          /^(beginUndo\(|endUndo|cancelUndo|parseColorLua)/.test(expr) ||
          /^[A-Z_][A-Z0-9_]*$/.test(expr) || // module-level constants
          expr.startsWith("MAX_") ||
          expr.startsWith("DOWNSCALE_");
        if (!safe && /a\.|args\.|arg\b/.test(expr)) offenders.push(`${file}: \${${expr}}`);
      }
    }
    assert.deepEqual(offenders, [], `raw argument interpolation: ${offenders.join(", ")}`);
  });
});
