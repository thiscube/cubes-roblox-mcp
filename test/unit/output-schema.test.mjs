/**
 * Declared result shapes have to be true (PLAN.md #5).
 *
 * A tool that declares an `outputSchema` and then returns something else is
 * worse than a tool that declares nothing: a validating client rejects the
 * result. So this file does not just check that a schema exists — it calls every
 * tool through the fake transport and validates the real payload against the
 * schema the server advertised for it.
 *
 * What it can and cannot prove: tools on the `eval` and `dispatch` channels have
 * their real shape produced inside Studio, so all that is verifiable from here
 * is the wrapper this server puts around it. Those tools declare only the
 * wrapper. Tools on the `local` channel run in this process, so their payloads
 * are the genuine article and the validation below is the real test.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { createMcpServer } from "../../dist/server.js";
import { ALL_TOOLS } from "../../dist/tools/index.js";
import { outputSchemaFor } from "../../dist/registry.js";
import { validateArgs } from "../../dist/validate.js";
import { RESULT_ENVELOPE } from "../../dist/output-schema.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

class FakeTransport {
  connected = true;
  writeEnabled = true;
  sent = [];
  async send(tool, args) {
    this.sent.push({ tool, args });
    // Shaped like a real plugin answer so payloads are not trivially empty.
    return { ok: true, tool, applied: 1, results: [] };
  }
}

function harness() {
  const transport = new FakeTransport();
  const server = createMcpServer(transport);
  const h = server._requestHandlers;
  const signal = new AbortController().signal;
  return {
    transport,
    call: (name, args = {}) =>
      h.get(CallToolRequestSchema.shape.method.value)(
        { method: "tools/call", params: { name, arguments: args } },
        { signal },
      ),
    list: () =>
      h.get(ListToolsRequestSchema.shape.method.value)(
        { method: "tools/list", params: {} },
        { signal },
      ),
    readResource: (uri) =>
      h.get(ReadResourceRequestSchema.shape.method.value)(
        { method: "resources/read", params: { uri } },
        { signal },
      ),
  };
}

/** Representative arguments so a call reaches its handler instead of failing validation. */
const SAMPLE_ARGS = {
  run_code: { luau: "return 1" },
  read: { path: "Workspace" },
  search_tools: { query: "terrain" },
  mutate: { ops: [{ op: "set", target: "Workspace.P", props: { Anchored: true } }] },
  script_edit: { target: "Workspace.S", edits: [{ find: "a", replace: "b" }], confirm: true },
  snapshot: { name: "s1", path: "Workspace" },
  diff: { from: "s1", to: "s2" },
  macro_save: { name: "m1" },
  macro_run: { name: "m1" },
  profile_update: { genre: "obby" },
};

