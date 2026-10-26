/**
 * Every version of every script the server writes, kept on disk.
 *
 * Code in these places lives in Studio, not in a repo, so the only undo was
 * Studio's own history, which is gone the moment Studio closes. This keeps a
 * copy of a script's source before each edit or delete and after each write,
 * under CUBES_MCP_HOME/history/<place>/:
 *
 *   index.jsonl         one line per version, oldest first
 *   blobs/<sha1>.luau   the source, stored once however many versions share it
 *
 * Content-addressed so an unchanged script costs one index line, not a copy.
 * Append-only so two sessions writing at once cannot corrupt each other's lines.
 *
 * Only writes that go through `handleMutate` are recorded. `run_code` edits
 * Source through arbitrary Luau the server cannot see into, so it is not.
 */

import { createHash } from "node:crypto";
import { appendFile, mkdir, open, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stateDir } from "./paths.js";

export type HistoryAction = "before-edit" | "after-edit" | "before-delete" | "created";

export interface HistoryEntry {
  at: string;
  /** Dotted path as `GetFullName()` reported it at the time. */
  path: string;
  class: string;
  action: HistoryAction;
  hash: string;
  lines: number;
  /** The MCP tool whose call produced this version. */
  tool?: string;
}

export interface NewVersion {
  path: string;
  class: string;
  action: HistoryAction;
  source: string;
}

/** `place-123` for a published place, `unsaved-<name>` for one without an id. */
export function placeKeyOf(placeId: number, placeName: string): string {
  if (placeId > 0) return `place-${placeId}`;
  const name = placeName.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 60) || "untitled";
  return `unsaved-${name}`;
}

export function historyRoot(): string {
  return join(stateDir(), "history");
}

function placeDir(placeKey: string): string {
  return join(historyRoot(), placeKey);
}

function hashOf(source: string): string {
  return createHash("sha1").update(source, "utf8").digest("hex");
}

function lineCount(source: string): number {
  return source === "" ? 0 : source.split("\n").length;
}

export async function readIndex(placeKey: string): Promise<HistoryEntry[]> {
  let raw: string;
  try {
    raw = await readFile(join(placeDir(placeKey), "index.jsonl"), "utf8");
  } catch {
    return [];
  }
  const out: HistoryEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as HistoryEntry);
    } catch {
      // A torn line from a crash mid-append. Skip it rather than lose the rest.
    }
  }
  return out;
}

export async function readBlob(placeKey: string, hash: string): Promise<string | null> {
  try {
    return await readFile(join(placeDir(placeKey), "blobs", `${hash}.luau`), "utf8");
  } catch {
    return null;
  }
}

/**
 * Record versions. A version identical to the newest one already held for that
 * path is skipped, so "after this edit" and "before the next one" collapse into
 * one entry whenever nothing touched the script in between. A delete is always
 * recorded, because the fact that the script went away is the point.
 */
