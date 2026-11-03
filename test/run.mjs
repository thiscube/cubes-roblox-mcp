/**
 * Run the unit suite on any Node this project supports.
 *
 * The scripts used to pass `"test/unit/*.test.mjs"` straight to `node --test`.
 * Node 22 expands that itself; Node 20 does not, and treats it as a literal
 * path — so CI's Node 20 job failed with `Could not find .../*.test.mjs` on
 * every push, while `npm test` was green on the developer's Node 22. Leaving the
 * glob unquoted would fix Linux and break Windows, where npm runs scripts
 * through cmd and nothing expands it.
 *
 * So: list the files here and hand them over explicitly.
 *
 * `--offline` sets CUBES_MCP_OFFLINE=1 for the run, because `VAR=1 node ...` in
 * an npm script stops dead in cmd on Windows.
 */
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const unit = join(here, "unit");
const files = readdirSync(unit)
  .filter((f) => f.endsWith(".test.mjs"))
  .sort()
  .map((f) => join(unit, f));

if (files.length === 0) {
  console.error(`No test files found in ${unit}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const offline = args.includes("--offline");
const result = spawnSync(process.execPath, ["--test", ...args.filter((a) => a !== "--offline"), ...files], {
  stdio: "inherit",
  env: offline ? { ...process.env, CUBES_MCP_OFFLINE: "1" } : process.env,
});
process.exit(result.status ?? 1);
