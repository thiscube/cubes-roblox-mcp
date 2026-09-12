/**
 * The modules that had no test of their own (PLAN.md #12).
 *
 * `paths`, `sourcemap` and `suggest` are all small, all pure enough to test
 * directly, and all load-bearing: paths decides where the user's files go,
 * sourcemap decides whether the agent edits the real file or the DataModel copy,
 * and suggest is the thing shaping what the model does next.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stateDir, profileDir, apiDumpFile } from "../../dist/paths.js";
import { SourceMap } from "../../dist/sourcemap.js";
import { suggestNext } from "../../dist/suggest.js";
import "./_fixtures.mjs";

describe("state paths", () => {
  test("everything hangs off one root, so relocating moves all of it", () => {
    const root = stateDir();
    assert.ok(profileDir().startsWith(root), "profiles must live under the state dir");
    assert.ok(apiDumpFile().startsWith(root), "the dump cache must too");
  });

  test("CUBES_MCP_HOME wins, and is read per call rather than at import", () => {
    // Per call is the point: these were module constants computed from homedir()
    // at import time, so a test could not redirect them and a leaked cache from
    // one suite showed up in another.
    const before = process.env.CUBES_MCP_HOME;
    try {
      process.env.CUBES_MCP_HOME = "/tmp/somewhere-else";
      assert.equal(stateDir(), "/tmp/somewhere-else");
      assert.equal(profileDir(), join("/tmp/somewhere-else", "profiles"));
      assert.equal(apiDumpFile(), join("/tmp/somewhere-else", "api-dump.json"));
    } finally {
      if (before === undefined) delete process.env.CUBES_MCP_HOME;
      else process.env.CUBES_MCP_HOME = before;
    }
  });

  test("an empty or whitespace override falls back rather than writing to ''", () => {
    const before = process.env.CUBES_MCP_HOME;
    try {
      process.env.CUBES_MCP_HOME = "   ";
      assert.ok(stateDir().endsWith(".cubesmcp"), "blank must not mean the filesystem root");
    } finally {
      if (before === undefined) delete process.env.CUBES_MCP_HOME;
      else process.env.CUBES_MCP_HOME = before;
    }
  });
});

describe("Rojo sourcemap", () => {
  async function withSourcemap(content) {
    const dir = await mkdtemp(join(tmpdir(), "cubes-sourcemap-"));
    const file = join(dir, "sourcemap.json");
    await writeFile(file, typeof content === "string" ? content : JSON.stringify(content));
    return { dir, file };
  }

  test("instance paths map to files, starting at the service name", async () => {
    const { dir, file } = await withSourcemap({
      name: "MyGame",
      className: "DataModel",
      children: [
        {
          name: "ServerScriptService",
          className: "ServerScriptService",
          children: [
            { name: "Main", className: "Script", filePaths: ["src/server/Main.server.luau"] },
            {
              name: "Systems",
              className: "Folder",
              children: [{ name: "Combat", className: "ModuleScript", filePaths: ["src/server/Combat.luau"] }],
            },
          ],
        },
      ],
    });
    const map = new SourceMap(file);
    assert.equal(map.loaded, true);
    assert.equal(map.lookup("ServerScriptService.Main"), join(dir, "src/server/Main.server.luau"));
    assert.equal(map.lookup("ServerScriptService.Systems.Combat"), join(dir, "src/server/Combat.luau"));
    assert.equal(map.lookup("ServerScriptService.Nope"), undefined);
  });

  test("a .meta.json sidecar never wins over the real source file", async () => {
    const { dir, file } = await withSourcemap({
      name: "g",
      className: "DataModel",
      children: [
        {
          name: "ReplicatedStorage",
          className: "ReplicatedStorage",
          children: [
            { name: "Config", className: "ModuleScript", filePaths: ["src/Config.meta.json", "src/Config.luau"] },
          ],
        },
      ],
    });
    assert.equal(new SourceMap(file).lookup("ReplicatedStorage.Config"), join(dir, "src/Config.luau"));
  });

  test("a malformed sourcemap goes inert instead of throwing", async () => {
    const { file } = await withSourcemap("{ not json at all");
    const map = new SourceMap(file);
    assert.equal(map.loaded, false);
    assert.equal(map.lookup("anything"), undefined);
  });

  test("a missing file is inert, not fatal", () => {
    const map = new SourceMap("/nonexistent/sourcemap.json");
    assert.equal(map.loaded, false);
  });

  test("a sourcemap with no scripts counts as not loaded", async () => {
    // An empty map would otherwise report `loaded` and annotate nothing, which
    // reads as "Rojo is wired up" when it is not.
    const { file } = await withSourcemap({ name: "g", className: "DataModel", children: [] });
    assert.equal(new SourceMap(file).loaded, false);
  });
});

describe("suggested next call", () => {
  test("a visual change suggests looking at it", () => {
    const next = suggestNext("mutate", {}, {
      applied: 1,
      changes: [{ op: "create", class: "Part", ref: "p1", path: "Workspace.P" }],
    });
    assert.ok(next.some((n) => n.call === "screenshot"), JSON.stringify(next));
    for (const n of next) {
      assert.ok(n.reason && n.reason.length > 5, "every suggestion has to say why");
      assert.equal(typeof n.call, "string");
    }
  });

  test("suggestions are ranked, not a bag", () => {
    const next = suggestNext("mutate", {}, {
      applied: 1,
      changes: [{ op: "create", class: "Part", ref: "p1", path: "Workspace.P" }],
    });
    assert.ok(next.length > 1, "expected several");
    assert.notDeepEqual(next[0], next[1]);
  });

  test("a failed call suggests nothing", () => {
    assert.deepEqual(suggestNext("mutate", {}, { error: "write_mode_disabled" }), []);
  });

  test("a non-object payload suggests nothing rather than throwing", () => {
    for (const payload of [null, undefined, 42, "text", []]) {
      assert.deepEqual(suggestNext("read", {}, payload), []);
    }
  });

  test("an unknown tool name suggests nothing", () => {
    assert.deepEqual(suggestNext("not_a_tool", {}, { ok: true }), []);
  });

  test("suggested args are wired to the thing that just changed", () => {
    // "one-click follow-up" rather than "name of the next tool": a suggestion
    // the agent has to re-derive arguments for is barely a suggestion.
    const next = suggestNext("mutate", {}, {
      applied: 1,
      changes: [{ op: "create", class: "Part", ref: "p7", path: "Workspace.Thing" }],
    });
    const wired = next.filter((n) => n.args && Object.keys(n.args).length > 0);
    assert.ok(wired.length > 0, `no suggestion carried arguments: ${JSON.stringify(next)}`);
    const mentions = JSON.stringify(wired);
    assert.ok(mentions.includes("p7") || mentions.includes("Workspace.Thing"));
  });
});
