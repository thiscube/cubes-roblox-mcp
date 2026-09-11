/**
 * Profile persistence: concurrency, atomicity, and growth caps (AUDIT.md #11).
 * Writes go to a throwaway HOME so the developer's real ~/.cubesmcp is untouched.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let realHome;
let sandbox;
let profile;

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "cubes-profile-test-"));
  realHome = process.env.HOME;
  process.env.HOME = sandbox;
  process.env.USERPROFILE = sandbox;
  // Imported AFTER HOME is redirected: the module resolves its directory on load.
  profile = await import("../../dist/profile.js");
});

after(async () => {
  process.env.HOME = realHome;
  await rm(sandbox, { recursive: true, force: true });
});

describe("profile persistence", () => {
  test("#11 concurrent updates all survive", async () => {
    const PID = 123456;
    await profile.updateProfile(PID, (p) => {
      p.knownIssues = [];
      p.decisions = [];
    });

    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        profile.updateProfile(PID, (p) => p.knownIssues.push(`issue-${i}`)),
      ),
    );

    const final = await profile.loadProfile(PID);
    assert.equal(final.knownIssues.length, 10, `only ${final.knownIssues.length}/10 writes survived`);
    for (let i = 0; i < 10; i++) {
      assert.ok(final.knownIssues.includes(`issue-${i}`), `issue-${i} was lost`);
    }
  });

  test("#11 different places do not block each other", async () => {
    await Promise.all([
      profile.updateProfile(1, (p) => p.knownIssues.push("a")),
      profile.updateProfile(2, (p) => p.knownIssues.push("b")),
    ]);
    assert.deepEqual((await profile.loadProfile(1)).knownIssues, ["a"]);
    assert.deepEqual((await profile.loadProfile(2)).knownIssues, ["b"]);
  });

  test("#11 append-only logs are capped", async () => {
    const PID = 777;
    await profile.updateProfile(PID, (p) => {
      p.knownIssues = Array.from({ length: 500 }, (_, i) => `i${i}`);
    });
    const final = await profile.loadProfile(PID);
    assert.ok(final.knownIssues.length <= 100, `knownIssues grew to ${final.knownIssues.length}`);
    // The most recent entries are the ones kept.
    assert.equal(final.knownIssues.at(-1), "i499");
  });

  test("#11 writes are atomic — no temp files left behind", async () => {
    const PID = 888;
    await profile.updateProfile(PID, (p) => p.knownIssues.push("x"));
    const dir = join(sandbox, ".cubesmcp", "profiles");
    const files = await readdir(dir);
    assert.ok(!files.some((f) => f.endsWith(".tmp")), `temp files left: ${files.join(", ")}`);
    assert.ok(files.includes(`${PID}.json`));
  });

  test("a missing profile loads as empty rather than throwing", async () => {
    const p = await profile.loadProfile(999999);
    assert.deepEqual(p.knownIssues, []);
    assert.deepEqual(p.decisions, []);
  });
});
