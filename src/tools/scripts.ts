import { type ToolEntry, evalTool, localTool, luaJson } from "../registry.js";

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
      readOnly: true,
      description:
        "Grep LuaSourceContainers across the standard script services for a literal substring. Returns matching scripts with line numbers. Use before renaming a function or to answer 'where is X used?'.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Literal substring to search for (case-sensitive). Whitespace matters." },
          maxResults: { type: "number", description: "Max matching scripts (default 20)." },
          maxMatchesPerScript: { type: "number", description: "Max matching lines per script (default 5)." },
          scope: {
            type: "string",
            description:
              "Search root (ref or dotted path). Default: the standard script-bearing services.",
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
  localTool(
    {
      name: "script_edit",
      category: "scripts",
      subcategories: ["code", "patch", "refactor"],
      keywords: ["edit", "patch", "modify", "change", "replace", "find", "refactor", "rewrite", "source"],
      description:
        "Patch a script's Source with find/replace edits, cheaper than rewriting it. Edits apply in order; each find must match once unless `allowMultiple`. A missing find fails the batch, no silent no-ops. Same confirm gate and lint as `mutate`.",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", description: "Ref or path of the script (Script, LocalScript, or ModuleScript)." },
          edits: {
            type: "array",
            description: "Ordered patches. Each `find` is matched literally (not a pattern).",
            items: {
              type: "object",
              properties: {
                find: { type: "string", description: "Literal string to find." },
                replace: { type: "string", description: "Replacement string." },
                allowMultiple: {
                  type: "boolean",
                  description: "Allow more than one match (default false — fails if find appears >1 time).",
                },
              },
              required: ["find", "replace"],
            },
          },
          confirm: {
            type: "boolean",
            description: "Overwriting script source is destructive; forwarded to the mutate confirm gate.",
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
local a = __MCP.decode(${"${luaJson({ target })}"})
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
      readOnly: true,
      description:
        "Read a script's full source with line numbers in one call. Accepts an optional line range for large scripts. Natural follow-up to debug_error — faster and more direct than read+select.",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", description: "Ref or path of a Script, LocalScript, or ModuleScript." },
          startLine: { type: "number", description: "First line to return (1-based, default 1)." },
          endLine: { type: "number", description: "Last line to return inclusive (default: all lines)." },
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
];
