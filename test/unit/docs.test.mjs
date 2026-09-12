/**
 * The engine API reference (PLAN.md #4).
 *
 * Everything here runs against a synthetic dump, never the network. The point of
 * these tools is that the agent stops guessing property names, so the things
 * worth testing are: does inheritance resolve the way Studio resolves it, is
 * "can I write this" derived correctly, and does a miss come back with something
 * actionable instead of "not found".
 */
import { test, describe, before, afterEach } from "node:test";
import assert from "node:assert/strict";

import { createMcpServer } from "../../dist/server.js";
import {
  ApiDocs,
  getApiDocs,
  resolveStudioVersion,
  __setApiDocsForTest,
  __setDocsFetchForTest,
} from "../../dist/docs.js";
import { DOCS_TOOLS } from "../../dist/tools/docs.js";
import { capabilities } from "../../dist/registry.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { FAKE_DUMP, installFakeDump } from "./_fixtures.mjs";

installFakeDump();


/** Undo luaStringLiteral: `\\ddd` decimal escapes, plus escaped quote and backslash. */
function luaUnescape(s) {
  const out = [];
  for (let i = 0; i < s.length; ) {
    if (s[i] !== "\\") {
      out.push(s.charCodeAt(i));
      i += 1;
      continue;
    }
    const digits = /^\d{3}/.exec(s.slice(i + 1));
    if (digits) {
      out.push(Number(digits[0]));
      i += 4;
    } else {
      out.push(s.charCodeAt(i + 1));
      i += 2;
    }
  }
  return Buffer.from(out).toString("utf8");
}

const tool = (name) => DOCS_TOOLS.find((t) => t.name === name);
const call = (name, args = {}) => tool(name).handler(args, {});

describe("ApiDocs index", () => {
  before(installFakeDump);

  test("class lookup is case-insensitive", () => {
    const api = ApiDocs.fromDump(FAKE_DUMP);
    assert.equal(api.getClass("part")?.Name, "Part");
    assert.equal(api.getClass("PART")?.Name, "Part");
    assert.equal(api.getClass("nope"), undefined);
  });

  test("ancestry walks to the root and stops", () => {
    const api = ApiDocs.fromDump(FAKE_DUMP);
    assert.deepEqual(
      api.ancestry("Part").map((c) => c.Name),
      ["Part", "BasePart", "Instance"],
    );
  });

  test("own members exclude inherited ones by default", () => {
    const api = ApiDocs.fromDump(FAKE_DUMP);
    assert.deepEqual(
      api.members("Part").map((m) => m.member.Name),
      ["Shape"],
    );
    const all = api.members("Part", { inherited: true }).map((m) => m.member.Name);
    assert.ok(all.includes("Anchored"), "should inherit from BasePart");
    assert.ok(all.includes("Name"), "should inherit from Instance");
  });

  test("a member is found by walking up the chain, and says where from", () => {
    const api = ApiDocs.fromDump(FAKE_DUMP);
    const found = api.findMember("Part", "anchored");
    assert.equal(found.member.Name, "Anchored");
    assert.equal(found.declaredOn, "BasePart");
    assert.equal(found.inherited, true);

    const own = api.findMember("Part", "Shape");
    assert.equal(own.inherited, false);
  });

  test("a cyclic or missing superclass cannot hang the walk", () => {
    const api = ApiDocs.fromDump({
      Version: 1,
      Enums: [],
      Classes: [
        { Name: "A", Superclass: "B", Members: [] },
        { Name: "B", Superclass: "A", Members: [] },
        { Name: "Orphan", Superclass: "DoesNotExist", Members: [] },
      ],
    });
    assert.deepEqual(api.ancestry("A").map((c) => c.Name), ["A", "B"]);
    assert.deepEqual(api.ancestry("Orphan").map((c) => c.Name), ["Orphan"]);
  });
});

