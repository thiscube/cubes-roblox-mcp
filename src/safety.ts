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
    "TextChatService", "MaterialService", "VoiceChatService", "BadgeService",
    "GroupService", "PolicyService", "LocalizationService", "SocialService",
    "AvatarEditorService", "AssetService", "InsertService", "GamePassService",
    "ProximityPromptService", "PathfindingService", "GuiService", "TextService",
    "StarterPlayerScripts", "StarterCharacterScripts", "Debris", "Selection",
    "ChangeHistoryService", "LogService", "ScriptContext", "Stats",
    "game", "DataModel",
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
  if (t.startsWith("@")) t = t.slice(1); // `@Path` still resolves as a path plugin-side
  t = t.replace(/\s*\.\s*/g, ".").replace(/\.{2,}/g, ".").replace(/^\.+|\.+$/g, "");
  if (!t) return null;
  // `game.game.Workspace`, `DataModel.Workspace`, `game:GetService(...)`.
  while (/^(game|DataModel)\s*[.:]\s*\S/i.test(t)) t = t.replace(/^(game|DataModel)\s*[.:]\s*/i, "");
  t = t.replace(/^GetService\(["']?|["']?\)$/gi, "");
  if (t.includes(".")) return null; // a path into a service, not the service itself
  return NUCLEAR_SERVICES.has(t.toLowerCase()) ? t : null;
}

/**
 * The ids a batch's own `create` ops register. Mutate.luau's resolveTarget
 * treats `@x` as a same-batch result only when `x` is one of these; any other
 * `@x` falls through to `Refs.resolve(x)`, i.e. an ordinary path or ref.
 */
export function batchIdsOf(ops: unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const raw of ops) {
    const op = raw as { op?: unknown; id?: unknown } | null;
    if (op && typeof op === "object" && op.op === "create" && typeof op.id === "string") ids.add(op.id);
  }
  return ids;
}

/**
 * The path/ref a target resolves to outside the batch, with a leading `@`
 * stripped, or null when it names an instance this batch creates.
 */
export function externalTarget(rawTarget: unknown, batchIds: Set<string>): string | null {
  if (typeof rawTarget !== "string") return null;
  const t = rawTarget.trim();
  if (!t.startsWith("@")) return t || null;
  const key = t.slice(1);
  return batchIds.has(key) ? null : key || null;
}

/** True when the server cannot tell what a target points at. */
function isOpaqueTarget(rawTarget: unknown): boolean {
  const t = String(rawTarget ?? "").trim();
  if (!t) return false;
  // Session ref tokens and same-batch @id references resolve plugin-side only.
  return REF_TOKEN.test(t) || t.startsWith("@");
}

/** A `set` that reparents (a ref that fails to resolve assigns nil: a delete). */
function setsParent(op: Op): boolean {
  return !!op.props && typeof op.props === "object" && Object.keys(op.props).some((k) => k.toLowerCase() === "parent");
}

/** `Archivable = false` drops the instance from saves and clones. */
function clearsArchivable(op: Op): boolean {
  return !!op.props && typeof op.props === "object" &&
    Object.entries(op.props).some(([k, v]) => k.toLowerCase() === "archivable" && v !== true);
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
    return { level: writesSource || setsParent(op) || clearsArchivable(op) ? "hard" : "soft", uncertain: false };
  }
  // delete
  if (serviceTargetOf(op.target)) return { level: "nuclear", uncertain: false };
  // A ref or @id could BE a service; we cannot tell from here. Still `hard`
  // (so it needs confirmation either way) but the summary says so.
  return { level: "hard", uncertain: isOpaqueTarget(op.target) };
}

/**
 * Make model-supplied text safe to show in a confirmation prompt: no control
 * characters or newlines (which could forge extra prompt lines), and bounded.
 */
export function safeText(v: unknown, max = 120): string {
  const s = String(v ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function assessDestructiveness(ops: unknown[]): Assessment {
  let level: DestructivenessLevel = "none";
  let uncertain = false;
  const detail: string[] = [];
  let creates = 0;
  let propSets = 0;
  let scriptWrites = 0;
  let reparents = 0;
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
      detail.push(`unrecognised op "${safeText(verb || "(missing)")}" on ${safeText(op.target ?? "?")}`);
    } else if (verb === "create") {
      creates += 1;
    } else if (verb === "set") {
      if (opLevel === "hard") {
        const t = safeText(op.target);
        if (op.props && Object.keys(op.props).includes("Source")) {
          scriptWrites += 1;
          detail.push(`overwrite script source on ${t}`);
        }
        if (setsParent(op)) {
          reparents += 1;
          detail.push(`reparent ${t} (a Parent that does not resolve sets nil: this may DELETE it)`);
        }
        if (clearsArchivable(op)) {
          reparents += 1;
          detail.push(`set Archivable=false on ${t} (it will not be saved or cloned)`);
        }
      } else {
        propSets += 1;
      }
    } else if (verb === "delete") {
      const svc = serviceTargetOf(op.target);
      if (svc) {
        serviceDeletes += 1;
        detail.push(`DELETE SERVICE / TOP-LEVEL NODE: ${safeText(svc)}`);
      } else {
        deletes += 1;
        detail.push(
          opUncertain
            ? `delete ${safeText(op.target)} (a ref — this MIGHT be a service; the server cannot tell)`
            : `delete ${safeText(op.target)}`,
        );
      }
    }
  }

  const parts: string[] = [];
  if (creates) parts.push(`create ${creates}`);
  if (propSets) parts.push(`set props on ${propSets}`);
  if (scriptWrites) parts.push(`overwrite ${scriptWrites} script source(s)`);
  if (reparents) parts.push(`reparent / unarchive ${reparents} instance(s)`);
  if (deletes) parts.push(`delete ${deletes} instance(s)`);
  if (serviceDeletes) parts.push(`delete ${serviceDeletes} service/top-level node(s)`);
  if (unknownOps) parts.push(`${unknownOps} unrecognised op(s)`);

  return { level, summary: parts.join(", ") || "no-op", detail, uncertain };
}
