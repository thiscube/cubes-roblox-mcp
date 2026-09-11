/**
 * Shared test fixtures.
 *
 * The API docs tools read a 4 MB dump from Roblox's CDN. Unit tests must not
 * touch the network — a suite that only passes when the CDN is up is not a unit
 * test — so every file that can reach a docs handler installs this synthetic
 * dump first. It is small but structurally real: an inheritance chain, a
 * read-only member, a security-gated member, a method with parameters, an enum.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApiDocs, __setApiDocsForTest } from "../../dist/docs.js";

/**
 * Keep every test's on-disk state out of the developer's home directory.
 *
 * A bare `npm test` used to write `~/.cubesmcp/profiles/0.json`, because
 * `profile_update` appears in more than one suite's sample arguments and only
 * `profile.test.mjs` isolated itself. Importing this module is enough; it runs
 * once per test process, before any suite.
 *
 * CUBES_MCP_HOME, not HOME: `stateDir()` checks CUBES_MCP_HOME first, so
 * overriding HOME silently does nothing. That is exactly what went wrong in
 * profile.test.mjs — its isolation evaporated whenever CUBES_MCP_HOME was set.
 */
if (!process.env.CUBES_MCP_TEST_STATE) {
  const dir = mkdtempSync(join(tmpdir(), "cubes-mcp-test-state-"));
  process.env.CUBES_MCP_TEST_STATE = dir;
  process.env.CUBES_MCP_HOME = dir;
}

/** The isolated state directory for this test process. */
export const TEST_STATE_DIR = process.env.CUBES_MCP_TEST_STATE;


export const FAKE_DUMP = {
  Version: 1,
  Classes: [
    {
      Name: "Instance",
      Superclass: "<<<ROOT>>>",
      Members: [
        { Name: "Name", MemberType: "Property", ValueType: { Category: "Primitive", Name: "string" } },
        { Name: "ClassName", MemberType: "Property", Tags: ["ReadOnly"], ValueType: { Category: "Primitive", Name: "string" } },
        {
          Name: "Destroy",
          MemberType: "Function",
          Parameters: [],
          ReturnType: { Category: "Primitive", Name: "void" },
        },
        {
          Name: "FindFirstChild",
          MemberType: "Function",
          Parameters: [
            { Name: "name", Type: { Category: "Primitive", Name: "string" } },
            { Name: "recursive", Type: { Category: "Primitive", Name: "bool" }, Default: "false" },
          ],
          ReturnType: { Category: "Class", Name: "Instance" },
        },
        { Name: "Changed", MemberType: "Event", Parameters: [{ Name: "property", Type: { Category: "Primitive", Name: "string" } }] },
      ],
    },
    {
      Name: "BasePart",
      Superclass: "Instance",
      Members: [
        { Name: "Anchored", MemberType: "Property", ValueType: { Category: "Primitive", Name: "bool" } },
        { Name: "Transparency", MemberType: "Property", ValueType: { Category: "Primitive", Name: "float" } },
        { Name: "Material", MemberType: "Property", ValueType: { Category: "Enum", Name: "Material" } },
        {
          Name: "SecretFlag",
          MemberType: "Property",
          Security: { Read: "RobloxScriptSecurity", Write: "RobloxScriptSecurity" },
          ValueType: { Category: "Primitive", Name: "bool" },
        },
        {
          // Security says None, but assigning it from Luau throws. 36 real
          // properties look like this, Lighting.Technology among them.
          Name: "EngineOnlyFlag",
          MemberType: "Property",
          Tags: ["NotScriptable"],
          ValueType: { Category: "Primitive", Name: "bool" },
        },
        {
          // This server IS a Studio plugin, so it can write these.
          Name: "PluginOnlyFlag",
          MemberType: "Property",
          Security: { Read: "PluginSecurity", Write: "PluginSecurity" },
          ValueType: { Category: "Primitive", Name: "bool" },
        },
        {
          // Older dumps carried Security as a bare string.
          Name: "LegacyShapedFlag",
          MemberType: "Property",
          Security: "RobloxScriptSecurity",
          ValueType: { Category: "Primitive", Name: "bool" },
        },
        {
          // A lowercase deprecated alias, the kind that used to outrank the real
          // property in docs_search.
          Name: "transparency",
          MemberType: "Property",
          Tags: ["Deprecated"],
          ValueType: { Category: "Primitive", Name: "float" },
        },
      ],
    },
    {
      Name: "Part",
      Superclass: "BasePart",
      Tags: ["Creatable"],
      Members: [{ Name: "Shape", MemberType: "Property", ValueType: { Category: "Enum", Name: "PartType" } }],
    },
    { Name: "PointLight", Superclass: "Instance", Members: [{ Name: "Range", MemberType: "Property", ValueType: { Category: "Primitive", Name: "float" } }] },
  ],
  Enums: [
    { Name: "Material", Items: [{ Name: "Plastic", Value: 256 }, { Name: "Wood", Value: 512 }, { Name: "Neon", Value: 288 }] },
    { Name: "PartType", Items: [{ Name: "Ball", Value: 0 }, { Name: "Block", Value: 1 }] },
  ],
};

/** Install the fixture as the process-wide dump. Call before touching a docs tool. */
export function installFakeDump() {
  __setApiDocsForTest(ApiDocs.fromDump(FAKE_DUMP, { studioVersion: "version-test", ageHours: 0 }));
}
