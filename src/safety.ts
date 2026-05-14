/**
 * Destructiveness classification for mutate batches.
 *
 *   none     create new things
 *   soft     modify existing properties
 *   hard     delete instances, overwrite script source
 *   nuclear  delete a service / top-level node
 *
 * `hard` and `nuclear` batches must carry `confirm: true` — the server refuses
 * them otherwise and hands back a structured `needs_confirmation` payload.
 */

export type DestructivenessLevel = "none" | "soft" | "hard" | "nuclear";

const RANK: Record<DestructivenessLevel, number> = { none: 0, soft: 1, hard: 2, nuclear: 3 };

export interface Assessment {
  level: DestructivenessLevel;
  summary: string;
  detail: string[];
}

interface Op {
  op?: string;
  target?: unknown;
  props?: Record<string, unknown>;
}

function classifyOp(op: Op): DestructivenessLevel {
  if (op.op === "create") return "none";
  if (op.op === "set") {
    return op.props && typeof op.props === "object" && "Source" in op.props ? "hard" : "soft";
  }
  if (op.op === "delete") {
    const target = String(op.target ?? "");
    // A bare capitalised identifier (no dots, no @, no ref prefix) is a service
    // or top-level node — deleting that is nuclear. Refs like "p3" won't match.
    if (/^[A-Z][A-Za-z]+$/.test(target)) return "nuclear";
    return "hard";
  }
  return "soft";
}

export function assessDestructiveness(ops: unknown[]): Assessment {
  let level: DestructivenessLevel = "none";
  const detail: string[] = [];
  let creates = 0;
  let propSets = 0;
  let scriptWrites = 0;
  let deletes = 0;
  let serviceDeletes = 0;

  for (const raw of ops) {
    if (!raw || typeof raw !== "object") continue;
    const op = raw as Op;
    const opLevel = classifyOp(op);
    if (RANK[opLevel] > RANK[level]) level = opLevel;

    if (op.op === "create") {
      creates += 1;
    } else if (op.op === "set") {
      if (opLevel === "hard") {
        scriptWrites += 1;
        detail.push(`overwrite script source on ${op.target}`);
      } else {
        propSets += 1;
      }
    } else if (op.op === "delete") {
      if (opLevel === "nuclear") {
        serviceDeletes += 1;
        detail.push(`DELETE SERVICE / TOP-LEVEL NODE: ${op.target}`);
      } else {
        deletes += 1;
        detail.push(`delete ${op.target}`);
      }
    }
  }

  const parts: string[] = [];
  if (creates) parts.push(`create ${creates}`);
  if (propSets) parts.push(`set props on ${propSets}`);
  if (scriptWrites) parts.push(`overwrite ${scriptWrites} script source(s)`);
  if (deletes) parts.push(`delete ${deletes} instance(s)`);
  if (serviceDeletes) parts.push(`delete ${serviceDeletes} service/top-level node(s)`);

  return { level, summary: parts.join(", ") || "no-op", detail };
}