describe("docs_class", () => {
  before(installFakeDump);

  test("returns real properties with types", async () => {
    const res = await call("docs_class", { class: "BasePart" });
    const byName = Object.fromEntries(res.members.map((m) => [m.name, m]));
    assert.equal(byName.Anchored.type, "bool");
    assert.equal(byName.Transparency.type, "float");
    assert.equal(byName.Material.type, "Material");
  });

  test("writable is three-valued, because the honest answer is", async () => {
    const res = await call("docs_class", { class: "Instance" });
    const byName = Object.fromEntries(res.members.map((m) => [m.name, m]));
    assert.equal(byName.Name.writable, true);
    assert.equal(byName.ClassName.writable, false, "ReadOnly tag must block writes");

    const base = Object.fromEntries(
      (await call("docs_class", { class: "BasePart", limit: 100 })).members.map((m) => [m.name, m]),
    );
    assert.equal(base.Anchored.writable, true);

    // RobloxScriptSecurity: genuinely closed to us.
    assert.equal(base.SecretFlag.writable, false);
    assert.ok(base.SecretFlag.security.includes("RobloxScriptSecurity"));

    // NotScriptable: the dump says Security None, but assignment throws. This is
    // the false positive that sent the agent into a confident failed mutate.
    assert.equal(base.EngineOnlyFlag.writable, false, "NotScriptable must not read as writable");

    // PluginSecurity: this server IS a Studio plugin, so it CAN write these.
    // Reporting them as unwritable was a false negative on 94 real properties.
    assert.equal(base.PluginOnlyFlag.writable, "plugin");

    // Older dumps carried Security as a bare string; that branch still works.
    assert.equal(base.LegacyShapedFlag.writable, false);
    assert.equal(base.LegacyShapedFlag.security, "RobloxScriptSecurity");
  });

  test("methods carry their parameter list and return type", async () => {
    const res = await call("docs_class", { class: "Instance", members: "functions" });
    const find = res.members.find((m) => m.name === "FindFirstChild");
    assert.deepEqual(find.params, ["name: string", "recursive: bool = false"]);
    assert.equal(find.returns, "Instance");
  });

  test("events are listed separately from functions", async () => {
    const events = await call("docs_class", { class: "Instance", members: "events" });
    assert.deepEqual(events.members.map((m) => m.name), ["Changed"]);
  });

  test("inherited members are labelled with the class that declares them", async () => {
    const res = await call("docs_class", { class: "Part", inherited: true, limit: 100 });
    const anchored = res.members.find((m) => m.name === "Anchored");
    assert.equal(anchored.from, "BasePart");
    const shape = res.members.find((m) => m.name === "Shape");
    assert.equal(shape.from, undefined, "own members should not be labelled");
  });

  test("own-members-only says how to get the rest", async () => {
    const res = await call("docs_class", { class: "Part" });
    assert.match(res.note, /inherited: true/);
    assert.match(res.note, /BasePart -> Instance/);
  });

  test("filter and limit both apply, and truncation is disclosed", async () => {
    const filtered = await call("docs_class", { class: "BasePart", filter: "anchor" });
    assert.deepEqual(filtered.members.map((m) => m.name), ["Anchored"]);

    const all = await call("docs_class", { class: "BasePart", limit: 100 });
    const limited = await call("docs_class", { class: "BasePart", limit: 1 });
    assert.equal(limited.members.length, 1);
    assert.equal(limited.truncated, true);
    assert.equal(limited.total, all.members.length, "total counts what matched, not what fit");
  });

  test("an unknown class suggests near misses instead of just failing", async () => {
    const res = await call("docs_class", { class: "Poin" });
    assert.equal(res.error, "unknown_class");
    assert.deepEqual(res.did_you_mean, ["PointLight"]);
  });

  test("every response carries the dump's provenance", async () => {
    const res = await call("docs_class", { class: "Part" });
    assert.equal(res.studio_version, "version-test");
    assert.equal(typeof res.dump_age_hours, "number");
  });

  test("a stale dump says so rather than answering silently", async () => {
    __setApiDocsForTest(
      ApiDocs.fromDump(FAKE_DUMP, {
        studioVersion: "version-old",
        ageHours: 96,
        stale: true,
        refreshError: "getaddrinfo ENOTFOUND setup.rbxcdn.com",
      }),
    );
    const res = await call("docs_class", { class: "Part" });
    assert.equal(res.stale, true);
    assert.match(res.refresh_error, /ENOTFOUND/);
    installFakeDump();
  });
});

