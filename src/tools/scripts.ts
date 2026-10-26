import { type ToolContext, type ToolEntry, evalTool, localTool, pipelineTool, luaJson } from "../registry.js";
import { type HistoryEntry, latestPlaceKey, lineDiff, placeKeyOf, readBlob, readIndex } from "../script-history.js";

/**
 * Which place's history to read: the open place when Studio answers, otherwise
 * the one written most recently, so history stays readable with Studio closed.
 */
async function historyPlace(ctx: ToolContext): Promise<string | null> {
  try {
    const place = await ctx.getPlaceContext();
    if (place.placeId > 0 || (place.placeName && place.placeName !== "(plugin not connected)")) {
      return placeKeyOf(place.placeId, place.placeName);
    }
  } catch {
    // Fall through to the newest history on disk.
  }
  return latestPlaceKey();
}

/** Versions of one script, oldest first. Accepts a full path or a unique tail of one. */
function versionsOf(index: HistoryEntry[], target: string): { path: string; versions: HistoryEntry[] } | null {
  let versions = index.filter((e) => e.path === target);
  if (versions.length === 0) {
    const tails = [...new Set(index.map((e) => e.path).filter((p) => p.endsWith(`.${target}`)))];
    if (tails.length !== 1) return null;
    versions = index.filter((e) => e.path === tails[0]);
  }
  return { path: versions[0].path, versions };
}

/**
 * Reading, searching and patching LuaSourceContainers.
 *
 * One file per Category value — the registry's own taxonomy names the file,
 * so there is never a question of where a new tool goes (A6).
 */

