/**
 * The documentation's numbers have to be the code's numbers.
 *
 * Three separate rounds of verification caught a figure in a doc that no longer
 * matched the build — a tool count, a test count, a protocol range. Each time it
 * was corrected by hand, and each time it drifted again the next week, because
 * nothing was checking.
 *
 * So: any number a doc states about the shape of this server is asserted here
 * against the running code. If you change the code, this tells you which
 * sentence to rewrite.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ALL_TOOLS } from "../../dist/tools/index.js";
import { capabilities } from "../../dist/registry.js";
import { MAX_PROTOCOL_VERSION, MIN_PROTOCOL_VERSION } from "../../dist/protocol.js";
import "./_fixtures.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFile(join(ROOT, rel), "utf8");

const WRITE = ALL_TOOLS.filter((t) => capabilities(t).write).length;
const INSPECTOR_SAFE = ALL_TOOLS.filter((t) => capabilities(t).inspectorSafe).length;
const EXCLUDED = ALL_TOOLS.length - INSPECTOR_SAFE;

describe("documented numbers match the build", () => {
  test("SECURITY.md counts what the read-only build actually drops", async () => {
    const text = await read("SECURITY.md");
    const m = /`mutate`, `run_code` and (\d+) specialists are not registered/.exec(text);
    assert.ok(m, "SECURITY.md no longer states the count; update this test or that sentence");
    assert.equal(
      Number(m[1]),
      EXCLUDED,
      `SECURITY.md says ${m[1]} specialists are dropped; the build drops ${EXCLUDED}`,
    );
  });

  test("the configuration guide counts what survives", async () => {
    const text = await read("docs/CONFIGURATION.md");
    const m = /plus (\d+) inspector-safe specialists/.exec(text);
    assert.ok(m, "docs/CONFIGURATION.md no longer states the count");
    assert.equal(Number(m[1]), INSPECTOR_SAFE);
  });

  test("the two counts add up to the registry", () => {
    // Guards the test above from passing while both numbers are wrong.
    assert.equal(INSPECTOR_SAFE + EXCLUDED, ALL_TOOLS.length);
    assert.ok(WRITE > 0 && INSPECTOR_SAFE > 0, "a build with none of either is a bug, not a pass");
  });

  test("the plugin protocol doc states the current range", async () => {
    const text = await read("docs/PLUGIN-PROTOCOL.md");
    // Every command table row cites the protocol it arrived in; none may claim a
    // version this server does not speak.
    for (const m of text.matchAll(/\| \*{0,2}(\d+)\*{0,2} \|/g)) {
      const v = Number(m[1]);
      assert.ok(
        v >= 1 && v <= MAX_PROTOCOL_VERSION,
        `PLUGIN-PROTOCOL.md cites protocol ${v}; this server speaks ${MIN_PROTOCOL_VERSION}-${MAX_PROTOCOL_VERSION}`,
      );
    }
    assert.match(text, new RegExp(`protocol ${MAX_PROTOCOL_VERSION}`, "i"), "the newest protocol should be documented");
  });

  test("every environment variable the code reads is in the configuration guide", async () => {
    // The other direction of the same drift: a variable added to the code and
    // never written down is invisible to the person who has to set it.
    const sources = await Promise.all(
      ["src/bridge.ts", "src/docs.ts", "src/paths.ts", "src/server.ts", "src/index.ts", "src/lint.ts", "src/sourcemap.ts", "src/assets.ts"].map(read),
    );
    const used = new Set();
    for (const text of sources) {
      for (const m of text.matchAll(/process\.env\.(CUBES_MCP_[A-Z_]+)/g)) used.add(m[1]);
    }
    const guide = await read("docs/CONFIGURATION.md");
    const missing = [...used].filter((name) => !guide.includes(name));
    assert.deepEqual(missing, [], `undocumented environment variables: ${missing.join(", ")}`);
    assert.ok(used.size >= 7, `expected to find the env vars; found ${used.size}`);
  });
});