export async function recordVersions(
  placeKey: string,
  versions: NewVersion[],
  tool?: string,
): Promise<number> {
  if (versions.length === 0) return 0;
  const dir = placeDir(placeKey);
  await mkdir(join(dir, "blobs"), { recursive: true });
  const cache = await syncCache(dir);
  const latest = cache.latest;

  const lines: string[] = [];
  for (const v of versions) {
    const hash = hashOf(v.source);
    if (latest.get(v.path) === hash && v.action !== "before-delete") continue;
    latest.set(v.path, hash);
    const blob = join(dir, "blobs", `${hash}.luau`);
    let ok = cache.blobs.has(hash);
    if (!ok) {
      try {
        ok = hashOf(await readFile(blob, "utf8")) === hash;
      } catch {
        // Missing: write it below.
      }
    }
    if (!ok) {
      // Temp then rename, so a crash mid-write never leaves a truncated blob under the real name.
      const tmp = `${blob}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, v.source, "utf8");
      await rename(tmp, blob);
    }
    cache.blobs.add(hash);
    const entry: HistoryEntry = {
      at: new Date().toISOString(),
      path: v.path,
      class: v.class,
      action: v.action,
      hash,
      lines: lineCount(v.source),
      ...(tool ? { tool } : {}),
    };
    lines.push(JSON.stringify(entry));
  }
  if (lines.length > 0) await appendFile(join(dir, "index.jsonl"), lines.join("\n") + "\n", "utf8");
  return lines.length;
}

/**
 * Newest hash per path, kept in memory per place directory so a write does not
 * re-read the whole index. Synced by byte offset: lines appended since (by this
 * process or another session) are read and folded in; a file that shrank was
 * replaced, so it is read again from the start. Blobs already verified are
 * remembered so they are not re-read and re-hashed on every write.
 */
interface IndexCache {
  offset: number;
  latest: Map<string, string>;
  blobs: Set<string>;
}
const caches = new Map<string, IndexCache>();

async function syncCache(dir: string): Promise<IndexCache> {
  const file = join(dir, "index.jsonl");
  let size = 0;
  try {
    size = (await stat(file)).size;
  } catch {
    // No index yet.
  }
  let cache = caches.get(dir);
  if (!cache || size < cache.offset) {
    cache = { offset: 0, latest: new Map(), blobs: cache?.blobs ?? new Set() };
    caches.set(dir, cache);
  }
  if (size > cache.offset) {
    const buf = Buffer.alloc(size - cache.offset);
    const fh = await open(file, "r");
    try {
      await fh.read(buf, 0, buf.length, cache.offset);
    } finally {
      await fh.close();
    }
    // Whole lines only; a torn tail is picked up by the next sync once completed.
    const end = buf.lastIndexOf(0x0a) + 1;
    for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as HistoryEntry;
        cache.latest.set(e.path, e.hash);
      } catch {
        // A torn line from a crash mid-append, as in readIndex.
      }
    }
    cache.offset += end;
  }
  return cache;
}

/** The place whose history was written most recently, for when Studio is not reachable. */
export async function latestPlaceKey(): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(historyRoot());
  } catch {
    return null;
  }
  let best: { key: string; mtime: number } | null = null;
  for (const key of names) {
    try {
      const s = await stat(join(historyRoot(), key, "index.jsonl"));
      if (!best || s.mtimeMs > best.mtime) best = { key, mtime: s.mtimeMs };
    } catch {
      // Not a place directory.
    }
  }
  return best?.key ?? null;
}

/**
 * A unified-style line diff: `@@` hunks, ` ` context, `-` removed, `+` added.
 *
 * LCS over the lines left after trimming the common head and tail, which is
 * where nearly all of a script's lines are for a typical edit, so the table
 * stays small. Capped: two unrelated 3,000-line files would need a 9M-cell
 * table, and a diff that large is not something anyone reads anyway.
 */
export function lineDiff(before: string, after: string, context = 2): string {
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }
  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);
  if (am.length === 0 && bm.length === 0) return "";

  type Op = { kind: " " | "-" | "+"; text: string; aLine: number; bLine: number };
  const ops: Op[] = [];
  for (let i = Math.max(0, head - context); i < head; i += 1) {
    ops.push({ kind: " ", text: a[i], aLine: i + 1, bLine: i + 1 });
  }

  if (am.length * bm.length > 4_000_000) {
    am.forEach((text, i) => ops.push({ kind: "-", text, aLine: head + i + 1, bLine: head + 1 }));
    bm.forEach((text, j) => ops.push({ kind: "+", text, aLine: head + 1, bLine: head + j + 1 }));
  } else {
    // lcs[i][j] = LCS length of am[i..] and bm[j..], flattened.
    const w = bm.length + 1;
    const lcs = new Uint32Array((am.length + 1) * w);
    for (let i = am.length - 1; i >= 0; i -= 1) {
      for (let j = bm.length - 1; j >= 0; j -= 1) {
        lcs[i * w + j] =
          am[i] === bm[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < am.length || j < bm.length) {
      if (i < am.length && j < bm.length && am[i] === bm[j]) {
        ops.push({ kind: " ", text: am[i], aLine: head + i + 1, bLine: head + j + 1 });
        i += 1;
        j += 1;
      } else if (i < am.length && (j === bm.length || lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) {
        // Removals before additions on a tie, so a changed line reads -old then +new.
        ops.push({ kind: "-", text: am[i], aLine: head + i + 1, bLine: head + j + 1 });
        i += 1;
      } else {
        ops.push({ kind: "+", text: bm[j], aLine: head + i + 1, bLine: head + j + 1 });
        j += 1;
      }
    }
  }

  const afterTail = a.length - tail;
  for (let k = 0; k < Math.min(context, tail); k += 1) {
    ops.push({
      kind: " ",
      text: a[afterTail + k],
      aLine: afterTail + k + 1,
      bLine: b.length - tail + k + 1,
    });
  }

  // Group into hunks, dropping context runs longer than 2 * context.
  const out: string[] = [];
  let k = 0;
  while (k < ops.length) {
    while (k < ops.length && ops[k].kind === " ") k += 1;
    if (k >= ops.length) break;
    let start = k;
    let back = 0;
    while (start > 0 && ops[start - 1].kind === " " && back < context) {
      start -= 1;
      back += 1;
    }
    let end = k;
    let quiet = 0;
    while (end < ops.length && quiet <= context * 2) {
      quiet = ops[end].kind === " " ? quiet + 1 : 0;
      end += 1;
    }
    end -= Math.max(0, quiet - context);
    const first = ops[start];
    out.push(`@@ -${first.aLine} +${first.bLine} @@`);
    for (let m = start; m < end; m += 1) out.push(`${ops[m].kind}${ops[m].text}`);
    k = end;
  }
  return out.join("\n");
}