describe("docs_member", () => {
  before(installFakeDump);

  test("resolves through the chain and reports where it was declared", async () => {
    const res = await call("docs_member", { class: "Part", member: "transparency" });
    assert.equal(res.declared_on, "BasePart");
    assert.equal(res.inherited, true);
    assert.equal(res.member.type, "float");
  });

  test("an unknown member suggests near misses", async () => {
    const res = await call("docs_member", { class: "Part", member: "Transp" });
    assert.equal(res.error, "unknown_member");
    // The fixture carries both `Transparency` and the deprecated lowercase alias.
    assert.deepEqual(new Set(res.did_you_mean), new Set(["Transparency", "transparency"]));
  });
});

describe("docs_enum", () => {
  before(installFakeDump);

  test("lists the items of one enum", async () => {
    const res = await call("docs_enum", { enum: "material" });
    assert.equal(res.enum, "Material");
    assert.deepEqual(res.items.map((i) => i.Name), ["Plastic", "Wood", "Neon"]);
  });

  test("lists enum names when none is named", async () => {
    const res = await call("docs_enum", {});
    assert.deepEqual(res.enums, ["Material", "PartType"]);
  });

  test("filters items by substring", async () => {
    const res = await call("docs_enum", { enum: "Material", filter: "o" });
    assert.deepEqual(res.items.map((i) => i.Name), ["Wood", "Neon"]);
  });

  test("an unknown enum suggests near misses", async () => {
    const res = await call("docs_enum", { enum: "Mater" });
    assert.equal(res.error, "unknown_enum");
    assert.deepEqual(res.did_you_mean, ["Material"]);
  });
});

describe("docs_search", () => {
  before(installFakeDump);

  test("finds classes, members and enums in one pass", async () => {
    const res = await call("docs_search", { query: "part" });
    assert.ok(res.classes.includes("Part") && res.classes.includes("BasePart"));
    assert.ok(res.enums.includes("PartType"));
  });

  test("answers 'which class has this property'", async () => {
    const res = await call("docs_search", { query: "anchored", kind: "members" });
    assert.deepEqual(res.members, [
      { class: "BasePart", member: "Anchored", kind: "Property", type: "bool" },
    ]);
    assert.equal(res.members[0].reach, undefined, "ranking inputs are not answers");
  });

  test("exact matches rank above longer names that merely contain the query", async () => {
    // Without ranking, substring order buries the answer: over the real dump,
    // "transparency" returns four PlayerGui topbar helpers before
    // BasePart.Transparency.
    const res = await call("docs_search", { query: "material", kind: "members" });
    assert.equal(res.members[0].member, "Material", "the exact match must come first");

    const classes = await call("docs_search", { query: "part", kind: "classes" });
    assert.equal(classes.classes[0], "Part");
    assert.ok(classes.classes.indexOf("BasePart") > 0, "a suffix match ranks below the exact one");
  });

  test("a deprecated alias never outranks the real property", async () => {
    // `Fire.size`, `BodyGyro.cframe` and friends are lowercase leftovers. They
    // tie on name rank with the real member and used to win on dump order.
    const res = await call("docs_search", { query: "transparency", kind: "members" });
    assert.equal(res.members[0].member, "Transparency");
    assert.equal(res.members[0].class, "BasePart");
    const alias = res.members.find((m) => m.member === "transparency");
    assert.ok(alias?.deprecated, "the alias should be present and marked");
    assert.ok(res.members.indexOf(alias) > 0, "and it should rank below the real one");
  });

  test("the class with more descendants wins an exact-name tie", async () => {
    // "this is the class everybody means", cheaply. BasePart has descendants in
    // the fixture; PointLight has none.
    const res = await call("docs_search", { query: "material", kind: "members" });
    assert.equal(res.members[0].class, "BasePart");
  });

  test("an empty query is refused rather than matching everything", async () => {
    const res = await call("docs_search", { query: "   " });
    assert.equal(res.error, "bad_args");
  });
});

