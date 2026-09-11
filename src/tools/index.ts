import type { ToolEntry } from "../registry.js";
import { INSTANCES_TOOLS } from "./instances.js";
import { SCRIPTS_TOOLS } from "./scripts.js";
import { DEBUG_TOOLS } from "./debug.js";
import { SESSION_TOOLS } from "./session.js";
import { PLAYTEST_TOOLS } from "./playtest.js";
import { VIEWPORT_TOOLS } from "./viewport.js";
import { CAMERA_TOOLS } from "./camera.js";
import { TERRAIN_TOOLS } from "./terrain.js";
import { ANIMATION_TOOLS } from "./animation.js";
import { AUDIO_TOOLS } from "./audio.js";
import { PHYSICS_TOOLS } from "./physics.js";
import { LIGHTING_TOOLS } from "./lighting.js";
import { DOCS_TOOLS } from "./docs.js";

/**
 * Every specialist tool, assembled from the per-category files.
 *
 * Tools used to live in two files named by WAVE ("seed", "pro") rather than by
 * domain, so a 2,101-line seed.ts was the default dumping ground and nobody could
 * tell where a new tool belonged (ARCHITECTURE-REVIEW.md A6). The layout now
 * mirrors the Category union in registry.ts.
 */
export const ALL_TOOLS: ToolEntry[] = [
  ...INSTANCES_TOOLS,
  ...SCRIPTS_TOOLS,
  ...DEBUG_TOOLS,
  ...SESSION_TOOLS,
  ...PLAYTEST_TOOLS,
  ...VIEWPORT_TOOLS,
  ...CAMERA_TOOLS,
  ...TERRAIN_TOOLS,
  ...ANIMATION_TOOLS,
  ...AUDIO_TOOLS,
  ...PHYSICS_TOOLS,
  ...LIGHTING_TOOLS,
  ...DOCS_TOOLS,
];
