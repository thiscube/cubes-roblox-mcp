/**
 * Unit tests for the modules that need no Studio, no port, and no plugin.
 *
 * Before the transport seam existed, none of this was testable — exercising any
 * part of the server meant binding 127.0.0.1 and writing a fake plugin that spoke
 * the long-poll protocol. These are the regression tests for the defects that
 * shipped because nothing could check them (AUDIT.md #21).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { assessDestructiveness, serviceTargetOf } from "../../dist/safety.js";
import { luaJson, luaStringLiteral, capabilities, timeoutFor } from "../../dist/registry.js";
import { ToolSet, SPECIALIST_CAP } from "../../dist/session.js";
import { validateArgs } from "../../dist/validate.js";
import { diffSnapshots } from "../../dist/snapshot-diff.js";
import { truncateArgs } from "../../dist/memory.js";
import { px, resolveInsets } from "../../dist/vision.js";

const ch = (n) => String.fromCharCode(n);

/**
 * Parse a Luau double-quoted literal the way Luau does, into BYTES.
 * Lua strings are byte strings, so \\ddd escapes are single bytes that reassemble
 * into UTF-8 — decoding per-character would corrupt anything non-ASCII.
 */
function luaUnescapeBytes(lit) {
  const body = lit.slice(1, -1);
  const out = [];
  let i = 0;
  while (i < body.length) {
    if (body[i] !== "\\") {
      out.push(body.charCodeAt(i));
      i += 1;
      continue;
    }
    const n = body[i + 1];
    if (n === "\\") { out.push(92); i += 2; }
    else if (n === '"') { out.push(34); i += 2; }
    else if (/[0-9]/.test(n)) {
      const m = body.slice(i + 1).match(/^[0-9]{1,3}/)[0];
      out.push(parseInt(m, 10));
      i += 1 + m.length;
    } else {
      throw new Error(`invalid Luau escape \\${n} in ${lit}`);
    }
  }
  return Buffer.from(out);
}

// ---------------------------------------------------------------- safety #16 #17

describe("safety: destructiveness classification", () => {
  test("#16 unknown op verbs fail closed, not open", () => {
    const a = assessDestructiveness([{ op: "reparent", target: "Workspace" }]);
    assert.equal(a.level, "hard", "an unrecognised verb must require confirmation");
    assert.equal(a.uncertain, true);
  });

  test("#16 a malformed entry is not silently skipped", () => {
    const a = assessDestructiveness(["not an object"]);
    assert.equal(a.level, "hard");
  });

  test("#17 service deletes are detected across spellings", () => {
    for (const target of ["Workspace", "game.Workspace", "workspace", "GAME.Lighting", "game:GetService('Players')"]) {
      const a = assessDestructiveness([{ op: "delete", target }]);
      assert.equal(a.level, "nuclear", `${target} should be nuclear`);
    }
  });

  test("#17 a child of a service is hard, not nuclear", () => {
    const a = assessDestructiveness([{ op: "delete", target: "Workspace.Lobby" }]);
    assert.equal(a.level, "hard");
  });

  test("#17 an opaque ref is hard and flagged uncertain", () => {
    const a = assessDestructiveness([{ op: "delete", target: "p3" }]);
    assert.equal(a.level, "hard");
    assert.equal(a.uncertain, true);
    assert.match(a.detail.join(" "), /MIGHT be a service/);
  });

  test("ordinary work stays ungated", () => {
    assert.equal(assessDestructiveness([{ op: "create", class: "Part" }]).level, "none");
    assert.equal(assessDestructiveness([{ op: "set", target: "x", props: { Anchored: true } }]).level, "soft");
  });

  test("writing Source is hard", () => {
    assert.equal(assessDestructiveness([{ op: "set", target: "x", props: { Source: "print(1)" } }]).level, "hard");
  });

  test("serviceTargetOf ignores non-services", () => {
    assert.equal(serviceTargetOf("MyFolder"), null);
    assert.equal(serviceTargetOf("Workspace.Thing"), null);
  });
});

// ---------------------------------------------------------------- luaJson #12