describe("docs_defaults", () => {
  before(installFakeDump);

  test("is read-class but transient, not a pure read and not a write", () => {
    // The dump has no defaults, so this one has to ask Studio. It constructs an
    // Instance, which is why it is not `readOnly: true` — but it never parents
    // it, so calling it write-class shipped destructiveHint on a docs lookup and
    // dropped it from the read-only build, which exists to inspect things.
    const entry = tool("docs_defaults");
    assert.equal(entry.channel, "eval");
    const cap = capabilities(entry);
    assert.equal(cap.write, false, "it changes nothing, so no write gate");
    assert.equal(cap.transient, true);
    assert.equal(cap.touchesStudio, true, "it does reach Studio, and says so");
  });

  test("fills the property list from the dump when the caller omits it", async () => {
    const sent = [];
    const transport = {
      connected: true,
      writeEnabled: true,
      async send(t, args) {
        sent.push({ t, args });
        return { ok: true };
      },
    };
    const server = createMcpServer(transport);
    await server._requestHandlers.get(CallToolRequestSchema.shape.method.value)(
      { method: "tools/call", params: { name: "docs_defaults", arguments: { class: "BasePart" } } },
      { signal: new AbortController().signal },
    );
    assert.equal(sent.length, 1);
    const luau = sent[0].args.luau;
    // Writable own properties only: Anchored, Transparency, Material.
    assert.match(luau, /Anchored/);
    assert.match(luau, /Transparency/);
    assert.match(luau, /Material/);
    assert.doesNotMatch(luau, /SecretFlag/, "a security-gated property must not be requested");
    assert.doesNotMatch(luau, /ClassName/, "inherited members are not this class's defaults");
    assert.match(luau, /Instance\.new/);
    assert.match(luau, /inst:Destroy\(\)/, "the temp instance must be cleaned up");
  });

  test("the class name reaches Luau as a literal, never as spliced source", async () => {
    const sent = [];
    const transport = {
      connected: true,
      writeEnabled: true,
      async send(t, args) {
        sent.push(args);
        return { ok: true };
      },
    };
    const server = createMcpServer(transport);
    await server._requestHandlers.get(CallToolRequestSchema.shape.method.value)(
      {
        method: "tools/call",
        params: {
          name: "docs_defaults",
          arguments: { class: 'Part"] end; game:Shutdown(); --', properties: ["Name"] },
        },
      },
      { signal: new AbortController().signal },
    );
    assert.equal(sent.length, 1);

    // The hostile text DOES appear in the source — inside a quoted Lua string
    // literal, which is the whole point. So checking for its absence would be
    // the wrong test. Decode the literal the way Lua would and prove it comes
    // back as data, byte for byte, with the string never closed early.
    const literal = /__MCP\.decode\((".*?")\)\n/s.exec(sent[0].luau);
    assert.ok(literal, "expected a single quoted literal argument to decode");
    const decoded = luaUnescape(literal[1].slice(1, -1));
    assert.equal(JSON.parse(decoded).class, 'Part"] end; game:Shutdown(); --');
  });
});

