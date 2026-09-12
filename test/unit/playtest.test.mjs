/**
 * Playtest tools that need more than a schema check.
 *
 * `character_goto` is the first tool here that generates Luau AND routes it to a
 * plugin command other than `eval`, so the things worth pinning are the ones a
 * schema cannot express: that it lands in the running game rather than the edit
 * place, that its yield budget actually tracks the timeout the caller asked for,
 * and that a destination string can never become source code.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { PLAYTEST_TOOLS } from "../../dist/tools/playtest.js";
import { capabilities, timeoutFor } from "../../dist/registry.js";
import { rpcReadOnlyCommands } from "../../dist/rpc-policy.js";
import "./_fixtures.mjs";

const goto = PLAYTEST_TOOLS.find((t) => t.name === "character_goto");

/** Run the tool against a bridge that records the call instead of making it. */
async function sent(args) {
  const calls = [];
  const res = await goto.handler(args, {
    bridge: {
      connected: true,
      writeEnabled: true,
      async send(cmd, payload, timeoutMs) {
        calls.push({ cmd, payload, timeoutMs });
        return {};
      },
    },
  });
  return { calls, res };
}

describe("character_goto", () => {
  test("it lands in the running game, not the edit place", async () => {
    // The whole reason this is a commandTool on `tune` rather than an evalTool:
    // eval runs in the edit DataModel, where there is no character to move.
    assert.equal(goto.pluginCommand, "tune");
    const { calls } = await sent({ to: "1,2,3" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, "tune");
  });

  test("it is write-class and stays off the read-only /rpc allowlist", () => {
    // It moves a character in the live game. Nothing about that is a read.
    assert.equal(capabilities(goto).write, true);
    assert.equal(capabilities(goto).inspectorSafe, false);
    assert.ok(
      !rpcReadOnlyCommands().includes("tune"),
      "tune must never reach the deny-by-default read allowlist",
    );
  });

  test("the yield budget tracks the timeout the caller asked for", () => {
    // A 30s walk behind a 30s transport timeout is a guaranteed false failure.
    const short = timeoutFor(goto, { to: "x", timeout: 5 });
    const long = timeoutFor(goto, { to: "x", timeout: 55 });
    assert.ok(long > short, "a longer walk must get a longer transport budget");
    assert.ok(long >= 55_000, `55s of walking needs at least 55s of budget, got ${long}`);
    // And the clamp still holds at both ends, whatever the model passes.
    assert.ok(timeoutFor(goto, { to: "x", timeout: 9e9 }) <= 120_000);
    assert.ok(timeoutFor(goto, { to: "x", timeout: -1 }) >= 30_000);
    assert.ok(timeoutFor(goto, { to: "x" }) >= 30_000, "a missing timeout must not produce NaN");
  });

  test("a missing destination is refused before the bridge is touched", async () => {
    for (const args of [{}, { to: "" }, { to: "   " }]) {
      const { calls, res } = await sent(args);
      assert.equal(res.error, "bad_args");
      assert.equal(calls.length, 0, "a refusal must not cost a Studio round trip");
    }
  });

  test("both destination forms reach the generated Luau", async () => {
    const coords = (await sent({ to: "12, 4, -30" })).calls[0].payload.luau;
    assert.match(coords, /PathfindingService/);
    assert.match(coords, /ComputeAsync/);
    // The coordinate form is parsed in Luau so the tool keeps one argument.
    assert.match(coords, /Vector3\.new/);

    const ref = (await sent({ to: "Workspace.Door" })).calls[0].payload.luau;
    assert.match(ref, /__MCP\.resolve/, "a ref or path has to go through the resolver");
  });

  test("it waits on MoveToFinished but does not trust it", async () => {
    // MoveToFinished also fires false on the engine's own 8s timeout, so the
    // loop has to be bounded by the caller's deadline as well as by the signal.
    const luau = (await sent({ to: "1,2,3", timeout: 30 })).calls[0].payload.luau;
    assert.match(luau, /MoveToFinished/);
    assert.match(luau, /os\.clock\(\)/);
    assert.match(luau, /Disconnect/, "the per-waypoint connection must be cleaned up");
  });

  test("it reports why it stopped rather than just failing", async () => {
    const luau = (await sent({ to: "1,2,3" })).calls[0].payload.luau;
    for (const outcome of ["arrived", "timeout", "blocked"]) {
      assert.ok(luau.includes(outcome), `the result should be able to say ${outcome}`);
    }
    assert.match(luau, /remaining/, "a failure has to say how far short it stopped");
  });

  test("it stops when the character dies instead of reporting a corpse", async () => {
    // A death respawns the character. Without this the loop keeps driving the
    // old humanoid and returns the dead body's distance as the answer.
    const luau = (await sent({ to: "1,2,3" })).calls[0].payload.luau;
    assert.match(luau, /hum\.Health <= 0/);
    assert.match(luau, /plr\.Character ~= char/, "a respawn swaps the model, not just the health");
    assert.match(luau, /"died"/);
  });

  test("a malformed coordinate is a structured refusal, not a thrown error", async () => {
    // The coordinate pattern accepts "1.2.3", which tonumber does not, and
    // Vector3.new(nil) would throw uncaught inside the running game.
    const luau = (await sent({ to: "1.2.3, 4, 5" })).calls[0].payload.luau;
    assert.match(luau, /bad_destination/);
    assert.match(luau, /tonumber\(x\), tonumber\(y\), tonumber\(z\)/);
  });

  test("a destination can never become source code", async () => {
    const nasty = '"] end; game:Shutdown(); --';
    const luau = (await sent({ to: nasty })).calls[0].payload.luau;
    assert.doesNotMatch(luau, /(?<!\\)"\] end/, "the destination closed its own string literal");
    assert.match(luau, /__MCP\.decode/, "arguments travel as data, not as spliced source");
  });
});
