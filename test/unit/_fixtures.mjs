/**
 * Shared test fixtures.
 *
 * The API docs tools read a 4 MB dump from Roblox's CDN. Unit tests must not
 * touch the network — a suite that only passes when the CDN is up is not a unit
 * test — so every file that can reach a docs handler installs this synthetic
 * dump first. It is small but structurally real: an inheritance chain, a
 * read-only member, a security-gated member, a method with parameters, an enum.
 */
import { ApiDocs, __setApiDocsForTest } from "../../dist/docs.js";

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