describe("offline behaviour", () => {
  test("CUBES_MCP_OFFLINE=1 with no cache fails loudly instead of fetching", async () => {
    const offline = process.env.CUBES_MCP_OFFLINE;
    const home = process.env.CUBES_MCP_HOME;
    process.env.CUBES_MCP_OFFLINE = "1";
    // Point the cache at a directory that cannot exist, so the result does not
    // depend on whether this machine happens to have a real dump cached.
    process.env.CUBES_MCP_HOME = "/nonexistent-state-dir-for-this-test";
    __setApiDocsForTest(null);
    try {
      await assert.rejects(() => getApiDocs({ forceRefresh: true }), /CUBES_MCP_OFFLINE/);
    } finally {
      if (offline === undefined) delete process.env.CUBES_MCP_OFFLINE;
      else process.env.CUBES_MCP_OFFLINE = offline;
      if (home === undefined) delete process.env.CUBES_MCP_HOME;
      else process.env.CUBES_MCP_HOME = home;
      installFakeDump();
    }
  });
});

/**
 * The version resolver (PLAN #4, reopened).
 *
 * `setup.rbxcdn.com/versionQTStudio` still answers, and still answers with a
 * hash whose dump parses — it is just frozen on a build with 682 classes where
 * the live one has 916, missing StudioTestService, PluginConnectionService and
 * VirtualInput among others. Nothing fails; lookups just say "no such class".
 * That is what these tests are for: the live resolver is preferred, the frozen
 * one is a labelled fallback, and which answered is never thrown away.
 */
describe("API dump version resolver", () => {
  const CHANNEL = "https://clientsettingscdn.roblox.com/v2/client-version/WindowsStudio64";
  const LEGACY = "https://setup.rbxcdn.com/versionQTStudio";

  const reply = (body) => ({ ok: true, status: 200, text: async () => body });
  const dead = { ok: false, status: 503, text: async () => "" };

  afterEach(() => __setDocsFetchForTest(null));

  test("prefers the live channel endpoint", async () => {
    const seen = [];
    __setDocsFetchForTest(async (url) => {
      seen.push(url);
      if (url === CHANNEL) {
        return reply(JSON.stringify({ version: "0.738.0.7381393", clientVersionUpload: "version-93202a13414c4131" }));
      }
      return dead;
    });
    const res = await resolveStudioVersion(50);
    assert.equal(res.studioVersion, "version-93202a13414c4131");
    assert.equal(res.versionSource, "clientsettings");
    assert.deepEqual(seen, [CHANNEL], "the frozen endpoint must not be touched when the live one answers");
  });

  test("falls back to the frozen endpoint when the channel is unreachable", async () => {
    __setDocsFetchForTest(async (url) => (url === LEGACY ? reply("version-d0e8cfcd943d4ae2\n") : dead));
    const res = await resolveStudioVersion(50);
    assert.equal(res.studioVersion, "version-d0e8cfcd943d4ae2");
    assert.equal(res.versionSource, "legacy", "a degraded answer has to be labelled as one");
  });

  test("falls back when the channel answers with the wrong shape", async () => {
    // A 200 with unusable JSON is the failure mode that would otherwise poison
    // the cache with a bad hash, so it has to route to the fallback, not throw.
    for (const body of ["{}", '{"clientVersionUpload":null}', '{"clientVersionUpload":"not-a-version"}', "<html>"]) {
      __setDocsFetchForTest(async (url) => (url === CHANNEL ? reply(body) : reply("version-abc12345")));
      const res = await resolveStudioVersion(50);
      assert.equal(res.versionSource, "legacy", `body ${body} should have fallen back`);
    }
  });

  test("refuses a junk version rather than fetching a junk dump URL", async () => {
    __setDocsFetchForTest(async () => reply("<!DOCTYPE html><html>404</html>"));
    await assert.rejects(() => resolveStudioVersion(50), /unexpected Studio version string/);
  });

  test("offline refuses the real network but not a stub", async () => {
    const prev = process.env.CUBES_MCP_OFFLINE;
    process.env.CUBES_MCP_OFFLINE = "1";
    try {
      __setDocsFetchForTest(null);
      await assert.rejects(() => resolveStudioVersion(50), /CUBES_MCP_OFFLINE/);
      __setDocsFetchForTest(async () => reply("version-abc12345"));
      assert.equal((await resolveStudioVersion(50)).versionSource, "legacy");
    } finally {
      if (prev === undefined) delete process.env.CUBES_MCP_OFFLINE;
      else process.env.CUBES_MCP_OFFLINE = prev;
    }
  });
});

