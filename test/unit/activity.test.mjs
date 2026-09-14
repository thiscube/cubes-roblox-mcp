/**
 * The panel's one-word activity label: every tool has one, and the two tools
 * labelled from their arguments read those arguments correctly.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { TOOL_ACTIVITY, activityFor, mutateActivity, runCodeActivity, targetFor } from "../../dist/activity.js";
import { ALL_TOOLS } from "../../dist/tools/index.js";
import { CORE_TOOLS } from "../../dist/session.js";
import "./_fixtures.mjs";

const ONE_WORD = /^[A-Z][a-z]+$/;
// The panel's stat tile fits about this many characters at its font size.
const MAX_CHARS = 11;

describe("activity labels", () => {
  test("every tool has a label", () => {
    const missing = [...CORE_TOOLS, ...ALL_TOOLS.map((t) => t.name)].filter(
      (name) => name !== "mutate" && name !== "run_code" && !(name in TOOL_ACTIVITY),
    );
    assert.deepEqual(missing, [], `tools with no activity label: ${missing.join(", ")}`);
  });

  test("no label for a tool that does not exist", () => {
    const known = new Set([...CORE_TOOLS, ...ALL_TOOLS.map((t) => t.name)]);
    const stale = Object.keys(TOOL_ACTIVITY).filter((name) => !known.has(name));
    assert.deepEqual(stale, [], `labels for unknown tools: ${stale.join(", ")}`);
  });

  test("every label is one short word", () => {
    const labels = new Set([
      ...Object.values(TOOL_ACTIVITY),
      "Scripting", "Building", "Deleting", "Editing", "Renaming", "Tagging",
      "Sculpting", "Animating", "Reading", "Executing", "Working",
    ]);
    for (const label of labels) {
      assert.match(label, ONE_WORD, `"${label}" is not one word`);
      assert.ok(label.length <= MAX_CHARS, `"${label}" is too long for the tile`);
    }
  });
});

describe("mutate is labelled by its ops", () => {
  const cases = [
    ["writing a Source", [{ op: "set", target: "a", props: { Source: "print(1)" } }], "Scripting"],
    ["creating a script", [{ op: "create", class: "ModuleScript" }], "Scripting"],
    ["a script write beats a pile of parts", [{ op: "create", class: "Part" }, { op: "create", class: "Part" }, { op: "set", target: "s", props: { Source: "" } }], "Scripting"],
    ["creating parts", [{ op: "create", class: "Part" }, { op: "set", target: "p", props: { Anchored: true } }], "Building"],
    ["deleting", [{ op: "delete", target: "p" }], "Deleting"],
    ["mostly deleting", [{ op: "delete", target: "a" }, { op: "delete", target: "b" }, { op: "set", target: "c", props: { Anchored: true } }], "Deleting"],
    ["setting properties", [{ op: "set", target: "p", props: { Color: [1, 0, 0] } }], "Editing"],
    ["renaming", [{ op: "set", target: "p", props: { Name: "Door" } }], "Renaming"],
    ["tagging", [{ op: "set", target: "p", tags: ["Lava"] }], "Tagging"],
    ["an empty batch", [], "Editing"],
  ];
  for (const [what, ops, want] of cases) {
    test(what, () => assert.equal(mutateActivity({ ops }), want));
  }
  test("activityFor routes mutate through its ops", () => {
    assert.equal(activityFor("mutate", { ops: [{ op: "delete", target: "x" }] }), "Deleting");
  });
});

describe("run_code is labelled by its Luau", () => {
  const cases = [
    ["writing a Source", `workspace.Script.Source = "print(1)"`, "Scripting"],
    ["UpdateSourceAsync", `SES:UpdateSourceAsync(s, function() return "" end)`, "Scripting"],
    ["reading a Source is not scripting", `return workspace.Script.Source`, "Reading"],
    ["terrain fill", `workspace.Terrain:FillBlock(CFrame.new(), Vector3.one * 8, Enum.Material.Grass)`, "Sculpting"],
    ["tweening", `game:GetService("TweenService"):Create(p, info, goal):Play()`, "Animating"],
    ["creating", `local p = Instance.new("Part") p.Parent = workspace`, "Building"],
    ["cloning", `workspace.Door:Clone().Parent = workspace`, "Building"],
    ["destroying", `workspace.Old:Destroy()`, "Deleting"],
    ["setting a property", `workspace.Part.Anchored = true`, "Editing"],
    ["setting an attribute", `workspace.Part:SetAttribute("Hp", 10)`, "Editing"],
    ["moving a model", `workspace.Car:PivotTo(CFrame.new(0, 5, 0))`, "Editing"],
    ["a comparison is not a write", `return workspace.Part.Anchored == true`, "Reading"],
    ["pure read", `return #workspace:GetChildren()`, "Reading"],
    ["a commented-out write does not count", `-- workspace.Part:Destroy()\nreturn workspace.Part.Name`, "Reading"],
    ["a block comment does not count", `--[[ Instance.new("Part") ]]\nreturn 1`, "Reading"],
    ["empty", ``, "Executing"],
  ];
  for (const [what, luau, want] of cases) {
    test(what, () => assert.equal(runCodeActivity(luau), want));
  }
  test("activityFor routes run_code through its Luau", () => {
    assert.equal(activityFor("run_code", { luau: `workspace.X:Destroy()` }), "Deleting");
  });
});

describe("target is what the call acts on", () => {
  const cases = [
    ["a specialist's target", "script_edit", { target: "ServerScriptService.Main", edits: [] }, "ServerScriptService.Main"],
    ["a path", "read", { path: "Workspace.Lobby" }, "Workspace.Lobby"],
    ["a mutate's first op", "mutate", { ops: [{ op: "set", target: "p3", props: {} }] }, "p3"],
    ["a mutate batch counts the rest", "mutate", { ops: [{ op: "create", class: "Part", parent: "Workspace" }, { op: "delete", target: "x" }] }, "Workspace +1"],
    ["several targets", "selection_set", { targets: ["a", "b", "c"] }, "a +2"],
    ["a player", "character_walk", { player: "cube", direction: [1, 0, 0] }, "cube"],
    ["a docs class", "docs_class", { class: "Part" }, "Part"],
    ["run_code has no subject", "run_code", { luau: "return 1" }, undefined],
    ["no args", "playtest_stop", undefined, undefined],
  ];
  for (const [what, tool, args, want] of cases) {
    test(what, () => assert.equal(targetFor(tool, args), want));
  }
  test("a long target is clipped", () => {
    assert.equal(targetFor("read", { path: "x".repeat(500) }).length, 120);
  });
});
