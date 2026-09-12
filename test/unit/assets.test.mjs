/**
 * Creator Store assets (PLAN.md #7).
 *
 * Network is stubbed throughout — a unit test that only passes when Roblox's
 * endpoints are up is not a unit test. What is worth testing here is the safety
 * of `asset_insert` (an arbitrary stranger's model is about to enter the place)
 * and the gate on `asset_upload` (it publishes to the user's account, which
 * nothing here can undo).
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { ASSETS_TOOLS } from "../../dist/tools/assets.js";
import { __setAssetFetchForTest, ASSET_TYPES } from "../../dist/assets.js";
import { capabilities } from "../../dist/registry.js";
import "./_fixtures.mjs";

const tool = (name) => ASSETS_TOOLS.find((t) => t.name === name);

/** One asset as the toolbox details endpoint really shapes it. */
const detailEntry = (id, over = {}) => ({
  asset: {
    id,
    name: `asset ${id}`,
    typeId: 10,
    description: "x".repeat(400),
    hasScripts: false,
    isEndorsed: true,
    createdUtc: "2023-12-29T21:04:44.913Z",
    modelTechnicalDetails: { objectMeshSummary: { triangles: 6782, vertices: 6096 } },
    ...over.asset,
  },
  creator: { id: 1, name: "Grant_2003", isVerifiedCreator: true, ...over.creator },
  voting: { upVotePercent: 96, voteCount: 800, ...over.voting },
});