describe("declared result shapes (PLAN #5)", () => {
  test("every tool in tools/list declares an outputSchema", async () => {
    const h = harness();
    for (const t of ALL_TOOLS) await h.call(t.name, SAMPLE_ARGS[t.name] ?? {});
    const { tools } = await h.list();
    const missing = tools
      .filter((t) => !t.outputSchema || t.outputSchema.type !== "object")
      .map((t) => t.name);
    assert.deepEqual(missing, [], `tools with no object outputSchema: ${missing.join(", ")}`);
  });

  test("no declared schema marks a field required", async () => {
    // Any handler may return the error envelope instead of its success shape, so
    // a `required` list would make every error result fail at the client.
    const h = harness();
    for (const t of ALL_TOOLS) await h.call(t.name, SAMPLE_ARGS[t.name] ?? {});
    const { tools } = await h.list();
    const offenders = tools.filter((t) => Array.isArray(t.outputSchema?.required)).map((t) => t.name);
    assert.deepEqual(offenders, [], `outputSchema with required: ${offenders.join(", ")}`);
  });

  test("every result carries structuredContent that matches its own schema", async () => {
    const h = harness();
    const failures = [];
    const names = [...ALL_TOOLS.map((t) => t.name), "search_tools", "read", "mutate", "run_code"];
    for (const name of names) {
      const res = await h.call(name, SAMPLE_ARGS[name] ?? {});
      if (!res.structuredContent) {
        failures.push(`${name}: no structuredContent`);
        continue;
      }
      const { tools } = await h.list();
      const declared = tools.find((t) => t.name === name)?.outputSchema;
      const problems = validateArgs(res.structuredContent, declared);
      if (problems.length > 0) failures.push(`${name}: ${problems.map((p) => p.message).join("; ")}`);
    }
    assert.deepEqual(failures, [], failures.join("\n"));
  });

  test("structuredContent is the same object the text block carries", async () => {
    const h = harness();
    const res = await h.call("search_tools", { query: "terrain" });
    const text = JSON.parse(res.content.find((c) => c.type === "text").text);
    assert.deepEqual(res.structuredContent, text, "the two representations must not drift");
  });

  test("an error result still validates against the tool's schema", async () => {
    const h = harness();
    // Missing required args: the handler is never reached and the error envelope
    // comes back instead. Clients validate that against the same declared schema.
    const res = await h.call("run_code", {});
    assert.equal(res.isError, true);
    assert.ok(res.structuredContent.error, "expected an error payload");
    const { tools } = await h.list();
    const declared = tools.find((t) => t.name === "run_code").outputSchema;
    assert.deepEqual(validateArgs(res.structuredContent, declared), []);
  });

  test("the envelope is documented as a resource instead of repeated per tool", async () => {
    const h = harness();
    const res = await h.readResource("cubes://schema/result");
    const body = JSON.parse(res.contents[0].text);
    assert.deepEqual(body.envelope, RESULT_ENVELOPE);
    for (const field of ["error", "hint", "next_likely", "auto_unlocked", "unchanged"]) {
      assert.ok(body.envelope.properties[field], `${field} missing from the envelope`);
    }
  });

  test("no schema emits additionalProperties, which is the default anyway", async () => {
    const h = harness();
    for (const t of ALL_TOOLS) await h.call(t.name, SAMPLE_ARGS[t.name] ?? {});
    const { tools } = await h.list();
    const wasteful = tools.filter((t) => "additionalProperties" in (t.outputSchema ?? {}));
    assert.deepEqual(
      wasteful.map((t) => t.name),
      [],
      "open is the JSON Schema default; emitting it costs 27 chars per tool per turn",
    );
  });

  test("negative control: the validator actually rejects a wrong payload", async () => {
    // Without this, every assertion above could be passing because the schemas
    // are too loose to reject anything.
    const h = harness();
    await h.call("search_tools", { query: "terrain" });
    const { tools } = await h.list();
    const declared = tools.find((t) => t.name === "search_tools").outputSchema;

    assert.deepEqual(validateArgs({ unlocked: [], message: "fine" }, declared), []);
    assert.ok(
      validateArgs({ unlocked: "not an array" }, declared).length > 0,
      "a string where an array is declared must be rejected",
    );
    assert.ok(
      validateArgs({ message: 42 }, declared).length > 0,
      "a number where a string is declared must be rejected",
    );

    const mutate = tools.find((t) => t.name === "mutate").outputSchema;
    assert.ok(
      validateArgs({ level: "catastrophic" }, mutate).length > 0,
      "a value outside the declared enum must be rejected",
    );
  });

  test("the channel picks the default shape", () => {
    const byChannel = new Map();
    for (const t of ALL_TOOLS) byChannel.set(t.channel, (byChannel.get(t.channel) ?? 0) + 1);
    assert.ok(byChannel.get("eval") > 0 && byChannel.get("dispatch") > 0);

    const evalTool = ALL_TOOLS.find((t) => t.channel === "eval" && !t.outputSchema);
    assert.deepEqual(outputSchemaFor(evalTool), {
      type: "object",
      properties: { result: {} },
    });

    const dispatch = ALL_TOOLS.find((t) => t.channel === "dispatch" && !t.outputSchema);
    assert.deepEqual(outputSchemaFor(dispatch), { type: "object" });

    // An explicit declaration always wins over the channel default.
    assert.deepEqual(outputSchemaFor({ channel: "eval", outputSchema: { type: "object", properties: { x: {} } } }), {
      type: "object",
      properties: { x: {} },
    });
  });
});
