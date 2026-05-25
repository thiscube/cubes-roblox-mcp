/**
 * Project profile — per-place persistent memory.
 *
 * Every Roblox place gets its own JSON profile at
 * `~/.cubesmcp/profiles/{placeId}.json`. The profile is the agent's notebook
 * for THIS project: detected genre, style decisions, naming conventions,
 * decisions log, known issues, session-end summaries. Loaded on session start
 * via the `studio://project/profile` resource, written by the `profile_update`
 * tool.
 *
 * Goal: kill the cold-start problem. Session N opens with the agent already
 * knowing "this is a kawaii sim, palette is cream + brown, we use SmoothPlastic
 * everywhere, ear shape was decided as elongated balls (not WedgePart)."
 *
 * The file is local-only; the user owns it. No upload, no telemetry.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export interface ProfileDecision {
  topic: string;
  choice: string;
  at: string; // ISO timestamp
}

export interface ProfileSessionSummary {
  session: string;
  summary: string;
  at: string;
}

export interface ProjectProfile {
  placeId: number;
  placeName?: string;
  createdAt: string;
  updatedAt: string;
  /** "obby" | "simulator" | "rpg" | "racing" | "tower_defense" | "casual_sim" | "social" | "experimental" | "unknown" */
  genre?: string;
  style?: {
    palette?: string[];
    materials?: string[];
    naming?: string;
    notes?: string;
  };
  structure?: {
    modelRoot?: string;
    scriptRoot?: string;
    [key: string]: string | undefined;
  };
  decisions: ProfileDecision[];
  knownIssues: string[];
  sessionLog: ProfileSessionSummary[];
}

const PROFILE_DIR = join(homedir(), ".cubesmcp", "profiles");

function profilePath(placeId: number): string {
  return join(PROFILE_DIR, `${placeId}.json`);
}

function emptyProfile(placeId: number, placeName?: string): ProjectProfile {
  const now = new Date().toISOString();
  return {
    placeId,
    placeName,
    createdAt: now,
    updatedAt: now,
    decisions: [],
    knownIssues: [],
    sessionLog: [],
  };
}

export async function loadProfile(
  placeId: number,
  placeName?: string,
): Promise<ProjectProfile> {
  try {
    const buf = await readFile(profilePath(placeId), "utf8");
    const parsed = JSON.parse(buf) as ProjectProfile;
    // Defensive: a hand-edited or stale profile might be missing fields.
    parsed.decisions = parsed.decisions ?? [];
    parsed.knownIssues = parsed.knownIssues ?? [];
    parsed.sessionLog = parsed.sessionLog ?? [];
    if (placeName && !parsed.placeName) parsed.placeName = placeName;
    return parsed;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return emptyProfile(placeId, placeName);
    // Corrupt file — keep the corrupt file around for inspection but proceed
    // with a fresh profile so the session doesn't die over bad JSON.
    console.error(
      `[cubes-mcp] profile read failed for placeId=${placeId}: ${(err as Error).message}. Starting fresh.`,
    );
    return emptyProfile(placeId, placeName);
  }
}

export async function saveProfile(profile: ProjectProfile): Promise<void> {
  profile.updatedAt = new Date().toISOString();
  const path = profilePath(profile.placeId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(profile, null, 2), "utf8");
}

/**
 * Load → mutate via callback → save in one shot. Used by the `profile_update`
 * tool so concurrent writes serialize through the same load-mutate-save cycle.
 */
export async function updateProfile(
  placeId: number,
  fn: (p: ProjectProfile) => void,
  placeName?: string,
): Promise<ProjectProfile> {
  const profile = await loadProfile(placeId, placeName);
  fn(profile);
  await saveProfile(profile);
  return profile;
}

/**
 * Apply patch from the agent's profile_update args. Each field is treated as
 * an UPSERT — decisions append, knownIssues/sessionSummary append, structure
 * shallow-merges, style shallow-merges. Designed so the agent doesn't need to
 * read+rewrite the whole file — it just sends what it learned this turn.
 */
export interface ProfilePatch {
  genre?: string;
  placeName?: string;
  style?: ProjectProfile["style"];
  structure?: ProjectProfile["structure"];
  /** Append a decision to the log. */
  decision?: { topic: string; choice: string };
  /** Append a known issue. */
  knownIssue?: string;
  /** Append a session-end summary (auto-tagged with the session id by the caller). */
  sessionSummary?: { session: string; summary: string };
}

export function applyPatch(profile: ProjectProfile, patch: ProfilePatch): void {
  if (patch.genre !== undefined) profile.genre = patch.genre;
  if (patch.placeName !== undefined) profile.placeName = patch.placeName;
  if (patch.style) profile.style = { ...(profile.style ?? {}), ...patch.style };
  if (patch.structure) {
    profile.structure = { ...(profile.structure ?? {}), ...patch.structure };
  }
  if (patch.decision) {
    profile.decisions.push({
      topic: patch.decision.topic,
      choice: patch.decision.choice,
      at: new Date().toISOString(),
    });
  }
  if (patch.knownIssue) profile.knownIssues.push(patch.knownIssue);
  if (patch.sessionSummary) {
    profile.sessionLog.push({
      session: patch.sessionSummary.session,
      summary: patch.sessionSummary.summary,
      at: new Date().toISOString(),
    });
  }
}
