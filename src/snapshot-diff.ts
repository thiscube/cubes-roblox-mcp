/**
 * Snapshot diffing — the delta engine behind the `diff` specialist tool.
 *
 * Takes two captures (see the `snapshot` tool / SessionMemory.Snapshot) and
 * produces ONLY what changed: instances added, instances removed, and per-prop
 * value changes on instances that exist in both. It never echoes a full tree —
 * that is the whole point (token-thrift; see the README "Why it's cheap").
 *
 * Instances are matched across the two captures by their full dotted path.
 */

import type { SnapshotInstance } from "./memory.js";

export interface DiffAdded {
  path: string;
  className: string;
}

export interface DiffRemoved {
  path: string;
  className: string;
}

export interface DiffChanged {
  path: string;
  /** ClassName, surfaced so a class swap at the same path is legible. */
  className: string;
  /** Only the properties whose value differs, each with its from/to value. */
  props: Record<string, { from: unknown; to: unknown }>;
}

export interface SnapshotDiff {
  added: DiffAdded[];
  removed: DiffRemoved[];
  changed: DiffChanged[];
}

/**
 * Structural equality for two projected property values.
 *
 * Property values arrive as JSON-safe envelopes from the plugin's Serialize:
 * primitives, `{__t,value}` typed values, `{__enum}` enum items, or
 * `{__ref,__path,__class}` instance pointers. Instance pointers are compared by
 * `__path` only — the `__ref` token is session-scoped and unstable, so two
 * captures of the same reference would otherwise always look "changed".
 */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;

  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;

  // Instance-valued property: identity is the path, not the volatile ref token.
  if ("__ref" in ao || "__ref" in bo) {
    return ao.__path === bo.__path && ao.__class === bo.__class;
  }

  // Arrays.
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => valuesEqual(item, b[i]));
  }

  // Plain objects (typed-value / enum envelopes, or nested maps).
  const aKeys = Object.keys(ao);
  const bKeys = Object.keys(bo);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && valuesEqual(ao[k], bo[k]));
}

/** Index a capture's instances by dotted path for O(1) cross-matching. */
function indexByPath(instances: SnapshotInstance[]): Map<string, SnapshotInstance> {
  const map = new Map<string, SnapshotInstance>();
  for (const inst of instances) {
    // First-wins on a duplicate path (Roblox allows same-named siblings, so a
    // subtree CAN collide). Deterministic and good enough — the diff is a
    // best-effort delta, not a merge.
    if (!map.has(inst.path)) map.set(inst.path, inst);
  }
  return map;
}

/**
 * Diff two captures. `from` is the baseline, `to` is the later state.
 *   - in `to` but not `from`  -> added
 *   - in `from` but not `to`  -> removed
 *   - in both, props differ   -> changed (only the differing props)
 *
 * The result carries deltas only; neither input tree is reproduced.
 */
export function diffSnapshots(
  from: SnapshotInstance[],
  to: SnapshotInstance[],
): SnapshotDiff {
  const fromIdx = indexByPath(from);
  const toIdx = indexByPath(to);

  const added: DiffAdded[] = [];
  const removed: DiffRemoved[] = [];
  const changed: DiffChanged[] = [];

  // Added + changed: walk the `to` side.
  for (const [path, toInst] of toIdx) {
    const fromInst = fromIdx.get(path);
    if (!fromInst) {
      added.push({ path, className: toInst.className });
      continue;
    }
    const props: Record<string, { from: unknown; to: unknown }> = {};
    // A ClassName change at the same path reads as a prop change so the delta
    // stays a single legible entry instead of a remove + add pair.
    if (fromInst.className !== toInst.className) {
      props.ClassName = { from: fromInst.className, to: toInst.className };
    }
    const fromProps = fromInst.props ?? {};
    const toProps = toInst.props ?? {};
    const propNames = new Set([...Object.keys(fromProps), ...Object.keys(toProps)]);
    for (const name of propNames) {
      const fv = fromProps[name];
      const tv = toProps[name];
      if (!valuesEqual(fv, tv)) {
        props[name] = { from: fv ?? null, to: tv ?? null };
      }
    }
    if (Object.keys(props).length > 0) {
      changed.push({ path, className: toInst.className, props });
    }
  }

  // Removed: paths present in `from` with no match in `to`.
  for (const [path, fromInst] of fromIdx) {
    if (!toIdx.has(path)) {
      removed.push({ path, className: fromInst.className });
    }
  }

  // Stable ordering so a re-run of the same diff is byte-identical.
  added.sort((a, b) => a.path.localeCompare(b.path));
  removed.sort((a, b) => a.path.localeCompare(b.path));
  changed.sort((a, b) => a.path.localeCompare(b.path));

  return { added, removed, changed };
}
