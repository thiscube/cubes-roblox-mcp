/**
 * Destructiveness classification for mutate batches.
 *
 *   none     create new things
 *   soft     modify existing properties
 *   hard     delete instances, overwrite script source, or anything unrecognised
 *   nuclear  delete a service / top-level node
 *
 * `hard` and `nuclear` batches must carry `confirm: true` — the server refuses
 * them otherwise and hands back a structured `needs_confirmation` payload.
 */

export type DestructivenessLevel = "none" | "soft" | "hard" | "nuclear";

const RANK: Record<DestructivenessLevel, number> = { none: 0, soft: 1, hard: 2, nuclear: 3 };

/** Lower-cased so the lookup is case-insensitive (`workspace` is a real alias). */
const NUCLEAR_SERVICES: ReadonlySet<string> = new Set(
  [
    "Workspace", "ServerScriptService", "ServerStorage", "ReplicatedStorage",
    "ReplicatedFirst", "StarterPlayer", "StarterGui", "StarterPack",
    "Lighting", "Players", "SoundService", "Chat", "TestService",
    "RunService", "HttpService", "DataStoreService", "MarketplaceService",
    "TeleportService", "MessagingService", "Teams", "CollectionService",
    "PhysicsService", "TweenService", "UserInputService", "ContextActionService",
  ].map((s) => s.toLowerCase()),
);

/** Op verbs this server understands. Anything else is treated as dangerous. */
const KNOWN_OPS: ReadonlySet<string> = new Set(["create", "set", "delete"]);

export interface Assessment {
  level: DestructivenessLevel;
  summary: string;
  detail: string[];
  /** True when a target could not be resolved well enough to classify precisely. */
  uncertain: boolean;
}

interface Op {
  op?: string;
  target?: unknown;
  props?: Record<string, unknown>;
}

/** A ref token minted by the plugin: p3, f12, s7. Opaque to the server. */
const REF_TOKEN = /^[a-z]+\d+$/;

/**
 * Reduce a target to the service name it would delete, or null.
 *
 * Handles the spellings the old exact-match check missed (AUDIT.md #17):
 * `game.Workspace`, `Workspace`, `workspace`, and any casing of either. A
 * multi-segment path below a service (`Workspace.Lobby`) is NOT nuclear — it
 * deletes a child, which is merely `hard`.
 */
export function serviceTargetOf(rawTarget: unknown): string | null {
  let t = String(rawTarget ?? "").trim();
  if (!t) return null;
  t = t.replace(/^game\s*[.:]\s*/i, "");
  t = t.replace(/^GetService\(["']?|["']?\)$/gi, "");
  if (t.includes(".")) return null; // a path into a service, not the service itself
  return NUCLEAR_SERVICES.has(t.toLowerCase()) ? t : null;
}

/** True when the server cannot tell what a target points at. */
function isOpaqueTarget(rawTarget: unknown): boolean {
  const t = String(rawTarget ?? "").trim();
  if (!t) return false;
  // Session ref tokens and same-batch @id references resolve plugin-side only.
  return REF_TOKEN.test(t) || t.startsWith("@");
}

function classifyOp(op: Op): { level: DestructivenessLevel; uncertain: boolean } {
  const verb = typeof op.op === "string" ? op.op : "";
  if (!KNOWN_OPS.has(verb)) {
    // Fail closed. A verb the schema doesn't list may still be understood by a
    // newer plugin, and we must not wave it through unconfirmed (AUDIT.md #16).
    return { level: "hard", uncertain: true };
  }
  if (verb === "create") return { level: "none", uncertain: false };
  if (verb === "set") {
    const writesSource =
      op.props && typeof op.props === "object" && Object.keys(op.props).some((k) => k === "Source");
    return { level: writesSource ? "hard" : "soft", uncertain: false };
  }
  // delete
  if (serviceTargetOf(op.target)) return { level: "nuclear", uncertain: false };
  // A ref or @id could BE a service; we cannot tell from here. Still `hard`
  // (so it needs confirmation either way) but the summary says so.
  return { level: "hard", uncertain: isOpaqueTarget(op.target) };
}

export function assessDestructiveness(ops: unknown[]): Assessment {
  let level: DestructivenessLevel = "none";
  let uncertain = false;
  const detail: string[] = [];
  let creates = 0;
  let propSets = 0;
  let scriptWrites = 0;
  let deletes = 0;
  let serviceDeletes = 0;
  let unknownOps = 0;

  for (const raw of ops) {
    if (!raw || typeof raw !== "object") {
      // A non-object in the ops array is malformed input, not a no-op.
      unknownOps += 1;
      if (RANK.hard > RANK[level]) level = "hard";
      uncertain = true;
      detail.push("unrecognised op entry (not an object)");
      continue;
    }
    const op = raw as Op;
    const { level: opLevel, uncertain: opUncertain } = classifyOp(op);
    if (RANK[opLevel] > RANK[level]) level = opLevel;
    if (opUncertain) uncertain = true;

    const verb = typeof op.op === "string" ? op.op : "";
    if (!KNOWN_OPS.has(verb)) {
      unknownOps += 1;
      detail.push(`unrecognised op "${verb || "(missing)"}" on ${String(op.target ?? "?")}`);
    } else if (verb === "create") {
      creates += 1;
    } else if (verb === "set") {
      if (opLevel === "hard") {
        scriptWrites += 1;
        detail.push(`overwrite script source on ${op.target}`);
      } else {
        propSets += 1;
      }
    } else if (verb === "delete") {
      const svc = serviceTargetOf(op.target);
      if (svc) {
        serviceDeletes += 1;
        detail.push(`DELETE SERVICE / TOP-LEVEL NODE: ${svc}`);
      } else {
        deletes += 1;
        detail.push(
          opUncertain
            ? `delete ${op.target} (a ref — this MIGHT be a service; the server cannot tell)`
            : `delete ${op.target}`,
        );
      }
    }
  }

  const parts: string[] = [];
  if (creates) parts.push(`create ${creates}`);
  if (propSets) parts.push(`set props on ${propSets}`);
  if (scriptWrites) parts.push(`overwrite ${scriptWrites} script source(s)`);
  if (deletes) parts.push(`delete ${deletes} instance(s)`);
  if (serviceDeletes) parts.push(`delete ${serviceDeletes} service/top-level node(s)`);
  if (unknownOps) parts.push(`${unknownOps} unrecognised op(s)`);

  return { level, summary: parts.join(", ") || "no-op", detail, uncertain };
}
