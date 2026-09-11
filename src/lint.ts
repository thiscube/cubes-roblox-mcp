import { spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";

/**
 * Inline Luau lint, run server-side on script source the agent writes through
 * `mutate`. The plugin can't run a linter, but the MCP server can — and it
 * already has the source text in the op, so no Studio round-trip is needed.
 *
 * Uses `selene` if it is on PATH. Configure the working directory (where your
 * selene.toml lives) with CUBES_MCP_LINT_CWD. Degrades gracefully: if selene
 * isn't available, mutate still succeeds and the response carries a `{ error }`
 * instead of diagnostics — and `lintAvailable()` lets the server say so once at
 * startup rather than silently per call.
 */

// Both dist/lint.js and src/lint.ts sit one level under the project root.
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/**
 * Directory selene runs in — it resolves selene.toml (and the Roblox std) from here.
 *
 * This used to point at `<root>/roblox`, a directory .gitignore excludes and git has
 * never tracked. Node fails the spawn on a missing cwd BEFORE it looks for the binary,
 * so inline lint could never run for anyone who cloned this repo, and failed silently
 * as "lint unavailable" (AUDIT.md #7). Defaults to the project root; point
 * CUBES_MCP_LINT_CWD at wherever your selene.toml lives.
 */
const LINT_CWD = process.env.CUBES_MCP_LINT_CWD || PROJECT_ROOT;
const SELENE_BIN = process.platform === "win32" ? "selene.exe" : "selene";
const SELENE_TIMEOUT_MS = 10_000;

export interface LintDiagnostic {
  severity: string; // "Error" | "Warning"
  code: string;
  message: string;
  line?: number;
}

export interface LintResult {
  ok: boolean; // true when there are no errors (warnings are allowed)
  errorCount: number;
  warningCount: number;
  diagnostics: LintDiagnostic[];
}

export type LintOutcome = LintResult | { error: string };

// LRU cache keyed by sha1(source). Selene spawn is 50-150ms cold; identical
// source (re-saves, repeated macro runs) is a common case worth caching.
// Map insertion order doubles as LRU order: re-set on hit, delete oldest on cap.
const LINT_CACHE_CAP = 256;
const lintCache = new Map<string, LintOutcome>();

function hashSource(source: string): string {
  return createHash("sha1").update(source).digest("hex");
}

function cacheGet(key: string): LintOutcome | undefined {
  const hit = lintCache.get(key);
  if (hit === undefined) return undefined;
  // Re-insert to mark as most-recently-used.
  lintCache.delete(key);
  lintCache.set(key, hit);
  return hit;
}

function cacheSet(key: string, value: LintOutcome): void {
  if (lintCache.has(key)) lintCache.delete(key);
  lintCache.set(key, value);
  if (lintCache.size > LINT_CACHE_CAP) {
    const oldest = lintCache.keys().next().value;
    if (oldest !== undefined) lintCache.delete(oldest);
  }
}

export async function lintLuau(source: string): Promise<LintOutcome> {
  const key = hashSource(source);
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  const tmpFile = join(tmpdir(), `cubes-mcp-lint-${randomUUID()}.luau`);
  let outcome: LintOutcome;
  try {
    await writeFile(tmpFile, source, "utf8");
    const stdout = await runSelene(tmpFile);
    outcome = parseSelene(stdout, source);
  } catch (err) {
    outcome = { error: `lint unavailable: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
  // Don't cache transient failures (selene not on PATH, timeout) — they may
  // resolve on retry. Cache only deterministic lint results.
  if ("ok" in outcome) cacheSet(key, outcome);
  return outcome;
}

function runSelene(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(SELENE_BIN, [file, "--display-style", "json"], { cwd: LINT_CWD });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("selene timed out"));
    }, SELENE_TIMEOUT_MS);

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err); // e.g. ENOENT — selene not on PATH
    });
    child.on("close", () => {
      clearTimeout(timer);
      // selene exits non-zero when it finds lints; that's expected, not a failure.
      if (!stdout && stderr) {
        reject(new Error(stderr.trim().split("\n")[0] || "selene produced no output"));
      } else {
        resolve(stdout);
      }
    });
  });
}

function parseSelene(stdout: string, source: string): LintResult {
  const diagnostics: LintDiagnostic[] = [];
  let errorCount = 0;
  let warningCount = 0;

  // selene --display-style json emits one JSON diagnostic per line, then a
  // human-readable "Results:" summary block — skip anything that isn't JSON.
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line || line[0] !== "{") continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj.severity !== "string" || !obj.code) continue;

    const severity = String(obj.severity);
    const span = obj.primary_label?.span;
    let lineNo: number | undefined;
    if (span && typeof span.start_line === "number") {
      lineNo = span.start_line + 1; // selene line numbers are 0-indexed
    } else if (span && typeof span.start === "number") {
      lineNo = lineFromOffset(source, span.start);
    }

    diagnostics.push({
      severity,
      code: String(obj.code),
      message: String(obj.message ?? ""),
      line: lineNo,
    });
    if (severity === "Error") errorCount += 1;
    else warningCount += 1;
  }

  return { ok: errorCount === 0, errorCount, warningCount, diagnostics };
}

function lineFromOffset(source: string, offset: number): number {
  let line = 1;
  const end = Math.min(offset, source.length);
  for (let i = 0; i < end; i += 1) {
    if (source[i] === "\n") line += 1;
  }
  return line;
}

/**
 * Probe whether selene can actually run, so the server can say so ONCE at
 * startup instead of degrading silently on every mutate (AUDIT.md #7).
 */
export async function lintAvailable(): Promise<{ ok: boolean; reason?: string }> {
  const probe = await lintLuau("local _cubes_mcp_probe = 1\n");
  if ("ok" in probe) return { ok: true };
  return { ok: false, reason: probe.error };
}