describe("luaJson: Luau-safe encoding", () => {
  // NOTE: AUDIT.md #12 claimed a \\uXXXX escape here broke Luau parsing. That was a
  // FALSE POSITIVE — the escape is always preceded by a doubled backslash, which
  // Lua reads as a literal backslash, leaving valid JSON for JSONDecode. What
  // actually matters is the round trip, so that is what we assert.
  test("#12 every input round-trips through Lua unescaping and JSONDecode", () => {
    const cases = [
      { s: "hello" },
      { s: `a${ch(7)}b` },
      { s: `a${ch(0)}b` },
      { s: `a${ch(11)}b` },
      { s: "héllo 🎮" },
      { s: 'say "hi"' },
      { s: "C:\\path" },
    ];
    for (const v of cases) {
      const decoded = JSON.parse(luaUnescapeBytes(luaJson(v)).toString("utf8"));
      assert.equal(decoded.s, v.s, `failed to round-trip ${JSON.stringify(v.s)}`);
    }
  });

  test("#12 decimal escapes are zero-padded so the lexer can't swallow a digit", () => {
    const lit = luaStringLiteral(`${ch(9)}9`);
    assert.ok(lit.includes("\\009"), `expected padded escape, got ${lit}`);
  });

  test("stays injection-safe: quotes and backslashes are escaped", () => {
    const lit = luaStringLiteral('he said "hi" \\ bye');
    assert.equal(lit.startsWith('"'), true);
    assert.equal(lit.endsWith('"'), true);
    // No unescaped quote may appear inside the literal body.
    const body = lit.slice(1, -1);
    assert.ok(!/(^|[^\\])"/.test(body), `unescaped quote leaked: ${lit}`);
  });

  test("round-trips UTF-8 byte-exactly", () => {
    const lit = luaStringLiteral("héllo 🎮");
    const bytes = Buffer.from("héllo 🎮", "utf8");
    // every non-ASCII byte should appear as a \ddd escape
    for (const b of bytes) {
      if (b > 0x7e) assert.ok(lit.includes("\\" + String(b).padStart(3, "0")), `missing byte ${b}`);
    }
  });
});

// ---------------------------------------------------------------- capability A2 #2

describe("capability derivation", () => {
  test("#2 an eval-channel tool is write-class by default", () => {
    assert.equal(capabilities({ channel: "eval" }).write, true);
  });

  test("#2 opting out is explicit and honoured", () => {
    assert.equal(capabilities({ channel: "eval", readOnly: true }).write, false);
  });

  test("mutate and dispatch channels are always write-class unless opted out", () => {
    assert.equal(capabilities({ channel: "mutate" }).write, true);
    assert.equal(capabilities({ channel: "dispatch" }).write, true);
  });

  test("server-local tools never touch Studio", () => {
    const cap = capabilities({ channel: "local" });
    assert.equal(cap.write, false);
    assert.equal(cap.touchesStudio, false);
  });

  test("#22 yield budget widens the transport timeout", () => {
    assert.equal(timeoutFor({}, {}), 30_000);
    const entry = { yieldBudgetMs: (a) => Math.min(a.timeout ?? 5, 25) * 1000 };
    assert.equal(timeoutFor(entry, { timeout: 25 }), 35_000);
    assert.ok(timeoutFor(entry, { timeout: 1 }) >= 30_000, "never shortens below the default");
  });
});

// ---------------------------------------------------------------- ToolSet #8 A4

describe("ToolSet: unlock and eviction", () => {
  test("#8 never reports a tool it evicted in the same turn", () => {
    const ts = new ToolSet();
    const names = Array.from({ length: 12 }, (_, i) => `tool_${i}`);
    const res = ts.unlockAndSettle(names, 1);
    const visible = new Set(res.visible);
    for (const n of res.unlocked) {
      assert.ok(visible.has(n), `${n} was reported unlocked but is not visible`);
    }
    assert.equal(res.unlocked.length, SPECIALIST_CAP);
  });

  test("#8 keeps the highest-ranked matches, not the lowest", () => {
    const ts = new ToolSet();
    // Ranked order: best first. The cap must drop from the tail.
    const ranked = Array.from({ length: 12 }, (_, i) => `rank_${i}`);
    const res = ts.unlockAndSettle(ranked, 1);
    assert.ok(res.unlocked.includes("rank_0"), "the top-ranked match must survive");
    assert.ok(!res.visible.includes("rank_11"), "the worst match should be the one dropped");
  });

  test("core tools are never evicted", () => {
    const ts = new ToolSet();
    ts.unlockAndSettle(Array.from({ length: 30 }, (_, i) => `t${i}`), 1);
    for (const core of ["search_tools", "read", "screenshot", "mutate", "run_code"]) {
      assert.ok(ts.visible().includes(core), `${core} disappeared`);
    }
  });

  test("idle specialists are dropped after enough turns", () => {
    const ts = new ToolSet();
    ts.unlockAndSettle(["lonely"], 1);
    assert.ok(ts.has("lonely"));
    ts.settle(100);
    assert.ok(!ts.has("lonely"), "an idle specialist should age out");
  });

  test("recently used specialists survive a later settle", () => {
    const ts = new ToolSet();
    ts.unlockAndSettle(["keeper"], 1);
    ts.touch("keeper", 9);
    ts.settle(10);
    assert.ok(ts.has("keeper"));
  });
});

// ---------------------------------------------------------------- validate #3 #14

describe("argument validation", () => {
  test("#3 a string where a number is declared is rejected", () => {
    const schema = { type: "object", properties: { top: { type: "number" } } };
    const errs = validateArgs({ top: "0; Start-Process calc.exe" }, schema);
    assert.equal(errs.length, 1);
    assert.match(errs[0].message, /expected number/);
  });

  test("#3 nested objects are validated", () => {
    const schema = {
      type: "object",
      properties: { insets: { type: "object", properties: { top: { type: "number" } } } },
    };
    const errs = validateArgs({ insets: { top: "evil" } }, schema);
    assert.equal(errs.length, 1);
    assert.equal(errs[0].path, "insets.top");
  });

  test("required fields are enforced", () => {
    const errs = validateArgs({}, { type: "object", required: ["query"] });
    assert.equal(errs.length, 1);
    assert.match(errs[0].message, /required/);
  });

  test("enum membership is enforced", () => {
    const schema = { type: "object", properties: { region: { enum: ["full", "viewport"] } } };
    assert.equal(validateArgs({ region: "viewport" }, schema).length, 0);
    assert.equal(validateArgs({ region: "nope" }, schema).length, 1);
  });

  test("#14 min/max bounds are enforced", () => {
    const schema = { type: "object", properties: { count: { type: "number", minimum: 1, maximum: 250 } } };
    assert.equal(validateArgs({ count: 1e9 }, schema).length, 1);
    assert.equal(validateArgs({ count: 10 }, schema).length, 0);
  });

  test("oneOf accepts either branch", () => {
    const schema = {
      type: "object",
      properties: { select: { oneOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] } },
    };
    assert.equal(validateArgs({ select: "*" }, schema).length, 0);
    assert.equal(validateArgs({ select: ["a"] }, schema).length, 0);
    assert.equal(validateArgs({ select: 5 }, schema).length, 1);
  });

  test("array items are validated", () => {
    const schema = { type: "object", properties: { xs: { type: "array", items: { type: "number" } } } };
    assert.equal(validateArgs({ xs: [1, "two"] }, schema).length, 1);
  });

  test("valid arguments produce no errors", () => {
    const schema = { type: "object", properties: { q: { type: "string" } }, required: ["q"] };
    assert.deepEqual(validateArgs({ q: "hello" }, schema), []);
  });
});

