// Run: npm run build && node test/bench/tool-churn.mjs
//
// How often does tools/list change over a long session?
//
// Every change invalidates the prompt cache for that turn, because `tools`
// renders first in the cached prefix. This compares the shipping grow-only
// ToolSet against a replica of the eviction behaviour it replaced.
import { ToolSet } from "../../dist/session.js";
import { ALL_TOOLS } from "../../dist/tools/index.js";
import { outputSchemaFor } from "../../dist/registry.js";

const CORE = ["search_tools", "read", "screenshot", "mutate", "run_code"];

/** What ToolSet used to do: idle tools age out, specialists capped at 8. */
class EvictingToolSet {
  constructor(cap = 8, idleTurns = 10) {
    this.cap = cap;
    this.idleTurns = idleTurns;
    this.active = new Set(CORE);
    this.lastUsed = new Map();
    this.lastTurn = new Map();
    this.seq = 0;
  }
  touch(tool, turn) {
    this.seq += 1;
    this.lastUsed.set(tool, this.seq);
    this.lastTurn.set(tool, turn);
  }
  unlock(names, turn) {
    for (const n of names) this.active.add(n);
    for (let i = names.length - 1; i >= 0; i -= 1) this.touch(names[i], turn);
    this.evict(turn);
  }
  settle(turn) {
    this.evict(turn);
  }
  evict(turn) {
    for (const tool of [...this.active]) {
      if (CORE.includes(tool)) continue;
      if (turn - (this.lastTurn.get(tool) ?? turn) > this.idleTurns) this.drop(tool);
    }
    const specialists = [...this.active].filter((t) => !CORE.includes(t));
    if (specialists.length > this.cap) {
      specialists
        .sort((a, b) => (this.lastUsed.get(a) ?? 0) - (this.lastUsed.get(b) ?? 0))
        .slice(0, specialists.length - this.cap)
        .forEach((t) => this.drop(t));
    }
  }
  drop(tool) {
    this.active.delete(tool);
    this.lastUsed.delete(tool);
    this.lastTurn.delete(tool);
  }
  visible() {
    return [...CORE, ...[...this.active].filter((t) => !CORE.includes(t))];
  }
}

const JOBS = [
  ["part_create", "part_resize", "part_color"],
  ["model_group", "model_pivot", "model_clone"],
  ["script_create", "script_edit", "script_find"],
  ["playtest_start", "playtest_stop", "playtest_state"],
  ["debug_error", "debug_log", "debug_watch"],
  ["light_add", "light_tune", "lighting_preset"],
  ["terrain_fill", "terrain_paint", "terrain_clear"],
  ["camera_set", "camera_orbit", "camera_frame"],
  ["anim_load", "anim_play", "anim_stop"],
  ["sound_add", "sound_play", "sound_tune"],
];

// A long session: work a job, then come back to earlier jobs, the way a real
// build actually goes (build -> test -> fix the script -> test again). The
// revisits are the point: they are where the two strategies diverge.
const turns = [];
const order = [0, 1, 2, 3, 4, 2, 3, 5, 6, 2, 7, 8, 4, 2, 9, 3, 0, 2, 4, 3];
for (const j of order) {
  const tools = JOBS[j];
  turns.push({ search: tools }, { call: tools[0] }, { call: tools[1] });
}

/**
 * Serialized chars for one tool, as tools/list would send it. The bench's
 * fictional tool names aren't in the registry, so they're charged the mean cost
 * of a real specialist — the point is the size of the prefix, not which tools.
 */
const REAL_SIZES = ALL_TOOLS.map(
  (t) =>
    JSON.stringify({
      name: t.name,
      description: `[${t.category}] ${t.description}`,
      inputSchema: t.inputSchema,
      outputSchema: outputSchemaFor(t),
    }).length,
);
const MEAN_SPECIALIST_CHARS = Math.round(REAL_SIZES.reduce((a, b) => a + b, 0) / REAL_SIZES.length);
/** The five core tools are always present. Measured from the real defs. */
const CORE_CHARS = 6_837;

const catalogChars = (visible) => CORE_CHARS + (visible.length - CORE.length) * MEAN_SPECIALIST_CHARS;

function measure(set) {
  let before = set.visible().join(",");
  const changes = [];
  const sizes = [];
  turns.forEach((t, i) => {
    const turn = i + 1;
    if (t.search) set.unlock(t.search, turn);
    else {
      set.touch(t.call, turn);
      set.settle?.(turn);
    }
    const visible = set.visible();
    const now = visible.join(",");
    if (now !== before) changes.push(turn);
    before = now;
    sizes.push(catalogChars(visible));
  });
  return { changes, meanChars: Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length) };
}

const n = turns.length;
const half = Math.floor(n / 2);
const pct = (a, b) => `${Math.round((a / b) * 100)}%`;

for (const [label, set] of [
  ["evict (old)", new EvictingToolSet()],
  ["grow (now)", new ToolSet()],
]) {
  const { changes: c, meanChars } = measure(set);
  const late = c.filter((t) => t > half).length;
  console.log(
    `${label.padEnd(12)} changed ${String(c.length).padStart(2)}/${n} (${pct(c.length, n).padStart(4)})   ` +
      `2nd half ${String(late).padStart(2)}/${n - half} (${pct(late, n - half).padStart(4)})   ` +
      `last turn ${String(c[c.length - 1] ?? "-").padStart(2)}   ` +
      `tools ${String(set.visible().length).padStart(2)}   ` +
      `mean prefix ~${meanChars.toLocaleString()} chars`,
  );
}

// Change count is only half the story, and the half that flatters grow-only.
// Grow-only also makes the cached prefix permanently bigger, so every cheap
// cache-read turn costs more. Both effects have to be priced together.
console.log(`
Fewer changes but a bigger prefix. At the usual cache pricing (write 1.25x,
read 0.1x) and H tokens of non-tool context, cost per turn is roughly

  evict:  0.33 * 1.25 * (H + Tevict) + 0.67 * 0.10 * (H + Tevict)
  grow:   0.10 * 1.25 * (H + Tgrow)  + 0.90 * 0.10 * (H + Tgrow)

which break even near H = 3k tokens. Every real session clears that on the
first turn, so grow-only wins — but it wins by less as the catalog grows,
which is what the catalog budget in test/unit/catalog-budget.test.mjs is for.`);
