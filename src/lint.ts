import { spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

/**
 * Inline Luau lint, run server-side on script source the agent writes through
 * `mutate`. The plugin can't run a linter, but the MCP server can — and it
 * already has the source text in the op, so no Studio round-trip is needed.
 *
 * Uses `selene` (with the roblox std from roblox/selene.toml) via the rokit
 * shim. Degrades gracefully: if selene isn't available, mutate still succeeds
 * and the response just carries a `{ error }` instead of diagnostics.
 */

// Both dist/lint.js and src/lint.ts sit one level under the project root.
const ROBLOX_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "roblox");
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

export async function lintLuau(source: string): Promise<LintOutcome> {
  const tmpFile = join(tmpdir(), `cubes-mcp-lint-${randomUUID()}.luau`);
  try {
    await writeFile(tmpFile, source, "utf8");
    const stdout = await runSelene(tmpFile);
    return parseSelene(stdout, source);
  } catch (err) {
    return { error: `lint unavailable: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
}

function runSelene(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(SELENE_BIN, [file, "--display-style", "json"], { cwd: ROBLOX_DIR });
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