// ---------------------------------------------------------------- snapshot diff

describe("snapshot diff", () => {
  const inst = (path, className, props = {}) => ({ path, className, props });

  test("reports only what changed", () => {
    const from = [inst("a", "Part", { Anchored: true }), inst("b", "Part", {})];
    const to = [inst("a", "Part", { Anchored: false }), inst("c", "Part", {})];
    const d = diffSnapshots(from, to);
    assert.deepEqual(d.added.map((x) => x.path), ["c"]);
    assert.deepEqual(d.removed.map((x) => x.path), ["b"]);
    assert.deepEqual(d.changed.map((x) => x.path), ["a"]);
    assert.deepEqual(d.changed[0].props.Anchored, { from: true, to: false });
  });

  test("instance-valued props compare by path, not volatile ref", () => {
    const from = [inst("a", "Weld", { Part0: { __ref: "p1", __path: "W.X", __class: "Part" } })];
    const to = [inst("a", "Weld", { Part0: { __ref: "p99", __path: "W.X", __class: "Part" } })];
    assert.equal(diffSnapshots(from, to).changed.length, 0);
  });

  test("a class swap at the same path reads as one change", () => {
    const d = diffSnapshots([inst("a", "Part")], [inst("a", "WedgePart")]);
    assert.equal(d.changed.length, 1);
    assert.deepEqual(d.changed[0].props.ClassName, { from: "Part", to: "WedgePart" });
  });
});

// ---------------------------------------------------------------- memory #26

describe("history argument capping", () => {
  test("#26 a huge script source is truncated, not stored whole", () => {
    const big = "x".repeat(200_000);
    const out = truncateArgs({ ops: [{ op: "set", props: { Source: big } }] });
    const size = Buffer.byteLength(JSON.stringify(out), "utf8");
    assert.ok(size < 16_000, `still ${size} bytes after truncation`);
  });

  test("ordinary args pass through untouched", () => {
    const args = { ops: [{ op: "create", class: "Part" }] };
    assert.deepEqual(truncateArgs(args), args);
  });
});

// ---------------------------------------------------------------- vision #3 #15

describe("screenshot inset coercion", () => {
  test("#3 a shell payload is coerced to a number", () => {
    assert.equal(px("0\n Start-Process calc.exe", 110), 110);
    assert.equal(px("12", 0), 12);
    assert.equal(px(undefined, 7), 7);
    assert.equal(px(NaN, 7), 7);
  });

  test("#3 values are clamped and integral", () => {
    assert.equal(px(-50, 0), 0);
    assert.equal(px(99999, 0), 4096);
    assert.equal(px(12.9, 0), 12);
  });

  test("#15 viewport is the default crop, not the whole monitor", () => {
    const i = resolveInsets("viewport", undefined);
    assert.ok(i.top > 0 && i.right > 0, "viewport should crop Studio chrome");
    const full = resolveInsets("full", undefined);
    assert.deepEqual(full, { top: 0, right: 0, bottom: 0, left: 0 });
  });

  test("caller overrides survive when they are real numbers", () => {
    assert.equal(resolveInsets("viewport", { top: 5 }).top, 5);
  });
});