export const SCRIPTS_TOOLS: ToolEntry[] = [
  evalTool(
    {
      name: "find_references",
      category: "scripts",
      subcategories: ["search", "grep", "refactor"],
      keywords: ["find", "references", "grep", "search", "usages", "callers"],
      description:
        "Find a literal substring in every script across the standard script services. Returns matching scripts with line numbers, e.g. before renaming a function.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Literal, case-sensitive substring." },
          maxResults: { type: "number", description: "Max matching scripts (default 20)." },
          maxMatchesPerScript: { type: "number", description: "Max matching lines per script (default 5)." },
          scope: {
            type: "string",
            description: "Search root, ref or path. Default: all script services.",
          },
        },
        required: ["query"],
      },
    },
    (args) => `
local a = __MCP.decode(${luaJson(args)})
if type(a.query) ~= "string" or a.query == "" then
  return { error = "bad_args", hint = "query is required and must be a non-empty string." }
end
local maxResults = tonumber(a.maxResults) or 20
local maxMatchesPerScript = tonumber(a.maxMatchesPerScript) or 5

local function gatherScripts(root)
  local out = {}
  for _, d in ipairs(root:GetDescendants()) do
    if d:IsA("LuaSourceContainer") then out[#out + 1] = d end
  end
  return out
end

local scripts = {}
if a.scope then
  local root = __MCP.resolve(a.scope)
  if not root then return { error = "not_found", scope = a.scope } end
  scripts = gatherScripts(root)
else
  for _, svcName in ipairs({
    "ServerScriptService", "ServerStorage", "ReplicatedStorage", "ReplicatedFirst",
    "StarterGui", "StarterPack", "StarterPlayer", "Workspace",
  }) do
    local ok, svc = pcall(game.GetService, game, svcName)
    if ok and svc then
      for _, s in ipairs(gatherScripts(svc)) do scripts[#scripts + 1] = s end
    end
  end
end

local results = {}
local scannedCount = 0
local truncated = false
for _, script in ipairs(scripts) do
  scannedCount += 1
  local source = script.Source
  if source and string.find(source, a.query, 1, true) then
    local matches = {}
    local lineNum = 1
    for line in string.gmatch(source .. "\\n", "(.-)\\n") do
      if string.find(line, a.query, 1, true) then
        matches[#matches + 1] = { line = lineNum, text = line }
        if #matches >= maxMatchesPerScript then break end
      end
      lineNum += 1
    end
    results[#results + 1] = {
      ref = __MCP.refFor(script),
      path = script:GetFullName(),
      class = script.ClassName,
      matches = matches,
      matchCount = #matches,
    }
    if #results >= maxResults then truncated = true break end
  end
end

return {
  query = a.query,
  results = results,
  totalScripts = #results,
  scannedCount = scannedCount,
  truncated = truncated,
}
`,
  ),
  pipelineTool(
    {
      name: "script_edit",
      category: "scripts",
      subcategories: ["code", "patch", "refactor"],
      keywords: ["edit", "patch", "modify", "change", "replace", "find", "refactor", "rewrite", "source"],
      description:
        "Patch a script's Source with ordered find/replace edits, cheaper than rewriting it. Each find must match once unless allowMultiple; a missing find fails the batch.",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", description: "Ref or path of the script (Script, LocalScript, or ModuleScript)." },
          edits: {
            type: "array",
            description: "Ordered patches, matched literally.",
            items: {
              type: "object",
              properties: {
                find: { type: "string", description: "Literal string to find." },
                replace: { type: "string", description: "Replacement string." },
                allowMultiple: {
                  type: "boolean",
                  description: "Replace every match instead of failing on more than one.",
                },
              },
              required: ["find", "replace"],
            },
          },
          confirm: {
            type: "boolean",
            description: "Forwarded to the mutate confirm gate.",
          },
        },
        required: ["target", "edits"],
      },
    },
    async (args, ctx) => {
      const target = String(args.target ?? "").trim();
      const edits = Array.isArray(args.edits) ? args.edits : [];
      if (!target) return { error: "bad_args", hint: "script_edit needs a 'target'." };
      if (edits.length === 0) return { error: "bad_args", hint: "edits must be a non-empty array." };

      // Read the live source (read-only — safe with writes off).
      const read = (await ctx.bridge.send("eval", {
        luau: `
local a = __MCP.decode(${luaJson({ target })})
local inst = __MCP.resolve(a.target)
if not inst then return { error = "not_found", target = a.target } end
if not inst:IsA("LuaSourceContainer") then
  return { error = "not_a_script", class = inst.ClassName }
end
return { path = inst:GetFullName(), ref = __MCP.refFor(inst), source = inst.Source }
`,
      })) as { error?: string; path?: string; ref?: string; source?: string; class?: string } | undefined;

      if (!read || read.error) return read ?? { error: "read_failed", target };

      let source = String(read.source ?? "");
      const report: Array<{ find: string; replacements: number }> = [];

      for (let i = 0; i < edits.length; i += 1) {
        const edit = edits[i] as { find?: unknown; replace?: unknown; allowMultiple?: unknown };
        if (typeof edit?.find !== "string" || edit.find === "") {
          return { error: "bad_edit", index: i, hint: "Each edit needs a non-empty 'find' string." };
        }
        const replace = typeof edit.replace === "string" ? edit.replace : "";
        const parts = source.split(edit.find);
        const count = parts.length - 1;
        if (count === 0) {
          return {
            error: "find_not_found",
            index: i,
            find: edit.find,
            hint: "The find string was not present in the current source. Read the script first to confirm the exact text (whitespace + case matter).",
          };
        }
        if (count > 1 && edit.allowMultiple !== true) {
          return {
            error: "find_ambiguous",
            index: i,
            find: edit.find,
            matches: count,
            hint: `find matched ${count} times. Pass allowMultiple: true to replace all, or expand the find string to make it unique.`,
          };
        }
        source = parts.join(replace);
        report.push({ find: edit.find, replacements: count });
      }

      // One `set` op carrying the finished source: picks up the destructiveness
      // gate and the selene lint, exactly like a hand-written mutate would.
      const result = await ctx.handleMutate({
        ops: [{ op: "set", target, props: { Source: source } }],
        confirm: args.confirm === true,
      });

      return {
        edited: !(result && typeof result === "object" && "error" in result),
        path: read.path,
        ref: read.ref,
        edits: report,
        totalReplacements: report.reduce((n, r) => n + r.replacements, 0),
        sourceLength: source.length,
        result,
      };
    },
  ),
  evalTool(
    {
      name: "script_read",
      category: "scripts",
      subcategories: ["source", "inspect"],
      keywords: ["read", "source", "view", "get", "show", "print", "open", "content", "code"],
      description:
        "A script's source with line numbers, optionally a line range. The natural follow-up to debug_error.",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", description: "Ref or path of a Script, LocalScript, or ModuleScript." },
          startLine: { type: "number", description: "First line (1-based)." },
          endLine: { type: "number", description: "Last line, inclusive." },
        },
        required: ["target"],
      },
    },
    (args) => `
local a = __MCP.decode(${luaJson(args)})
local inst = __MCP.resolve(a.target)
if not inst then return { error = "not_found", target = a.target } end
if not inst:IsA("LuaSourceContainer") then
  return { error = "not_a_script", class = inst.ClassName, hint = "script_read only works on Script / LocalScript / ModuleScript." }
end
local source = inst.Source
local lines = {}
for line in string.gmatch(source .. "\\n", "([^\\n]*)\\n") do
  lines[#lines + 1] = line
end
local startL = math.max(1, tonumber(a.startLine) or 1)
local endL = math.min(#lines, tonumber(a.endLine) or #lines)
local numbered = {}
for i = startL, endL do
  numbered[#numbered + 1] = { n = i, code = lines[i] }
end
return {
  ref = __MCP.refFor(inst),
  path = inst:GetFullName(),
  class = inst.ClassName,
  enabled = inst:IsA("BaseScript") and inst.Enabled or nil,
  totalLines = #lines,
  startLine = startL,
  endLine = endL,
  lines = numbered,
}
`,
  ),
  localTool(
    {
      name: "script_history",
      category: "scripts",
      subcategories: ["history", "versions", "undo"],
      keywords: ["history", "versions", "undo", "revert", "rollback", "backup", "diff", "changes", "previous", "old"],
      description:
        "Script versions saved to disk before each edit or delete via mutate/script_edit. No target: scripts with history. target: its versions. version: diff against the previous one.",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", description: "Script path, or a unique tail like Camera.Shake." },
          version: { type: "number", description: "Version number to diff." },
          full: { type: "boolean", description: "Include its source." },
        },
      },
    },
    async (args, ctx) => {
      const place = await historyPlace(ctx);
      if (!place) return { error: "no_history", hint: "Nothing has been saved yet. History starts with the first script edit." };
      const index = await readIndex(place);
      const limit = 20;

      if (typeof args.target !== "string" || !args.target.trim()) {
        const byPath = new Map<string, { path: string; class: string; versions: number; last: string }>();
        for (const e of index) {
          const row = byPath.get(e.path) ?? { path: e.path, class: e.class, versions: 0, last: e.at };
          row.versions += 1;
          row.last = e.at;
          byPath.set(e.path, row);
        }
        const scripts = [...byPath.values()].sort((x, y) => y.last.localeCompare(x.last));
        return { place, scripts: scripts.slice(0, limit), totalScripts: scripts.length };
      }

      const found = versionsOf(index, args.target.trim());
      if (!found) return { error: "not_found", place, target: args.target, hint: "No history for that script. Call without a target to list the ones that have it." };
      const { path, versions } = found;

      if (typeof args.version === "number") {
        const n = Math.trunc(args.version);
        const entry = versions[n - 1];
        if (!entry) return { error: "bad_version", path, versions: versions.length };
        const source = (await readBlob(place, entry.hash)) ?? "";
        const prev = n > 1 ? ((await readBlob(place, versions[n - 2].hash)) ?? "") : "";
        return {
          place,
          path,
          version: n,
          at: entry.at,
          action: entry.action,
          lines: entry.lines,
          diff: n > 1 ? lineDiff(prev, source) : "(first saved version)",
          ...(args.full === true || n === 1 ? { source } : {}),
        };
      }

      return {
        place,
        path,
        class: versions[versions.length - 1].class,
        versions: versions
          .map((e, i) => ({ version: i + 1, at: e.at, action: e.action, lines: e.lines, tool: e.tool }))
          .reverse()
          .slice(0, limit),
        total: versions.length,
      };
    },
  ),
  pipelineTool(
    {
      name: "script_restore",
      category: "scripts",
      subcategories: ["history", "undo", "restore"],
      keywords: ["restore", "revert", "rollback", "undo", "history", "recover", "previous", "version"],
      description:
        "Write a script_history version back to Studio, recreating the script if it was deleted. The restore is saved too, so it can be undone.",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", description: "As script_history shows it." },
          version: { type: "number" },
          confirm: { type: "boolean", description: "Forwarded to the mutate confirm gate." },
        },
        required: ["target", "version"],
      },
    },
    async (args, ctx) => {
      const place = await historyPlace(ctx);
      if (!place) return { error: "no_history" };
      const found = versionsOf(await readIndex(place), String(args.target ?? "").trim());
      if (!found) return { error: "not_found", place, target: args.target };
      const entry = found.versions[Math.trunc(Number(args.version)) - 1];
      if (!entry) return { error: "bad_version", path: found.path, versions: found.versions.length };
      const source = await readBlob(place, entry.hash);
      if (source === null) return { error: "blob_missing", path: found.path, version: args.version };

      const dot = found.path.lastIndexOf(".");
      const live = (await ctx.bridge.send("eval", {
        luau: `
local a = __MCP.decode(${luaJson({ path: found.path, parent: found.path.slice(0, dot) })})
-- History is keyed on GetFullName(), so a path is only safe to write when it names one
-- instance: no level may hold two children with the same name, or one whose name has a dot.
local node, rest = game, a.path
while node and rest ~= "" do
  local seg = string.match(rest, "^[^%.]+") or rest
  local hits = 0
  for _, c in node:GetChildren() do
    if c.Name == seg then hits += 1 end
    if string.find(c.Name, ".", 1, true) and (rest == c.Name or string.sub(rest, 1, #c.Name + 1) == c.Name .. ".") then
      return { ambiguous = true, at = c:GetFullName() }
    end
  end
  if hits > 1 then return { ambiguous = true, at = node:GetFullName() .. "." .. seg } end
  node = node:FindFirstChild(seg)
  rest = string.sub(rest, #seg + 2)
end
local inst = __MCP.resolve(a.path)
return { exists = inst ~= nil and inst:IsA("LuaSourceContainer"), parentExists = __MCP.resolve(a.parent) ~= nil }
`,
      })) as { exists?: boolean; parentExists?: boolean; ambiguous?: boolean; at?: string };
      if (live?.ambiguous) {
        return {
          error: "ambiguous_path",
          path: found.path,
          at: live.at,
          hint: "More than one instance matches this path (same-named siblings or a name containing a dot), so the restore could write the wrong script. Rename them apart first.",
        };
      }

      let op: Record<string, unknown>;
      if (live?.exists) {
        op = { op: "set", target: found.path, props: { Source: source } };
      } else if (live?.parentExists && dot > 0) {
        op = {
          op: "create",
          class: entry.class,
          name: found.path.slice(dot + 1),
          parent: found.path.slice(0, dot),
          props: { Source: source },
        };
      } else {
        return { error: "parent_missing", path: found.path, hint: "The script's parent no longer exists. Recreate it first." };
      }
      const result = await ctx.handleMutate({ ops: [op], confirm: args.confirm === true });
      const failed = !!(result && typeof result === "object" && "error" in result);
      return {
        ...(failed ? { error: (result as { error: unknown }).error } : {}),
        restored: !failed,
        path: found.path,
        version: Math.trunc(Number(args.version)),
        recreated: op.op === "create",
        result,
      };
    },
  ),
];
