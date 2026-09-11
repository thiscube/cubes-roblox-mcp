// Run: npm run build && node test/bench/tool-churn.mjs
// How often does tools/list change over a long session?
// Every change invalidates the prompt cache for that turn, because `tools`
// renders first in the cached prefix.
import { ToolSet } from "../../dist/session.js";

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
// build actually goes (build -> test -> fix the script -> test again).
const turns = [];
const order = [0, 1, 2, 3, 4, 2, 3, 5, 6, 2, 7, 8, 4, 2, 9, 3, 0, 2, 4, 3];
for (const j of order) {
  const tools = JOBS[j];
  turns.push({ search: tools });
  turns.push({ call: tools[0] });
  turns.push({ call: tools[1] });
}

function measure(mode) {
  const set = new ToolSet();
  const grow = new Set(["search_tools", "read", "screenshot", "mutate", "run_code"]);
  let before = mode === "grow" ? [...grow].join(",") : set.visible().join(",");
  const changes = [];
  turns.forEach((t, i) => {
    const turn = i + 1;
    const names = t.search ?? [t.call];
    let now;
    if (mode === "grow") {
      for (const n of names) grow.add(n);
      now = [...grow].sort().join(",");
    } else {
      if (t.search) set.unlockAndSettle(t.search, turn);
      else { set.touch(t.call, turn); set.settle(turn); }
      now = set.visible().join(",");
    }
    if (now !== before) changes.push(turn);
    before = now;
  });
  return changes;
}

const n = turns.length;
for (const mode of ["evict", "grow"]) {
  const c = measure(mode);
  const half = Math.floor(n / 2);
  const late = c.filter((t) => t > half).length;
  console.log(
    `${mode.padEnd(6)} total ${String(c.length).padStart(2)}/${n} (${Math.round((c.length / n) * 100)}%)   ` +
      `second half ${String(late).padStart(2)}/${n - half} (${Math.round((late / (n - half)) * 100)}%)   ` +
      `last change on turn ${c[c.length - 1]}`,
  );
}