/**
 * Provenance must never overwrite a tool's own answer.
 *
 * Every docs response spreads `provenance` LAST, so any key it adds wins over
 * the same key set by the tool. That has now bitten twice: `classes` clobbered
 * `docs_search`'s result array, and `hint` clobbered the guidance in
 * `docs_class`'s unknown_class branch and `docs_search`'s bad_args branch —
 * the latter telling a model that passed an empty query about the dump's age
 * and never telling it to pass a query.
 *
 * The pairing is not hypothetical: "legacy" is precisely the state in which
 * classes go missing, so unknown_class + legacy is the likeliest combination in
 * the system. So this asserts the property, not the two known keys.
 */
describe("docs provenance never clobbers a tool's own keys", () => {
  const legacyDump = () =>
    __setApiDocsForTest(
      ApiDocs.fromDump(FAKE_DUMP, { studioVersion: "version-test", ageHours: 0, versionSource: "legacy" }),
    );
  const call = (name, args) => DOCS_TOOLS.find((t) => t.name === name).handler(args, {});

  afterEach(() => installFakeDump());

  test("an error branch keeps its own hint when the dump is legacy", async () => {
    legacyDump();
    const unknown = await call("docs_class", { class: "NoSuchClassAnywhere" });
    assert.equal(unknown.error, "unknown_class");
    assert.match(unknown.hint, /docs_search/, "the tool's own guidance must survive provenance");

    const bad = await call("docs_search", { query: "   " });
    assert.equal(bad.error, "bad_args");
    assert.match(bad.hint, /query/, "bad_args must still say what was wrong with the args");
  });

  test("the degraded source is still reported, just not on top of a tool key", async () => {
    legacyDump();
    const res = await call("docs_class", { class: "NoSuchClassAnywhere" });
    assert.equal(res.version_source, "legacy");
    assert.match(res.dump_hint, /frozen versionQTStudio/);
    assert.equal(typeof res.dump_classes, "number");
  });

  test("provenance is silent about the source when it is the live one", async () => {
    installFakeDump();
    const res = await call("docs_class", { class: "NoSuchClassAnywhere" });
    assert.equal(res.version_source, undefined);
    assert.equal(res.dump_hint, undefined);
  });

  test("no provenance key collides with any key a docs tool sets", async () => {
    // The general property. Drive every docs tool down a success and an error
    // path with provenance OFF, collect every key each response owns, then
    // assert the provenance key set is disjoint from it.
    const PROVENANCE_KEYS = ["studio_version", "dump_age_hours", "dump_classes", "version_source", "dump_hint", "stale", "refresh_error"];
    const probes = [
      ["docs_class", { class: "Part" }],
      ["docs_class", { class: "NoSuchClassAnywhere" }],
      ["docs_member", { class: "Part", member: "Anchored" }],
      ["docs_member", { class: "Part", member: "NoSuchMember" }],
      ["docs_search", { query: "part" }],
      ["docs_search", { query: "   " }],
      ["docs_enum", { enum: "Material" }],
      ["docs_enum", { enum: "NoSuchEnum" }],
    ];
    installFakeDump();
    const owned = new Set();
    for (const [name, args] of probes) {
      const tool = DOCS_TOOLS.find((t) => t.name === name);
      if (!tool) continue;
      const res = await tool.handler(args, {});
      // Provenance is off in this state except for the two always-on keys, so
      // everything else present is a key the tool itself owns.
      for (const k of Object.keys(res ?? {})) owned.add(k);
    }
    const always = new Set(["studio_version", "dump_age_hours", "dump_classes"]);
    const collisions = PROVENANCE_KEYS.filter((k) => owned.has(k) && !always.has(k));
    assert.deepEqual(collisions, [], `provenance would overwrite tool-owned key(s): ${collisions.join(", ")}`);
  });
});