function stubNetwork(routes) {
  const calls = [];
  __setAssetFetchForTest(async (url) => {
    calls.push(url);
    for (const [match, body] of routes) {
      if (url.includes(match)) {
        return { ok: true, status: 200, json: async () => body };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  return calls;
}

describe("asset search and details", () => {
  afterEach(() => __setAssetFetchForTest(null));

  test("search turns bare ids into something a model can choose between", async () => {
    const calls = stubNetwork([
      ["marketplace/10", { totalResults: 311, nextPageCursor: "abc", data: [{ id: 11 }, { id: 22 }] }],
      ["items/details", { data: [detailEntry(11), detailEntry(22)] }],
    ]);
    const res = await tool("asset_search").handler({ query: "oak tree", limit: 2 }, {});

    // The marketplace endpoint returns ids only; the second call is what makes
    // the result useful at all.
    assert.equal(calls.length, 2);
    assert.match(calls[0], /marketplace\/10\?limit=2&keyword=oak\+tree/);
    assert.match(calls[1], /items\/details\?assetIds=11,22/);

    assert.equal(res.total, 311);
    assert.equal(res.cursor, "abc");
    assert.deepEqual(
      res.assets.map((a) => [a.id, a.name, a.creator, a.triangles, a.hasScripts, a.endorsed]),
      [
        [11, "asset 11", "Grant_2003", 6782, false, true],
        [22, "asset 22", "Grant_2003", 6782, false, true],
      ],
    );
    assert.ok(res.assets[0].description.length <= 160, "descriptions are capped, not dumped");
  });

  test("assetType picks the right marketplace category", async () => {
    const calls = stubNetwork([["marketplace/", { data: [] }]]);
    await tool("asset_search").handler({ query: "beep", assetType: "audio" }, {});
    assert.match(calls[0], new RegExp(`marketplace/${ASSET_TYPES.audio}\\?`));
  });

  test("limit is clamped rather than passed through", async () => {
    const calls = stubNetwork([["marketplace/", { data: [] }]]);
    await tool("asset_search").handler({ query: "x", limit: 5000 }, {});
    assert.match(calls[0], /limit=30/);
  });

  test("no results is an answer, not an error", async () => {
    stubNetwork([["marketplace/", { totalResults: 0, data: [] }]]);
    const res = await tool("asset_search").handler({ query: "asdkjhasd" }, {});
    assert.deepEqual(res.assets, []);
    assert.match(res.hint, /Try fewer words/);
  });

  test("a failing endpoint explains itself instead of throwing", async () => {
    __setAssetFetchForTest(async () => ({ ok: false, status: 429, json: async () => ({}) }));
    const res = await tool("asset_search").handler({ query: "tree" }, {});
    assert.equal(res.error, "asset_lookup_failed");
    assert.match(res.message, /429/);
    assert.match(res.hint, /rate-limited/);
  });

  test("ids that do not resolve are reported, not silently dropped", async () => {
    stubNetwork([["items/details", { data: [detailEntry(11)] }]]);
    const res = await tool("asset_details").handler({ assetIds: [11, 404404] }, {});
    assert.deepEqual(res.assets.map((a) => a.id), [11]);
    assert.deepEqual(res.not_found, [404404]);
  });

  test("thumbnails are opt-in, because they cost a second request", async () => {
    const calls = stubNetwork([
      ["items/details", { data: [detailEntry(11)] }],
      ["thumbnails", { data: [{ targetId: 11, state: "Completed", imageUrl: "https://x/y.png" }] }],
    ]);
    await tool("asset_details").handler({ assetIds: [11] }, {});
    assert.equal(calls.length, 1);

    const res = await tool("asset_details").handler({ assetIds: [11], thumbnails: true }, {});
    assert.deepEqual(res.thumbnails, [{ id: 11, url: "https://x/y.png" }]);
  });

  test("garbage ids are refused before any request", async () => {
    const calls = stubNetwork([]);
    const res = await tool("asset_details").handler({ assetIds: ["nope", -1, 0] }, {});
    assert.equal(res.error, "bad_args");
    assert.deepEqual(calls, []);
  });

  test("offline refuses rather than reaching out", async () => {
    __setAssetFetchForTest(null);
    const before = process.env.CUBES_MCP_OFFLINE;
    process.env.CUBES_MCP_OFFLINE = "1";
    try {
      const res = await tool("asset_search").handler({ query: "tree" }, {});
      assert.equal(res.error, "asset_lookup_failed");
      assert.match(res.hint, /CUBES_MCP_OFFLINE/);
    } finally {
      if (before === undefined) delete process.env.CUBES_MCP_OFFLINE;
      else process.env.CUBES_MCP_OFFLINE = before;
    }
  });
});

describe("asset_insert safety", () => {
  const luauFor = (args) => {
    const entry = tool("asset_insert");
    // evalTool builders may be async; this one is not, but await covers both.
    return entry.handler(args, {
      bridge: {
        connected: true,
        writeEnabled: true,
        async send(_t, a) {
          return { luau: a.luau };
        },
      },
    });
  };

  test("it is write-class, because it puts a stranger's model in your place", () => {
    assert.equal(tool("asset_insert").channel, "eval");
    assert.equal(capabilities(tool("asset_insert")).write, true);
  });

  test("scripts are stripped BEFORE parenting, and the strip is verified", async () => {
    const { result } = await luauFor({ assetId: 123 });
    const luau = result.luau;
    const stripAt = luau.indexOf("LuaSourceContainer");
    const parentAt = luau.indexOf("child.Parent = parent");
    assert.ok(stripAt > 0 && parentAt > 0);
    assert.ok(stripAt < parentAt, "stripping must happen before anything is parented");
    // A pcall'd Destroy that silently failed would otherwise ship a live script
    // into the place under a "stripped" label.
    assert.match(luau, /strip_failed/);
    assert.match(luau, /PackageLink/);
  });

  test("a failed strip destroys the model rather than parenting it", async () => {
    const { result } = await luauFor({ assetId: 123 });
    const failure = result.luau.slice(result.luau.indexOf("strip_failed") - 200, result.luau.indexOf("strip_failed") + 120);
    assert.match(failure, /container:Destroy\(\)/);
    assert.match(failure, /Nothing was inserted/);
  });

  test("the whole insert is one undo waypoint, cancelled on failure", async () => {
    const { result } = await luauFor({ assetId: 123 });
    assert.match(result.luau, /ChangeHistoryService/);
    assert.match(result.luau, /insert_failed/);
  });

  test("the asset id reaches Luau as data, never as spliced source", async () => {
    const { result } = await luauFor({ assetId: 1, name: 'x"] end; game:Shutdown(); --' });
    const literal = /__MCP\.decode\((".*?")\)\n/s.exec(result.luau);
    assert.ok(literal, "expected one quoted literal");
    // Decoding it the way Lua would must give the original back, byte for byte,
    // with the string never closed early.
    const decoded = luaUnescape(literal[1].slice(1, -1));
    assert.equal(JSON.parse(decoded).name, 'x"] end; game:Shutdown(); --');
  });
});

describe("asset_upload gate", () => {
  beforeEach(() => {
    process.env.CUBES_MCP_OPEN_CLOUD_KEY = "test-key";
  });
  afterEach(() => {
    delete process.env.CUBES_MCP_OPEN_CLOUD_KEY;
  });

  const upload = (args, ctx = {}) => tool("asset_upload").handler(args, ctx);
  const inProject = "test/fixtures/model.rbxm";

  test("no key is a clear refusal, not a failed request", async () => {
    delete process.env.CUBES_MCP_OPEN_CLOUD_KEY;
    const res = await upload({ filePath: inProject, assetType: "Model", name: "x" });
    assert.equal(res.error, "no_open_cloud_key");
  });

  test("a file outside the project is refused, whatever else the call says", async () => {
    // This is the finding that made the rest of the gate beside the point:
    // filePath went straight to readFile, so an absolute path to an SSH key was
    // uploaded to Roblox as a "Model" and the tool reported success.
    for (const bad of ["/root/.ssh/id_rsa", "/etc/passwd", "../../../etc/shadow", "~/.aws/credentials"]) {
      const res = await upload(
        { filePath: bad, assetType: "Model", name: "totally-a-model", confirm: true },
        { confirmWithUser: async () => true },
      );
      assert.equal(res.error, "path_not_allowed", `${bad} was not refused`);
      assert.match(res.message, /only files under|expected one of/);
    }
  });

  test("a file inside the project but of the wrong kind is refused too", async () => {
    // An extension check is weak on its own, but combined with confinement it
    // stops the obvious "upload the source tree as a Model" shape.
    for (const bad of ["package.json", "src/server.ts", "dist/index.js", ".env"]) {
      const res = await upload(
        { filePath: bad, assetType: "Model", name: "x", confirm: true },
        { confirmWithUser: async () => true },
      );
      assert.equal(res.error, "path_not_allowed", `${bad} was not refused`);
    }
  });

  test("the path is checked BEFORE anyone is asked anything", async () => {
    // Otherwise the human gets prompted about a file that was never going to be
    // allowed, which trains them to click through the prompt.
    let asked = false;
    const res = await upload(
      { filePath: "/etc/passwd", assetType: "Model", name: "x" },
      { confirmWithUser: async () => { asked = true; return true; } },
    );
    assert.equal(res.error, "path_not_allowed");
    assert.equal(asked, false);
  });

  test("confirm: true does NOT skip the human when the client can be asked", async () => {
    // The model supplies `confirm`, so treating it as consent makes the gate a
    // suggestion to an LLM — the exact thing this project criticises the
    // competition for. It is the fallback for a client that cannot prompt, not
    // a way around one that can.
    let asked = 0;
    const res = await upload(
      { filePath: inProject, assetType: "Model", name: "Tree", confirm: true },
      { confirmWithUser: async () => { asked += 1; return false; } },
    );
    assert.equal(asked, 1, "the human must still be asked");
    assert.equal(res.error, "declined_by_user");
  });

  test("a decline is final, and says so", async () => {
    const res = await upload(
      { filePath: inProject, assetType: "Model", name: "Tree" },
      { confirmWithUser: async () => false },
    );
    assert.equal(res.error, "declined_by_user");
    assert.match(res.hint, /without new instructions/);
  });

  test("a client that cannot ask falls back to confirm, with the exact retry", async () => {
    const noPrompt = await upload({ filePath: inProject, assetType: "Model", name: "x" }, {});
    assert.equal(noPrompt.error, "needs_confirmation");
    assert.equal(noPrompt.retry_with.confirm, true);
    assert.match(noPrompt.hint, /cannot show a prompt/);
  });

  test("it is not in the read-only build, because it sends bytes off the machine", async () => {
    const entry = tool("asset_upload");
    const cap = capabilities(entry);
    assert.equal(cap.network, "write");
    assert.equal(cap.inspectorSafe, false, "an inspector build must not be able to upload");
    // Reading is fine in that build; sending is not.
    assert.equal(capabilities(tool("asset_search")).inspectorSafe, true);
    assert.equal(capabilities(tool("asset_details")).inspectorSafe, true);
  });
});

/** Undo luaStringLiteral: `\ddd` decimal escapes, plus escaped quote and backslash. */
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
