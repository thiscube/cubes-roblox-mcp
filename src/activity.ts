/**
 * The one-word label the Studio panel shows for what the agent is doing.
 *
 * It rides to the plugin on every command as `via.activity` (call-context.ts),
 * so the panel never guesses from the low-level command. One word, a gerund,
 * short enough for the panel's stat tile. `test/unit/activity.test.mjs` fails if
 * a tool is added without one.
 *
 * Two tools cannot be labelled by name alone and are read from their arguments:
 * `mutate` by what its ops do, `run_code` by what its Luau does.
 */

export const TOOL_ACTIVITY: Record<string, string> = {
  // core (mutate and run_code are decided from their arguments below)
  search_tools: "Searching",
  read: "Reading",
  screenshot: "Looking",

  // instances
  tags_find: "Searching",
  tags_set: "Tagging",
  instance_duplicate: "Duplicating",
  parts_grid: "Building",
  selection_set: "Selecting",
  material_paint: "Painting",
  particle_emitter_add: "Emitting",
  beam_add: "Beaming",
  workspace_configure: "Configuring",

  // scripts
  find_references: "Searching",
  script_edit: "Scripting",
  script_read: "Reading",

  // debug
  debug_highlight: "Marking",
  debug_bounds: "Measuring",
  debug_label: "Labeling",
  debug_axes: "Orienting",
  debug_clear: "Clearing",
  debug_error: "Debugging",
  breakpoint_set: "Tracing",
  breakpoint_list: "Tracing",
  breakpoint_clear: "Clearing",

  // session
  studio_instances: "Connecting",
  profile_update: "Noting",
  macro_save: "Recording",
  macro_run: "Replaying",
  history_undo: "Undoing",
  snapshot: "Capturing",
  diff: "Comparing",

  // playtest
  test_run: "Testing",
  playtest_play: "Playtesting",
  playtest_run_mode: "Running",
  playtest_stop: "Stopping",
  playtest_result: "Checking",
  playtest_set_players: "Configuring",
  playtest_status: "Checking",
  tune: "Tuning",
  character_goto: "Pathfinding",
  players_state: "Inspecting",
  character_state: "Inspecting",
  stats_snapshot: "Profiling",
  character_teleport: "Teleporting",
  character_walk: "Walking",
  character_jump: "Jumping",
  character_set: "Tuning",
  character_respawn: "Respawning",
  logs_tail: "Monitoring",
  logs_wait_for: "Waiting",
  spawn_marker: "Marking",
  event_watch: "Watching",
  event_drain: "Collecting",
  event_unwatch: "Unwatching",
  wait_until: "Waiting",
  step_frames: "Stepping",

  // viewport + camera
  viewport_capture: "Looking",
  raycast: "Raycasting",
  camera_set: "Framing",

  // terrain
  terrain_fill: "Sculpting",
  terrain_clear: "Clearing",

  // animation
  animation_play: "Animating",
  animation_stop: "Stopping",
  tween_run: "Tweening",

  // audio, physics, lighting
  sound_play: "Playing",
  collision_group_setup: "Grouping",
  constraint_add: "Rigging",
  sky_configure: "Lighting",

  // docs
  docs_class: "Researching",
  docs_member: "Researching",
  docs_enum: "Researching",
  docs_search: "Researching",
  docs_defaults: "Researching",

  // assets
  asset_search: "Browsing",
  asset_details: "Browsing",
  asset_insert: "Inserting",
  asset_upload: "Uploading",

  // perf
  perf_stats: "Profiling",
  scene_analysis: "Analyzing",
};

const SCRIPT_CLASSES = new Set(["Script", "LocalScript", "ModuleScript"]);

/** A mutate batch, by what its ops mostly do. Any script write wins outright. */
export function mutateActivity(args: unknown): string {
  const ops = (args as { ops?: unknown } | null)?.ops;
  if (!Array.isArray(ops) || ops.length === 0) return "Editing";
  let creates = 0;
  let deletes = 0;
  let sets = 0;
  let renameOnly = true;
  let tagOnly = true;
  for (const raw of ops) {
    const op = (raw ?? {}) as Record<string, any>;
    const props = op.props && typeof op.props === "object" ? (op.props as Record<string, unknown>) : undefined;
    if ((op.op === "create" && SCRIPT_CLASSES.has(op.class)) || (props && "Source" in props)) return "Scripting";
    if (op.op === "create") creates += 1;
    else if (op.op === "delete") deletes += 1;
    else if (op.op === "set") {
      sets += 1;
      const propKeys = props ? Object.keys(props) : [];
      const touchesOther = op.attrs || op.remove_attrs || propKeys.some((k) => k !== "Name");
      if (touchesOther || op.tags || op.remove_tags || propKeys.length === 0) renameOnly = false;
      if (op.attrs || op.remove_attrs || propKeys.length > 0 || !(op.tags || op.remove_tags)) tagOnly = false;
    }
  }
  const most = Math.max(creates, deletes, sets);
  if (most === 0) return "Editing";
  if (creates === most) return "Building";
  if (sets === most) return renameOnly ? "Renaming" : tagOnly ? "Tagging" : "Editing";
  return "Deleting";
}

/**
 * Arbitrary Luau, by the strongest thing it does. Checked in order, so a chunk
 * that writes a Source and also creates a Part reads as Scripting. Comments are
 * stripped first so a commented-out line does not count.
 */
export function runCodeActivity(luau: unknown): string {
  if (typeof luau !== "string" || luau.trim() === "") return "Executing";
  const code = luau.replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, "").replace(/--[^\n]*/g, "");

  if (/\.\s*Source\s*=(?!=)|UpdateSourceAsync/.test(code)) return "Scripting";
  if (/Terrain/.test(code) && /:\s*(Fill\w*|WriteVoxels|ReplaceMaterial|Clear)\s*\(/.test(code)) return "Sculpting";
  if (/TweenService|:\s*LoadAnimation\s*\(/.test(code)) return "Animating";
  if (/Instance\s*\.\s*new\s*\(|:\s*Clone\s*\(/.test(code)) return "Building";
  if (/:\s*(Destroy|ClearAllChildren)\s*\(/.test(code)) return "Deleting";
  if (/__MCP\s*\.\s*mutate\s*\(/.test(code)) return "Editing";
  if (
    /[\w\]\)]\s*\.\s*\w+\s*=(?!=)|\]\s*=(?!=)/.test(code) ||
    /:\s*(SetAttribute|AddTag|RemoveTag|PivotTo|MoveTo|ScaleTo|TranslateBy|SetPrimaryPartCFrame)\s*\(/.test(code)
  ) {
    return "Editing";
  }
  return "Reading";
}

/** The label for one MCP tool call. */
export function activityFor(tool: string, args: unknown): string {
  if (tool === "mutate") return mutateActivity(args);
  if (tool === "run_code") return runCodeActivity((args as { luau?: unknown } | null)?.luau);
  return TOOL_ACTIVITY[tool] ?? "Working";
}
