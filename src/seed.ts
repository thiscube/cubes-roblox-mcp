import { type ToolEntry, evalTool, mutateTool, dispatchTool, luaJson } from "./registry.js";
import { PRO_TOOLS } from "./pro.js";
import { diffSnapshots } from "./snapshot-diff.js";
import type { SnapshotInstance } from "./memory.js";
import { applyPatch, loadProfile, saveProfile, type ProfilePatch } from "./profile.js";

/**
 * Seed specialist tools. These are deliberately a small starter set — enough to
 * prove progressive loading (search_tools) works across categories. Add more here
 * as needed; each one stays hidden until search surfaces it, so the list can grow
 * without inflating per-turn token cost.
 *
 * Most tools route through the plugin's `mutate` path (atomic + undo waypoint for
 * free) or its `eval` path (for anything that needs a loop or custom logic).
 */

export const SEED_TOOLS: ToolEntry[] = [
  // ---- instances ----------------------------------------------------------
  // Lighting / PointLight / Script creation are intentionally NOT specialist
  // tools — the core `mutate` op already does:
  //   { op: "set", target: "Lighting", props: { Brightness, ClockTime, ... } }
  //   { op: "create", class: "PointLight", parent: "...", props: { Brightness, Range, Color } }
  //   { op: "create", class: "Script", parent: "...", props: { Source } }
  // Wrapping them in named specialists just adds unlock cost without new behavior.
  evalTool(
    {
      name: "instance_duplicate",
      category: "instances",
      subcategories: ["clone", "copy"],
      keywords: ["duplicate", "copy", "clone", "repeat", "array", "spread"],
      write: true,
      description:
        "Clone an instance N times into its own parent, optionally offsetting each copy's Position. Returns refs of the new copies. Runs in one undo waypoint.",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", description: "Ref or path of the instance to clone." },
          count: { type: "number", description: "How many copies (default 1)." },
          offset: {
            type: "array",
            items: { type: "number" },
            description: "Per-copy [x, y, z] position offset (BaseParts only).",
          },
        },
        required: ["target"],
      },
    },
    (args) => `
local a = __MCP.decode(${luaJson(args)})
local src = __MCP.resolve(a.target)
if not src then return { error = "not_found", target = a.target } end
-- Guard: services live directly under \`game\` and \`Clone()\` errors on them.
-- Surface the issue with a structured error instead of letting it fall
-- through as a generic \`runtime_error\`.
if src.Parent == game then
  return { error = "cannot_clone_service", target = a.target, hint = "Clone a child of the service, not the service itself." }
end
local CHS = game:GetService("ChangeHistoryService")
local rec = CHS:TryBeginRecording("Cubes MCP: instance_duplicate")
local out = {}
local ok, err = pcall(function()
  for i = 1, (a.count or 1) do
    local c = src:Clone()
    c.Parent = src.Parent
    if a.offset and c:IsA("BasePart") then
      c.Position = c.Position + Vector3.new((a.offset[1] or 0) * i, (a.offset[2] or 0) * i, (a.offset[3] or 0) * i)
    end
    out[#out + 1] = { ref = __MCP.refFor(c), path = c:GetFullName() }
  end
end)
if rec then CHS:FinishRecording(rec, ok and Enum.FinishRecordingOperation.Commit or Enum.FinishRecordingOperation.Cancel) end
if not ok then return { error = "clone_failed", message = tostring(err) } end
return { created = out }
`,
  ),

  mutateTool(
    {
      name: "parts_grid",
      category: "instances",
      subcategories: ["generate", "layout"],
      keywords: ["grid", "tiles", "floor", "rows", "columns", "spawn", "many", "pattern"],
      description:
        "Create a rectangular grid of anchored Parts under a parent. Good for floors, tile layouts, or placeholder geometry.",
      inputSchema: {
        type: "object",
        properties: {
          parent: { type: "string", description: "Ref or path of the parent (default Workspace)." },
          rows: { type: "number", description: "Number of rows (default 4)." },
          cols: { type: "number", description: "Number of columns (default 4)." },
          spacing: { type: "number", description: "World units between part centers (default 6)." },
          size: {
            type: "array",
            items: { type: "number" },
            description: "Part size [x, y, z] (default [4, 1, 4]).",
          },
          origin: {
            type: "array",
            items: { type: "number" },
            description: "World origin [x, y, z] of the grid (default [0, 0, 0]).",
          },
        },
      },
    },
    (args) => {
      // Cap at 50×50 = 2500 parts per batch. Past this point the mutate
      // payload is enormous and the lint/replication cost explodes —
      // splitting into multiple calls is cheaper.
      const MAX_DIM = 50;
      const rows = Math.min(MAX_DIM, Math.max(1, args.rows ?? 4));
      const cols = Math.min(MAX_DIM, Math.max(1, args.cols ?? 4));
      const spacing = args.spacing ?? 6;
      const size = args.size ?? [4, 1, 4];
      const origin = args.origin ?? [0, 0, 0];
      const parent = args.parent ?? "Workspace";
      const ops: unknown[] = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          ops.push({
            op: "create",
            class: "Part",
            parent,
            name: `Tile_${r}_${c}`,
            props: {
              Anchored: true,
              Size: size,
              Position: [origin[0] + c * spacing, origin[1], origin[2] + r * spacing],
            },
          });
        }
      }
      return ops;
    },
  ),

  evalTool(
    {
      name: "selection_set",
      category: "instances",
      subcategories: ["studio", "selection"],
      keywords: ["select", "highlight", "focus", "pick"],
      description: "Set the Studio selection to a list of refs or paths.",
      inputSchema: {
        type: "object",
        properties: {
          targets: {
            type: "array",
            items: { type: "string" },
            description: "Refs or paths to select.",
          },
        },
        required: ["targets"],
      },
    },
    (args) => `
local a = __MCP.decode(${luaJson(args)})
local picked = {}
for _, t in ipairs(a.targets or {}) do
  local inst = __MCP.resolve(t)
  if inst then picked[#picked + 1] = inst end
end
game:GetService("Selection"):Set(picked)
return { selected = #picked }
`,
  ),

  evalTool(
    {
      name: "material_paint",
      category: "instances",
      subcategories: ["appearance", "material"],
      keywords: ["material", "color", "paint", "texture", "recolor", "wood", "metal", "neon"],
      write: true,
      description: "Set Material and/or Color on one or more BaseParts (by refs, paths, or a query).",
      inputSchema: {
        type: "object",
        properties: {
          targets: { type: "array", items: { type: "string" }, description: "Refs or paths." },
          query: { type: "string", description: "Alternative to targets: a read-style selector." },
          material: { type: "string", description: "Material name, e.g. 'Wood', 'Neon', 'Metal'." },
          color: { type: "string", description: "Color 'r, g, b' (0-255)." },
        },
      },
    },
    (args) => `
local a = __MCP.decode(${luaJson(args)})
local list = {}
if a.query then
  for _, inst in ipairs(__MCP.query(a.query)) do list[#list + 1] = inst end
end
for _, t in ipairs(a.targets or {}) do
  local inst = __MCP.resolve(t)
  if inst then list[#list + 1] = inst end
end
local CHS = game:GetService("ChangeHistoryService")
local rec = CHS:TryBeginRecording("Cubes MCP: material_paint")
local touched = 0
for _, inst in ipairs(list) do
  if inst:IsA("BasePart") then
    if a.material then
      local ok, m = pcall(function() return Enum.Material[a.material] end)
      if ok then inst.Material = m end
    end
    if a.color then
      local r, g, b = string.match(a.color, "(-?[%d%.]+)%D*[%s,]+(-?[%d%.]+)%D*[%s,]+(-?[%d%.]+)")
      if r then
        local rn, gn, bn = tonumber(r), tonumber(g), tonumber(b)
        if rn and gn and bn then
          local maxC = math.max(rn, gn, bn)
          if maxC > 1 then
            inst.Color = Color3.fromRGB(rn, gn, bn)
          else
            inst.Color = Color3.new(rn, gn, bn)
          end
        end
      end
    end
    touched += 1
  end
end
if rec then CHS:FinishRecording(rec, Enum.FinishRecordingOperation.Commit) end
return { painted = touched }
`,
  ),

  // tag_apply removed — the core `mutate` op already supports per-op `tags`
  // and `remove_tags` arrays, and unlike this specialist it runs inside the
  // mutate batch's CHS waypoint. Use:
  //   { op: "set", target: "...", tags: ["Enemy"] }
  //   { op: "set", target: "...", remove_tags: ["Enemy"] }


  // ---- scripts ------------------------------------------------------------
  evalTool(
    {
      name: "find_references",
      category: "scripts",
      subcategories: ["search", "grep", "refactor"],
      keywords: ["find", "references", "grep", "search", "usages", "callers"],
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
              "Optional path/ref to limit the search root, e.g. 'ServerScriptService' or a folder ref. Default: scan the standard script-bearing services.",
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

  evalTool(
    {
      name: "script_edit",
      category: "scripts",
      subcategories: ["code", "patch", "refactor"],
      keywords: ["edit", "patch", "modify", "change", "replace", "find", "refactor", "rewrite", "source"],
      write: true,
      description:
        "Patch a script's Source with find/replace edits — far cheaper than reading and rewriting the whole source. Each edit is applied in order. By default a find string must match exactly once; pass `allowMultiple: true` to allow multiple matches. Fails the whole batch if any find string is missing (no silent no-ops). Runs in one undo waypoint.",
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
        },
        required: ["target", "edits"],
      },
    },
    (args) => `
local a = __MCP.decode(${luaJson(args)})
local inst = __MCP.resolve(a.target)
if not inst then return { error = "not_found", target = a.target } end
if not inst:IsA("LuaSourceContainer") then
  return { error = "not_a_script", target = a.target, class = inst.ClassName, hint = "script_edit only works on Script / LocalScript / ModuleScript." }
end
if not a.edits or #a.edits == 0 then
  return { error = "bad_args", hint = "edits must be a non-empty array." }
end

local source = inst.Source
local report = {}
for i, edit in ipairs(a.edits) do
  if type(edit.find) ~= "string" or edit.find == "" then
    return { error = "bad_edit", index = i, hint = "Each edit needs a non-empty 'find' string." }
  end
  -- Plain (non-pattern) substring search + count
  local count, pos = 0, 1
  while true do
    local s, e = string.find(source, edit.find, pos, true)
    if not s then break end
    count += 1
    pos = e + 1
  end
  if count == 0 then
    return {
      error = "find_not_found",
      index = i,
      find = edit.find,
      hint = "The find string was not present in the current source. Read the script first to confirm the exact text (whitespace + case matter).",
    }
  end
  if count > 1 and not edit.allowMultiple then
    return {
      error = "find_ambiguous",
      index = i,
      find = edit.find,
      matches = count,
      hint = "find matched " .. tostring(count) .. " times. Pass allowMultiple: true to replace all, or expand the find string to make it unique.",
    }
  end
  -- string.gsub takes plain=nil so we do a manual literal replace
  local newSource = {}
  local cursor = 1
  for _ = 1, count do
    local s, e = string.find(source, edit.find, cursor, true)
    if not s then break end
    newSource[#newSource + 1] = string.sub(source, cursor, s - 1)
    newSource[#newSource + 1] = edit.replace
    cursor = e + 1
  end
  newSource[#newSource + 1] = string.sub(source, cursor)
  source = table.concat(newSource)
  report[#report + 1] = { find = edit.find, replacements = count }
end

local CHS = game:GetService("ChangeHistoryService")
local rec = CHS:TryBeginRecording("Cubes MCP: script_edit")
inst.Source = source
if rec then CHS:FinishRecording(rec, Enum.FinishRecordingOperation.Commit) end

local totalReplacements = 0
for _, r in ipairs(report) do totalReplacements += r.replacements end

return {
  edited = true,
  ref = __MCP.refFor(inst),
  path = inst:GetFullName(),
  edits = report,
  totalReplacements = totalReplacements,
  sourceLength = #source,
}
`,
  ),

  // script_create removed — duplicated `mutate` { op: "create", class: "Script" | "LocalScript" | "ModuleScript", props: { Source } }.
  // place_info removed — duplicated by the free `studio://overview` resource
  // (read it with the resources/read MCP capability — no tool call charged).

  // ---- debug visualization -----------------------------------------------
  // All viz overlays live under Workspace._CubesMCPDebug (Archivable=false so
  // they don't bleed into saved places). Tools build on Roblox primitives —
  // Highlight, SelectionBox, BillboardGui, LineHandleAdornment — instead of
  // spawning real Parts so the scene stays uncluttered. debug_clear wipes the
  // whole folder; per-tool `clear:true` wipes only that overlay type.
  evalTool(
    {
      name: "debug_highlight",
      category: "debug",
      subcategories: ["visualize", "overlay"],
      keywords: ["highlight", "outline", "color", "overlay", "mark", "see", "find", "show", "debug"],
      description:
        "Add a colored Highlight overlay to one or more instances so the agent (via screenshot) can see exactly which parts a change targets. Highlights are AlwaysOnTop and live under Workspace._CubesMCPDebug. Pass duration>0 to auto-clear after N seconds.",
      inputSchema: {
        type: "object",
        properties: {
          targets: { type: "array", items: { type: "string" }, description: "Refs or paths to highlight." },
          color: { type: "string", description: "Outline + fill color 'r,g,b' 0-255 (default 255,200,60)." },
          fillTransparency: { type: "number", description: "0=opaque fill, 1=no fill (default 0.65)." },
          outlineTransparency: { type: "number", description: "0=solid outline (default), 1=invisible." },
          clear: { type: "boolean", description: "Clear existing highlights first (default true)." },
          duration: { type: "number", description: "Auto-clear ALL debug viz after N seconds (default 0 = keep)." },
        },
        required: ["targets"],
      },
    },
    (args) => `
local a = __MCP.decode(${luaJson(args)})
local Workspace = game:GetService("Workspace")
local function getDbg()
  local f = Workspace:FindFirstChild("_CubesMCPDebug")
  if not f then f = Instance.new("Folder"); f.Name = "_CubesMCPDebug"; f.Archivable = false; f.Parent = Workspace end
  return f
end
local function parseRGB(s, dr, dg, db)
  if type(s) ~= "string" then return Color3.fromRGB(dr, dg, db) end
  local r, g, b = string.match(s, "(%-?[%d%.]+)%D+(%-?[%d%.]+)%D+(%-?[%d%.]+)")
  if r then return Color3.fromRGB(tonumber(r) or dr, tonumber(g) or dg, tonumber(b) or db) end
  return Color3.fromRGB(dr, dg, db)
end
local folder = getDbg()
if a.clear ~= false then
  for _, c in ipairs(folder:GetChildren()) do
    if c:IsA("Highlight") then c:Destroy() end
  end
end
local color = parseRGB(a.color, 255, 200, 60)
local marked = {}
for _, t in ipairs(a.targets or {}) do
  local inst = __MCP.resolve(t)
  if inst then
    local hl = Instance.new("Highlight")
    hl.Adornee = inst
    hl.OutlineColor = color
    hl.FillColor = color
    hl.FillTransparency = tonumber(a.fillTransparency) or 0.65
    hl.OutlineTransparency = tonumber(a.outlineTransparency) or 0
    hl.DepthMode = Enum.HighlightDepthMode.AlwaysOnTop
    hl.Parent = folder
    marked[#marked + 1] = inst:GetFullName()
  end
end
local dur = tonumber(a.duration)
if dur and dur > 0 then
  task.delay(dur, function() if folder.Parent then folder:Destroy() end end)
end
return { highlighted = marked, count = #marked }
`,
  ),

  evalTool(
    {
      name: "debug_bounds",
      category: "debug",
      subcategories: ["visualize", "bbox"],
      keywords: ["bounds", "box", "bbox", "selection", "wireframe", "outline", "extent", "debug"],
      description:
        "Wireframe SelectionBox around one or more instances. Useful for seeing the full extent of a Model without a fill overlay. Lives under Workspace._CubesMCPDebug.",
      inputSchema: {
        type: "object",
        properties: {
          targets: { type: "array", items: { type: "string" }, description: "Refs or paths to box." },
          color: { type: "string", description: "Line color 'r,g,b' (default 100,200,255)." },
          lineThickness: { type: "number", description: "Box line thickness (default 0.05)." },
          clear: { type: "boolean", description: "Clear existing bounds first (default true)." },
          duration: { type: "number", description: "Auto-clear ALL debug viz after N seconds." },
        },
        required: ["targets"],
      },
    },
    (args) => `
local a = __MCP.decode(${luaJson(args)})
local Workspace = game:GetService("Workspace")
local function getDbg()
  local f = Workspace:FindFirstChild("_CubesMCPDebug")
  if not f then f = Instance.new("Folder"); f.Name = "_CubesMCPDebug"; f.Archivable = false; f.Parent = Workspace end
  return f
end
local folder = getDbg()
if a.clear ~= false then
  for _, c in ipairs(folder:GetChildren()) do
    if c:IsA("SelectionBox") then c:Destroy() end
  end
end
local r, g, b = 100, 200, 255
if type(a.color) == "string" then
  local rt, gt, bt = string.match(a.color, "(%d+)%D+(%d+)%D+(%d+)")
  if rt then r, g, b = tonumber(rt), tonumber(gt), tonumber(bt) end
end
local color = Color3.fromRGB(r, g, b)
local boxed = {}
for _, t in ipairs(a.targets or {}) do
  local inst = __MCP.resolve(t)
  if inst then
    local sb = Instance.new("SelectionBox")
    sb.Adornee = inst
    sb.Color3 = color
    sb.LineThickness = tonumber(a.lineThickness) or 0.05
    sb.Parent = folder
    boxed[#boxed + 1] = inst:GetFullName()
  end
end
local dur = tonumber(a.duration)
if dur and dur > 0 then
  task.delay(dur, function() if folder.Parent then folder:Destroy() end end)
end
return { bounded = boxed, count = #boxed }
`,
  ),

  evalTool(
    {
      name: "debug_label",
      category: "debug",
      subcategories: ["visualize", "text"],
      keywords: ["label", "text", "name", "tag", "annotate", "billboard", "debug"],
      description:
        "Floating billboard text labels above instances or at world positions. Always faces the camera. Use to annotate parts during a screenshot review ('this is the head', 'pivot here').",
      inputSchema: {
        type: "object",
        properties: {
          labels: {
            type: "array",
            description: "List of label specs. Each must have either `target` (ref/path) or `position` ([x,y,z]).",
            items: {
              type: "object",
              properties: {
                target: { type: "string", description: "Ref or path to adorn." },
                position: { type: "array", items: { type: "number" }, description: "World [x,y,z] if no target." },
                text: { type: "string", description: "Label text." },
                color: { type: "string", description: "Text color 'r,g,b' (default 255,255,255)." },
                offsetY: { type: "number", description: "Vertical offset in studs (default 2)." },
              },
              required: ["text"],
            },
          },
          clear: { type: "boolean", description: "Clear existing labels first (default true)." },
          duration: { type: "number", description: "Auto-clear ALL debug viz after N seconds." },
        },
        required: ["labels"],
      },
    },
    (args) => `
local a = __MCP.decode(${luaJson(args)})
local Workspace = game:GetService("Workspace")
local function getDbg()
  local f = Workspace:FindFirstChild("_CubesMCPDebug")
  if not f then f = Instance.new("Folder"); f.Name = "_CubesMCPDebug"; f.Archivable = false; f.Parent = Workspace end
  return f
end
local folder = getDbg()
if a.clear ~= false then
  for _, c in ipairs(folder:GetChildren()) do
    if c:IsA("BillboardGui") or (c:IsA("Part") and c.Name == "_DebugLabelAnchor") then c:Destroy() end
  end
end
local placed = 0
for _, spec in ipairs(a.labels or {}) do
  local r, g, b = 255, 255, 255
  if type(spec.color) == "string" then
    local rt, gt, bt = string.match(spec.color, "(%d+)%D+(%d+)%D+(%d+)")
    if rt then r, g, b = tonumber(rt), tonumber(gt), tonumber(bt) end
  end
  local offsetY = tonumber(spec.offsetY) or 2
  local bb = Instance.new("BillboardGui")
  bb.Size = UDim2.new(0, 220, 0, 36)
  bb.StudsOffset = Vector3.new(0, offsetY, 0)
  bb.AlwaysOnTop = true
  bb.LightInfluence = 0
  local label = Instance.new("TextLabel")
  label.Size = UDim2.new(1, 0, 1, 0)
  label.BackgroundColor3 = Color3.fromRGB(20, 20, 24)
  label.BackgroundTransparency = 0.25
  label.BorderSizePixel = 0
  label.Text = tostring(spec.text or "")
  label.TextColor3 = Color3.fromRGB(r, g, b)
  label.TextScaled = true
  label.Font = Enum.Font.GothamBold
  label.Parent = bb
  local corner = Instance.new("UICorner")
  corner.CornerRadius = UDim.new(0, 6)
  corner.Parent = label
  local padding = Instance.new("UIPadding")
  padding.PaddingLeft = UDim.new(0, 6); padding.PaddingRight = UDim.new(0, 6)
  padding.Parent = label
  if spec.target then
    local inst = __MCP.resolve(spec.target)
    if inst then bb.Adornee = inst; bb.Parent = folder; placed += 1 end
  elseif type(spec.position) == "table" then
    local anchor = Instance.new("Part")
    anchor.Name = "_DebugLabelAnchor"
    anchor.Size = Vector3.new(0.2, 0.2, 0.2)
    anchor.Transparency = 1
    anchor.Anchored = true; anchor.CanCollide = false; anchor.CanQuery = false; anchor.CanTouch = false
    anchor.Position = Vector3.new(spec.position[1] or 0, spec.position[2] or 0, spec.position[3] or 0)
    anchor.Parent = folder
    bb.Adornee = anchor; bb.Parent = anchor; placed += 1
  end
end
local dur = tonumber(a.duration)
if dur and dur > 0 then
  task.delay(dur, function() if folder.Parent then folder:Destroy() end end)
end
return { placed = placed }
`,
  ),

  evalTool(
    {
      name: "debug_axes",
      category: "debug",
      subcategories: ["visualize", "orientation"],
      keywords: ["axes", "axis", "xyz", "orientation", "direction", "arrow", "gizmo", "debug"],
      description:
        "Draw X/Y/Z axis indicators (red/green/blue) at an instance's pivot or a world position. Helps the agent ground itself spatially in screenshots. Length defaults to 4 studs.",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", description: "Ref or path; axes appear at its pivot. Alternative to `position`." },
          position: { type: "array", items: { type: "number" }, description: "World [x,y,z] origin if no target." },
          length: { type: "number", description: "Axis length in studs (default 4)." },
          thickness: { type: "number", description: "Axis thickness in studs (default 0.15)." },
          clear: { type: "boolean", description: "Clear existing axes first (default true)." },
          duration: { type: "number", description: "Auto-clear ALL debug viz after N seconds." },
        },
      },
    },
    (args) => `
local a = __MCP.decode(${luaJson(args)})
local Workspace = game:GetService("Workspace")
local function getDbg()
  local f = Workspace:FindFirstChild("_CubesMCPDebug")
  if not f then f = Instance.new("Folder"); f.Name = "_CubesMCPDebug"; f.Archivable = false; f.Parent = Workspace end
  return f
end
local folder = getDbg()
if a.clear ~= false then
  for _, c in ipairs(folder:GetChildren()) do
    if c:IsA("Model") and c.Name == "_DebugAxes" then c:Destroy() end
  end
end
local origin
if a.target then
  local inst = __MCP.resolve(a.target)
  if not inst then return { error = "not_found", target = a.target } end
  if inst:IsA("Model") then
    local ok, pivot = pcall(function() return inst:GetPivot().Position end)
    origin = ok and pivot or nil
  elseif inst:IsA("BasePart") then
    origin = inst.Position
  end
  if not origin then return { error = "no_origin", target = a.target } end
elseif type(a.position) == "table" then
  origin = Vector3.new(a.position[1] or 0, a.position[2] or 0, a.position[3] or 0)
else
  origin = Vector3.zero
end
local length = tonumber(a.length) or 4
local thickness = tonumber(a.thickness) or 0.15
local group = Instance.new("Model")
group.Name = "_DebugAxes"
group.Parent = folder
local function arrow(name, dir, color)
  local part = Instance.new("Part")
  part.Name = name
  part.Anchored = true; part.CanCollide = false; part.CanQuery = false; part.CanTouch = false
  part.Material = Enum.Material.Neon
  part.Color = color
  local half = length / 2
  part.Size = Vector3.new(
    math.max(thickness, math.abs(dir.X) * length),
    math.max(thickness, math.abs(dir.Y) * length),
    math.max(thickness, math.abs(dir.Z) * length)
  )
  part.Position = origin + dir * half
  part.Parent = group
end
arrow("X", Vector3.new(1, 0, 0), Color3.fromRGB(230, 80, 80))
arrow("Y", Vector3.new(0, 1, 0), Color3.fromRGB(80, 220, 120))
arrow("Z", Vector3.new(0, 0, 1), Color3.fromRGB(90, 150, 235))
local dur = tonumber(a.duration)
if dur and dur > 0 then
  task.delay(dur, function() if folder.Parent then folder:Destroy() end end)
end
return { at = { origin.X, origin.Y, origin.Z }, length = length }
`,
  ),

  evalTool(
    {
      name: "debug_clear",
      category: "debug",
      subcategories: ["visualize", "cleanup"],
      keywords: ["clear", "wipe", "reset", "remove", "cleanup", "debug"],
      description:
        "Remove all debug visualizations (highlights, bounds, labels, axes) — destroys the Workspace._CubesMCPDebug folder atomically. Idempotent.",
      inputSchema: { type: "object", properties: {} },
    },
    () => `
local f = workspace:FindFirstChild("_CubesMCPDebug")
if f then f:Destroy() ; return { cleared = true } end
return { cleared = false, note = "no debug folder present" }
`,
  ),

  evalTool(
    {
      name: "script_read",
      category: "scripts",
      subcategories: ["source", "inspect"],
      keywords: ["read", "source", "view", "get", "show", "print", "open", "content", "code"],
      write: false,
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

  // ---- session memory -----------------------------------------------------
  // Persistent per-place memory (genre, style, decisions, naming conventions,
  // known issues, session summaries). Lives at ~/.cubesmcp/profiles/{placeId}.json.
  // Read the current profile via the `studio://project/profile` resource; write
  // through this tool. Designed so the agent doesn't read+rewrite the whole file
  // — each call is an upsert (style/structure shallow-merge, decision/issue/
  // session-summary append). Eliminates the cold-start problem across sessions.
  {
    name: "profile_update",
    category: "session",
    subcategories: ["memory", "profile", "decision", "convention"],
    keywords: [
      "profile",
      "remember",
      "memory",
      "decision",
      "convention",
      "style",
      "genre",
      "save",
      "note",
      "context",
      "persist",
      "learn",
    ],
    write: false, // writes a server-side JSON file, not the DataModel
    description:
      "Update the persistent per-place profile (~/.cubesmcp/profiles/{placeId}.json). Each field is an upsert: `genre`/`placeName`/`style`/`structure` shallow-merge; `decision`/`knownIssue`/`sessionSummary` append. Use this to record style decisions ('we chose elongated balls for ears, not WedgePart'), conventions ('models live under Workspace.Entities'), and per-session takeaways so the NEXT session opens with the project context already loaded.",
    inputSchema: {
      type: "object",
      properties: {
        genre: {
          type: "string",
          description:
            "Set/replace the detected genre: 'obby' | 'simulator' | 'rpg' | 'racing' | 'tower_defense' | 'casual_sim' | 'social' | 'experimental' | 'unknown'.",
        },
        placeName: { type: "string", description: "Set/replace the place name." },
        style: {
          type: "object",
          description:
            "Shallow-merge into profile.style. Keys: palette (array of color strings), materials (array), naming (string), notes (string).",
        },
        structure: {
          type: "object",
          description:
            "Shallow-merge into profile.structure. Free-form key/value (e.g. modelRoot='Workspace.Entities').",
        },
        decision: {
          type: "object",
          description: "Append to decisions log. { topic, choice }.",
          properties: {
            topic: { type: "string" },
            choice: { type: "string" },
          },
          required: ["topic", "choice"],
        },
        knownIssue: { type: "string", description: "Append to knownIssues." },
        sessionSummary: {
          type: "object",
          description:
            "Append to sessionLog. { session, summary }. Use at the end of a session to leave breadcrumbs for next time.",
          properties: {
            session: { type: "string" },
            summary: { type: "string" },
          },
          required: ["session", "summary"],
        },
      },
    },
    handler: async (args, ctx) => {
      const ctxData = await ctx.getPlaceContext();
      const profile = await loadProfile(ctxData.placeId, ctxData.placeName);
      const patch: ProfilePatch = {
        genre: typeof args.genre === "string" ? args.genre : undefined,
        placeName: typeof args.placeName === "string" ? args.placeName : undefined,
        style:
          args.style && typeof args.style === "object"
            ? (args.style as ProfilePatch["style"])
            : undefined,
        structure:
          args.structure && typeof args.structure === "object"
            ? (args.structure as ProfilePatch["structure"])
            : undefined,
        decision:
          args.decision && typeof args.decision === "object"
            ? (args.decision as ProfilePatch["decision"])
            : undefined,
        knownIssue:
          typeof args.knownIssue === "string" ? args.knownIssue : undefined,
        sessionSummary:
          args.sessionSummary && typeof args.sessionSummary === "object"
            ? (args.sessionSummary as ProfilePatch["sessionSummary"])
            : undefined,
      };
      applyPatch(profile, patch);
      await saveProfile(profile);
      return {
        ok: true,
        placeId: profile.placeId,
        updatedAt: profile.updatedAt,
        decisionsCount: profile.decisions.length,
        sessionLogCount: profile.sessionLog.length,
        hint: "Read studio://project/profile to see the updated profile.",
      };
    },
  },
  {
    name: "macro_save",
    category: "session",
    subcategories: ["macro", "record"],
    keywords: ["macro", "record", "save", "sequence", "replay", "reuse", "automate", "memory"],
    write: false,
    description:
      "Save a reusable macro. Either captures the mutate ops from the last N history entries (from_last) or takes an explicit ops array. Replay with macro_run. Note: only direct `mutate` ops are captured, not specialist-tool calls.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Macro name." },
        from_last: {
          type: "number",
          description: "Capture mutate ops from the last N history entries (default 10).",
        },
        ops: {
          type: "array",
          items: { type: "object" },
          description: "Explicit ops to save (alternative to from_last).",
        },
      },
      required: ["name"],
    },
    handler: async (args, ctx) => {
      const name = String(args.name ?? "").trim();
      if (!name) return { error: "bad_args", hint: "macro_save needs a 'name'." };
      const ops = Array.isArray(args.ops)
        ? (args.ops as unknown[])
        : ctx.memory.opsFromHistory(typeof args.from_last === "number" ? args.from_last : 10);
      if (ops.length === 0) {
        return {
          error: "empty_macro",
          hint: "No mutate ops to save — pass `ops` explicitly, or run some mutate calls first then use from_last.",
        };
      }
      const macro = ctx.memory.saveMacro(name, ops);
      return { saved: macro.name, opCount: macro.opCount, hint: `Replay with macro_run({ name: "${name}" }).` };
    },
  },
  {
    name: "macro_run",
    category: "session",
    subcategories: ["macro", "replay"],
    keywords: ["macro", "run", "replay", "execute", "repeat", "reuse", "memory"],
    write: true,
    description:
      "Replay a saved macro — re-submits its ops as one atomic mutate batch (single undo waypoint). Lint results come back under the nested mutate result, same as a normal mutate.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Macro name to run." },
        confirm: {
          type: "boolean",
          description:
            "Required when the saved macro's ops are destructive (deletes / Source overwrites). Forwarded to the underlying mutate pipeline.",
        },
      },
      required: ["name"],
    },
    handler: async (args, ctx) => {
      const name = String(args.name ?? "").trim();
      const macro = ctx.memory.getMacro(name);
      if (!macro) {
        return {
          error: "macro_not_found",
          name,
          hint: "Check the studio://session/macros resource.",
        };
      }
      // Route through handleMutate so the macro's ops hit the same
      // destructiveness gate + script-source lint as a normal mutate call.
      // Calling bridge.send("mutate", ...) directly would let a saved macro with
      // a delete op or Source overwrite execute without confirm: true.
      const result = await ctx.handleMutate({ ops: macro.ops, confirm: args.confirm === true });
      return { ran: name, opCount: macro.opCount, result };
    },
  },
  evalTool(
    {
      name: "history_undo",
      category: "session",
      subcategories: ["undo", "history", "revert"],
      keywords: ["undo", "revert", "rollback", "back", "reverse", "oops", "mistake", "wrong"],
      write: true,
      description:
        "Undo the last N ChangeHistoryService waypoints. Every MCP mutate call creates its own named waypoint, so this reliably reverses MCP-driven changes. n defaults to 1.",
      inputSchema: {
        type: "object",
        properties: {
          n: { type: "number", description: "Number of waypoints to undo (default 1, max 20)." },
        },
      },
    },
    (args) => `
local a = __MCP.decode(${luaJson(args)})
local n = math.min(math.max(tonumber(a.n) or 1, 1), 20)
local CHS = game:GetService("ChangeHistoryService")
local undone = 0
for _ = 1, n do
  local ok = pcall(function() CHS:Undo() end)
  if ok then undone += 1 else break end
end
return { undone = undone, requested = n }
`,
  ),

  // ---- snapshot / diff: DataModel version control -------------------------
  // snapshot captures a subtree and stores it SERVER-SIDE (SessionMemory),
  // returning only a tiny summary. diff compares two stored captures (or a
  // stored capture against a fresh "live" one) and returns a structured delta
  // ONLY — never a full tree. This is the token-thrift contract: the capture
  // can be large, but it lives on the server; what crosses the wire to the
  // agent is a summary (snapshot) or a delta (diff).
  {
    name: "snapshot",
    category: "session",
    subcategories: ["version-control", "capture", "checkpoint"],
    keywords: [
      "snapshot",
      "capture",
      "checkpoint",
      "save state",
      "baseline",
      "version",
      "before",
      "record state",
    ],
    write: false,
    description:
      "Capture the current state of a subtree (a stable identity, ClassName, and projected properties per instance) and store it server-side under `name`. Returns only a small summary — NOT the captured tree. Pair with `diff` to see exactly what changed later. The capture lives in session memory (bounded; oldest evicted).",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Key to store this snapshot under. Re-using a name overwrites it.",
        },
        path: {
          type: "string",
          description:
            "Subtree root to capture — a ref or dotted path, e.g. 'Workspace' or 'Workspace.Level'. Required: capturing the whole DataModel is intentionally not the default (too heavy).",
        },
      },
      required: ["name", "path"],
    },
    handler: async (args, ctx) => {
      const name = String(args.name ?? "").trim();
      if (!name) return { error: "bad_args", hint: "snapshot needs a non-empty 'name'." };
      const path = String(args.path ?? "").trim();
      if (!path) {
        return {
          error: "bad_args",
          hint: "snapshot needs a 'path' (a ref or dotted path). Capturing the whole DataModel is not supported — pick a subtree, e.g. 'Workspace'.",
        };
      }
      const capture = (await ctx.bridge.send("snapshot", { path })) as
        | {
            path?: string;
            instances?: SnapshotInstance[];
            instanceCount?: number;
            truncated?: boolean;
            capLimit?: number;
          }
        | undefined;
      if (capture && typeof capture === "object" && "error" in capture) {
        return capture;
      }
      const instances = Array.isArray(capture?.instances) ? capture!.instances : [];
      const truncated = capture?.truncated === true;
      const stored = ctx.memory.saveSnapshot(name, {
        path: capture?.path ?? path,
        instances,
        truncated,
      });
      return {
        name: stored.name,
        path: stored.path,
        instanceCount: stored.instanceCount,
        capturedAt: stored.capturedAt,
        ...(truncated
          ? {
              truncated: true,
              note: `Subtree exceeded the ${capture?.capLimit ?? "capture"} instance cap — snapshot is partial. Snapshot a smaller subtree for a complete capture.`,
            }
          : {}),
        hint: `Compare later with diff({ from: "${name}", to: "live" }), or against another snapshot.`,
      };
    },
  },
  {
    name: "diff",
    category: "session",
    subcategories: ["version-control", "compare", "delta"],
    keywords: [
      "diff",
      "compare",
      "delta",
      "changed",
      "what changed",
      "difference",
      "drift",
      "since",
      "version",
    ],
    write: false,
    description:
      "Compare two snapshots and return a structured DELTA ONLY: { added, removed, changed }. `from` and `to` are snapshot names; `to` may instead be the literal 'live' to diff against a fresh capture of the current DataModel at the `from` snapshot's path. Never returns full trees — only the instances/properties that differ.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Baseline snapshot name." },
        to: {
          type: "string",
          description:
            "Later snapshot name, OR the literal 'live' to capture the DataModel now at the `from` snapshot's path and diff against that.",
        },
      },
      required: ["from", "to"],
    },
    handler: async (args, ctx) => {
      const fromName = String(args.from ?? "").trim();
      const toArg = String(args.to ?? "").trim();
      if (!fromName || !toArg) {
        return { error: "bad_args", hint: "diff needs 'from' and 'to'." };
      }
      const fromSnap = ctx.memory.getSnapshot(fromName);
      if (!fromSnap) {
        return {
          error: "snapshot_not_found",
          name: fromName,
          hint: "Take it first with snapshot(), or check the studio://session/snapshots resource.",
        };
      }

      let toInstances: SnapshotInstance[];
      let toLabel: string;
      let liveTruncated = false;
      if (toArg === "live") {
        // Fresh capture at the baseline's path — no need to store it.
        const capture = (await ctx.bridge.send("snapshot", { path: fromSnap.path })) as
          | { instances?: SnapshotInstance[]; truncated?: boolean }
          | undefined;
        if (capture && typeof capture === "object" && "error" in capture) {
          return capture;
        }
        toInstances = Array.isArray(capture?.instances) ? capture!.instances : [];
        liveTruncated = capture?.truncated === true;
        toLabel = `live@${fromSnap.path}`;
      } else {
        const toSnap = ctx.memory.getSnapshot(toArg);
        if (!toSnap) {
          return {
            error: "snapshot_not_found",
            name: toArg,
            hint: "Pass an existing snapshot name, or the literal 'live'.",
          };
        }
        toInstances = toSnap.instances;
        toLabel = toSnap.name;
      }

      const delta = diffSnapshots(fromSnap.instances, toInstances);
      return {
        from: fromSnap.name,
        to: toLabel,
        path: fromSnap.path,
        added: delta.added,
        removed: delta.removed,
        changed: delta.changed,
        summary: {
          added: delta.added.length,
          removed: delta.removed.length,
          changed: delta.changed.length,
        },
        ...(fromSnap.truncated || liveTruncated
          ? { partial: true, note: "One side of the diff was a truncated capture — the delta may be incomplete." }
          : {}),
      };
    },
  },

  // ---- playtest -----------------------------------------------------------
  evalTool(
    {
      name: "test_run",
      category: "playtest",
      subcategories: ["testez", "tests", "verify"],
      keywords: ["test", "testez", "unit test", "spec", "suite", "run tests", "verify", "regression"],
      write: false,
      description:
        "Run a TestEZ suite and return structured pass/fail counts + failures. Finds TestEZ automatically (ReplicatedStorage / ServerScriptService / ServerStorage) or takes an explicit testezPath. Closes the loop on 'did my change break anything'.",
      inputSchema: {
        type: "object",
        properties: {
          suite: {
            type: "string",
            description: "Ref or path of the test root (a folder/instance containing *.spec ModuleScripts).",
          },
          testezPath: {
            type: "string",
            description: "Optional ref/path of the TestEZ ModuleScript, if it isn't auto-found.",
          },
        },
        required: ["suite"],
      },
    },
    (args) => `
local a = __MCP.decode(${luaJson(args)})
local testez
if a.testezPath then
  testez = __MCP.resolve(a.testezPath)
else
  for _, svcName in ipairs({ "ReplicatedStorage", "ServerScriptService", "ServerStorage" }) do
    local ok, svc = pcall(game.GetService, game, svcName)
    if ok and svc then
      local found = svc:FindFirstChild("TestEZ", true)
      if found and found:IsA("ModuleScript") then testez = found break end
    end
  end
end
if not testez then
  return { error = "testez_not_found", hint = "Install TestEZ as a ModuleScript (e.g. in ReplicatedStorage) or pass testezPath." }
end
local suite = __MCP.resolve(a.suite)
if not suite then return { error = "not_found", suite = a.suite } end
local okReq, TestEZ = pcall(require, testez)
if not okReq then return { error = "testez_require_failed", message = tostring(TestEZ) } end
local results
local okRun, err = pcall(function()
  results = TestEZ.TestBootstrap:run({ suite }, TestEZ.Reporters and TestEZ.Reporters.TextReporter or nil)
end)
if not okRun then return { error = "test_run_failed", message = tostring(err) } end
return {
  ran = true,
  suite = suite:GetFullName(),
  successCount = results and results.successCount or nil,
  failureCount = results and results.failureCount or nil,
  skippedCount = results and results.skippedCount or nil,
  errors = results and results.errors or nil,
}
`,
  ),

  dispatchTool(
    {
      name: "playtest_play",
      category: "playtest",
      subcategories: ["lifecycle", "simulate"],
      keywords: ["playtest", "play", "solo", "start", "simulate", "player"],
      write: true,
      description:
        "Start Play Solo (StudioTestService:ExecutePlayModeAsync). Plugin stays connected — drive player via character_* tools during the session. Temporarily flips ServerScriptService.LoadStringEnabled to true so eval-based tools work in the play DM; restores the original value when play ends (`loadStringFlipped: true` in the response if it was changed).",
      inputSchema: {
        type: "object",
        properties: {
          testArgs: { description: "Optional value passed to StudioTestService:GetTestArgs() inside the session." },
        },
      },
    },
    "playtest_play",
  ),

  dispatchTool(
    {
      name: "playtest_run_mode",
      category: "playtest",
      subcategories: ["lifecycle", "simulate"],
      keywords: ["playtest", "run", "mode", "server", "simulate"],
      write: true,
      description:
        "Start Run mode (StudioTestService:ExecuteRunModeAsync). Server scripts execute, no Player.",
      inputSchema: {
        type: "object",
        properties: {
          testArgs: { description: "Optional value passed to StudioTestService:GetTestArgs() inside the session." },
        },
      },
    },
    "playtest_run_mode",
  ),

  dispatchTool(
    {
      name: "playtest_stop",
      category: "playtest",
      subcategories: ["lifecycle", "simulate"],
      keywords: ["playtest", "run", "test", "stop", "halt", "end"],
      write: true,
      description:
        "End the current StudioTestService session (calls EndTest). Falls back to RunService:Stop for legacy starts. Idempotent.",
      inputSchema: {
        type: "object",
        properties: {
          reason: { type: "string", description: "EndTest result string (default 'stopped_by_mcp')." },
        },
      },
    },
    "playtest_stop",
  ),

  dispatchTool(
    {
      name: "playtest_result",
      category: "playtest",
      subcategories: ["lifecycle", "introspect"],
      keywords: ["playtest", "result", "status", "state", "endtest"],
      write: false,
      description:
        "Read the current playtest state and the last EndTest result (cleared on each new playtest).",
      inputSchema: { type: "object", properties: {} },
    },
    "playtest_result",
  ),

  dispatchTool(
    {
      name: "playtest_set_players",
      category: "playtest",
      subcategories: ["lifecycle", "configure"],
      keywords: ["playtest", "players", "numberofplayers", "multi", "clients"],
      write: true,
      description:
        "Set TestService.NumberOfPlayers before starting a play session. Multi-client testing.",
      inputSchema: {
        type: "object",
        properties: {
          count: { type: "number", description: "Number of local players (1-8)." },
        },
        required: ["count"],
      },
    },
    "playtest_set_players",
  ),

  evalTool(
    {
      name: "playtest_status",
      category: "playtest",
      subcategories: ["lifecycle", "introspect"],
      keywords: ["playtest", "run", "test", "status", "state", "mode", "running"],
      write: false,
      description: "Report current RunService state: running flags, server/client, edit/run/playtest mode.",
      inputSchema: { type: "object", properties: {} },
    },
    () => `
local RunService = game:GetService("RunService")
local isRunning = RunService:IsRunning()
local isClient = RunService:IsClient()
local isServer = RunService:IsServer()
local isEdit = RunService:IsEdit()
local isStudio = RunService:IsStudio()
local mode
if not isRunning then
  mode = "edit"
elseif isClient and not isServer then
  mode = "playtest-client"
elseif isServer and isClient then
  mode = "playtest-server"
else
  mode = "run"
end
return {
  isRunning = isRunning,
  isClient = isClient,
  isServer = isServer,
  isEdit = isEdit,
  isStudio = isStudio,
  mode = mode,
  timestamp = os.time(),
}
`,
  ),

  // tune: run_code, but inside the LIVE playtest server instead of the edit DM.
  // run_code/eval execute in the plugin's edit-DataModel context; during Play
  // Solo the real game runs in a separate play DM. tune ships the Luau over the
  // PlaytestBus to the play-DM bootstrap, which loadstrings + runs it in the
  // running server context — so the agent can tweak live values mid-playtest
  // (gravity, a player's WalkSpeed, enemy stats) and see the effect at once.
  // Built inline (not dispatchTool) so a success wraps in { result } exactly
  // like run_code — same envelope, same { __void = true } for a nil return.
  {
    name: "tune",
    category: "playtest",
    subcategories: ["live", "eval", "tweak"],
    keywords: ["tune", "live", "eval", "playtest", "tweak", "gravity", "walkspeed", "stats", "mid-run", "hotfix"],
    write: true,
    description:
      "Run arbitrary Luau inside the RUNNING playtest's server DataModel — the live game, not the edit place. Use to tweak values mid-playtest (workspace.Gravity, a player's Humanoid.WalkSpeed/JumpPower, enemy stats) and see the effect immediately. `return <value>` sends data back as JSON (a nil return comes back as { __void = true }). Requires a playtest to be running (start one with playtest_play); errors with `no_playtest` otherwise. This is the live-game counterpart to run_code, which runs in the edit DM.",
    inputSchema: {
      type: "object",
      properties: {
        luau: { type: "string", description: "Luau source to run in the live play-DM server. Use 'return <value>' to return data." },
      },
      required: ["luau"],
    },
    handler: async (args, ctx) => {
      const luau = (args ?? {}).luau;
      if (typeof luau !== "string" || luau.trim() === "") {
        return { error: "bad_args", hint: "tune requires a non-empty 'luau' string." };
      }
      const result = await ctx.bridge.send("tune", { luau });
      return { result };
    },
  },

  // ---- playtest helpers --------------------------------------------------
  dispatchTool(
    {
      name: "players_state",
      category: "playtest",
      subcategories: ["players", "state", "introspect"],
      keywords: ["players", "list", "who", "online", "roster"],
      write: false,
      description: "List every Player with character/position/health/walk stats. Empty array in edit mode.",
      inputSchema: { type: "object", properties: {} },
    },
    "players_state",
  ),

  dispatchTool(
    {
      name: "character_state",
      category: "playtest",
      subcategories: ["players", "character", "introspect"],
      keywords: ["character", "humanoid", "health", "position", "state"],
      write: false,
      description: "Snapshot a character's position/velocity/humanoid stats. Defaults to first player's character.",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Ref or path of the character model (optional)." },
          player: { type: "string", description: "Player UserId or Name (optional; first player default)." },
        },
      },
    },
    "character_state",
  ),

  evalTool(
    {
      name: "stats_snapshot",
      category: "playtest",
      subcategories: ["stats", "performance", "introspect"],
      keywords: ["stats", "fps", "memory", "perf", "network"],
      write: false,
      description: "Tap the Stats service: heartbeat, physics, network kbps, memory MB, instance count.",
      inputSchema: { type: "object", properties: {} },
    },
    () => `
local Stats = game:GetService("Stats")
local function safe(fn)
  local ok, v = pcall(fn)
  if ok then return v end
  return nil
end
return {
  heartbeatRate = safe(function() return Stats.HeartbeatTimeItem:GetValue() end),
  physicsStepTime = safe(function() return Stats.PhysicsStepTimeItem:GetValue() end),
  dataRecvKbps = safe(function() return Stats.DataReceiveKbps:GetValue() end),
  dataSendKbps = safe(function() return Stats.DataSendKbps:GetValue() end),
  memoryMB = safe(function() return Stats:GetTotalMemoryUsageMb() end),
  instanceCount = safe(function() return Stats.InstanceCount end),
}
`,
  ),

  dispatchTool(
    {
      name: "character_teleport",
      category: "playtest",
      subcategories: ["players", "character", "control"],
      keywords: ["teleport", "move", "position", "warp", "tp"],
      write: true,
      description: "Teleport character to a literal position or to (target's position + Y offset). Player default: first.",
      inputSchema: {
        type: "object",
        properties: {
          position: { type: "array", items: { type: "number" }, description: "World [x,y,z]." },
          target: { type: "string", description: "Ref or path of an instance to teleport above (alt to position)." },
          player: { type: "string", description: "Player UserId or Name (optional; first player default)." },
        },
      },
    },
    "character_teleport",
  ),

  dispatchTool(
    {
      name: "character_walk",
      category: "playtest",
      subcategories: ["players", "character", "control"],
      keywords: ["walk", "move", "humanoid", "direction"],
      write: true,
      description: "Humanoid:Move in a direction for N seconds (cap 10). YIELDS. Player default: first.",
      inputSchema: {
        type: "object",
        properties: {
          direction: { type: "array", items: { type: "number" }, description: "World [x,y,z] move dir." },
          duration: { type: "number", description: "Seconds to walk (default 1, max 10)." },
          player: { type: "string", description: "Player UserId or Name (optional; first player default)." },
        },
        required: ["direction"],
      },
    },
    "character_walk",
  ),

  dispatchTool(
    {
      name: "character_jump",
      category: "playtest",
      subcategories: ["players", "character", "control"],
      keywords: ["jump", "hop", "humanoid"],
      write: true,
      description: "Force Humanoid into Jumping state. Player default: first player.",
      inputSchema: {
        type: "object",
        properties: {
          player: { type: "string", description: "Player UserId or Name (optional; first player default)." },
        },
      },
    },
    "character_jump",
  ),

  dispatchTool(
    {
      name: "character_set",
      category: "playtest",
      subcategories: ["players", "character", "control"],
      keywords: ["humanoid", "set", "walkspeed", "jumppower", "health", "tweak"],
      write: true,
      description: "Set selected Humanoid fields (walkSpeed/jumpPower/etc). Player default: first.",
      inputSchema: {
        type: "object",
        properties: {
          walkSpeed: { type: "number" },
          jumpPower: { type: "number" },
          jumpHeight: { type: "number" },
          maxHealth: { type: "number" },
          health: { type: "number" },
          autoRotate: { type: "boolean" },
          hipHeight: { type: "number" },
          player: { type: "string", description: "Player UserId or Name (optional; first player default)." },
        },
      },
    },
    "character_set",
  ),

  dispatchTool(
    {
      name: "character_respawn",
      category: "playtest",
      subcategories: ["players", "character", "control"],
      keywords: ["respawn", "reload", "loadcharacter", "reset"],
      write: true,
      description: "Calls Player:LoadCharacter and waits for the new character. YIELDS up to ~5s.",
      inputSchema: {
        type: "object",
        properties: {
          player: { type: "string", description: "Player UserId or Name (optional; first player default)." },
        },
      },
    },
    "character_respawn",
  ),

  evalTool(
    {
      name: "logs_tail",
      category: "playtest",
      subcategories: ["logs", "diagnostics", "introspect"],
      keywords: ["logs", "tail", "errors", "warnings", "output"],
      write: false,
      description: "Recent N diagnostics entries with a position cursor — pass back `since: <last cursor>` to fetch only new entries.",
      inputSchema: {
        type: "object",
        properties: {
          since: { type: "number", description: "Last position seen (entries with position > since are new)." },
          limit: { type: "number", description: "Max entries (default 50)." },
        },
      },
    },
    (args) => `
local a = __MCP.decode(${luaJson(args)})
local limit = tonumber(a.limit) or 50
local since = tonumber(a.since) or 0
local recent = __MCP.diagnostics(limit)
local total = recent.totalCaptured or 0
local errors = recent.errors or {}
local startPos = total - #errors + 1
local out = {}
local maxPos = since
for i, entry in ipairs(errors) do
  local pos = startPos + i - 1
  if pos > since then
    local copy = {}
    for k, v in pairs(entry) do copy[k] = v end
    copy.position = pos
    out[#out + 1] = copy
    if pos > maxPos then maxPos = pos end
  end
end
return {
  entries = out,
  count = #out,
  cursor = maxPos,
  totalCaptured = total,
  runMode = recent.runMode,
}
`,
  ),

  evalTool(
    {
      name: "logs_wait_for",
      category: "playtest",
      subcategories: ["logs", "diagnostics", "wait"],
      keywords: ["wait", "log", "pattern", "match", "expect", "watch"],
      write: false,
      description: "Poll Diagnostics every 100ms for a Lua-pattern match. YIELDS up to timeout (cap 25s).",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Lua pattern (not regex)." },
          timeout: { type: "number", description: "Seconds (default 5, max 25)." },
          severity: { type: "string", description: "Filter by entry kind: error/warning/script_error." },
        },
        required: ["pattern"],
      },
    },
    (args) => `
local a = __MCP.decode(${luaJson(args)})
if not a.pattern or a.pattern == "" then
  return { error = "bad_args", hint = "pattern is required." }
end
local timeout = math.min(math.max(tonumber(a.timeout) or 5, 0), 25)
local severity = a.severity
local startTotal = (__MCP.diagnostics(1).totalCaptured) or 0
local deadline = os.clock() + timeout
while true do
  local recent = __MCP.diagnostics(150)
  local total = recent.totalCaptured or 0
  local errors = recent.errors or {}
  local startPos = total - #errors + 1
  for i, entry in ipairs(errors) do
    local pos = startPos + i - 1
    if pos > startTotal then
      if (not severity) or entry.kind == severity then
        local msg = tostring(entry.message or "")
        local ok, found = pcall(string.find, msg, a.pattern)
        if ok and found then
          local copy = {}
          for k, v in pairs(entry) do copy[k] = v end
          copy.position = pos
          return { matched = true, entry = copy }
        end
      end
    end
  end
  if os.clock() >= deadline then
    return { matched = false, timedOut = true }
  end
  task.wait(0.1)
end
`,
  ),

  evalTool(
    {
      name: "debug_error",
      category: "debug",
      subcategories: ["errors", "diagnostics", "context"],
      keywords: ["error", "crash", "stack", "debug", "fix", "exception", "traceback", "broken"],
      write: false,
      description:
        "Most recent runtime error with ±N source lines around the failure point + call stack + recent prior errors. One call instead of tail-logs → parse → read-source.",
      inputSchema: {
        type: "object",
        properties: {
          context: {
            type: "number",
            description: "Lines of source to show before and after the error line (default 15, max 50).",
          },
          n: {
            type: "number",
            description: "Look back through the last N diagnostic entries (default 150).",
          },
          scriptRef: {
            type: "string",
            description: "Optional ref or path of a specific script — skips error search and reads source context around `line`.",
          },
          line: {
            type: "number",
            description: "Line number when used with scriptRef.",
          },
        },
      },
    },
    (args) => `
local a = __MCP.decode(${luaJson(args)})
local contextLines = math.min(math.max(tonumber(a.context) or 15, 3), 50)
local n = math.min(math.max(tonumber(a.n) or 150, 10), 150)

local function readSourceContext(inst, errorLine)
  if not inst or not inst:IsA("LuaSourceContainer") then return nil end
  local source = inst.Source
  if not source then return nil end
  local lines = {}
  for line in string.gmatch(source .. "\\n", "([^\\n]*)\\n") do
    lines[#lines + 1] = line
  end
  local startL = math.max(1, errorLine - contextLines)
  local endL = math.min(#lines, errorLine + contextLines)
  local ctx = {}
  for i = startL, endL do
    ctx[#ctx + 1] = { n = i, code = lines[i], isError = (i == errorLine) }
  end
  return { lines = ctx, totalLines = #lines, startLine = startL, endLine = endL }
end

-- Direct mode: scriptRef + line skips error search entirely.
if a.scriptRef and a.line then
  local inst = __MCP.resolve(a.scriptRef)
  if not inst then return { error = "not_found", ref = a.scriptRef } end
  local ctx = readSourceContext(inst, tonumber(a.line))
  if not ctx then return { error = "not_a_script", ref = a.scriptRef, class = inst.ClassName } end
  return {
    mode = "direct",
    scriptPath = inst:GetFullName(),
    scriptRef = __MCP.refFor(inst),
    line = tonumber(a.line),
    sourceContext = ctx,
  }
end

-- Search mode: find the most recent error in diagnostics.
local recent = __MCP.diagnostics(n)
local entries = recent.errors or {}

-- Collect only error/script_error entries in arrival order.
local errorEntries = {}
for _, e in ipairs(entries) do
  if e.kind == "error" or e.kind == "script_error" then
    errorEntries[#errorEntries + 1] = e
  end
end

if #errorEntries == 0 then
  return { noErrors = true, runMode = recent.runMode, totalCaptured = recent.totalCaptured,
    hint = "No errors captured yet. Start a playtest and reproduce the crash, then call debug_error again." }
end

-- Prefer the most recent script_error (has stack + ref); fall back to most recent plain error.
local bestIdx = #errorEntries
for i = #errorEntries, 1, -1 do
  if errorEntries[i].kind == "script_error" then
    bestIdx = i
    break
  end
end
local best = errorEntries[bestIdx]

local result = {
  kind = best.kind,
  message = best.message,
  at = best.at,
  runMode = recent.runMode,
}
if best.stack then result.stack = best.stack end
if best.scriptPath then result.scriptPath = best.scriptPath end
if best.line then result.line = best.line end

-- Resolve the script instance and pull source context.
local inst = nil
if best.scriptRef then
  inst = __MCP.resolve(best.scriptRef)
end
if not inst and best.scriptPath then
  -- Diagnostics scriptPath is already the full path (e.g. "ServerScriptService.Foo")
  inst = __MCP.resolve(best.scriptPath)
end

if inst and best.line then
  local ctx = readSourceContext(inst, best.line)
  if ctx then
    result.sourceContext = ctx
    result.scriptRef = __MCP.refFor(inst)
    if not result.scriptPath then result.scriptPath = inst:GetFullName() end
  end
end

-- Up to 3 earlier errors for pattern context (in chronological order).
if bestIdx > 1 then
  local prior = {}
  for i = math.max(1, bestIdx - 3), bestIdx - 1 do
    local e = errorEntries[i]
    prior[#prior + 1] = { kind = e.kind, message = e.message, at = e.at, line = e.line, scriptPath = e.scriptPath }
  end
  if #prior > 0 then result.priorErrors = prior end
end

return result
`,
  ),

  evalTool(
    {
      name: "spawn_marker",
      category: "playtest",
      subcategories: ["debug", "visualize"],
      keywords: ["marker", "flag", "label", "pin", "debug", "visualize"],
      write: true,
      description: "Create a small floating part + BillboardGui label at a position. Anchored, non-colliding.",
      inputSchema: {
        type: "object",
        properties: {
          position: { type: "array", items: { type: "number" }, description: "World [x,y,z]." },
          name: { type: "string", description: "Marker name + label text (default 'Marker')." },
          color: { type: "array", items: { type: "number" }, description: "Color [r,g,b] 0-255." },
        },
        required: ["position"],
      },
    },
    (args) => `
local a = __MCP.decode(${luaJson(args)})
if not a.position then return { error = "bad_args", hint = "position is required." } end
local name = tostring(a.name or "Marker")
local r, g, b = 255, 230, 80
if a.color then
  r = tonumber(a.color[1]) or r
  g = tonumber(a.color[2]) or g
  b = tonumber(a.color[3]) or b
end
local CHS = game:GetService("ChangeHistoryService")
local rec = CHS:TryBeginRecording("Cubes MCP: spawn_marker")
local part = Instance.new("Part")
part.Name = name
part.Size = Vector3.new(1, 1, 1)
part.Anchored = true
part.CanCollide = false
part.CanQuery = false
part.CanTouch = false
part.Material = Enum.Material.Neon
part.Color = Color3.fromRGB(r, g, b)
part.Position = Vector3.new(a.position[1] or 0, a.position[2] or 0, a.position[3] or 0)
part.Parent = workspace
local bb = Instance.new("BillboardGui")
bb.Name = "MarkerLabel"
bb.Size = UDim2.new(0, 120, 0, 40)
bb.StudsOffset = Vector3.new(0, 2, 0)
bb.AlwaysOnTop = true
bb.Parent = part
local label = Instance.new("TextLabel")
label.Size = UDim2.new(1, 0, 1, 0)
label.BackgroundTransparency = 1
label.Text = name
label.TextColor3 = Color3.fromRGB(255, 255, 255)
label.TextStrokeTransparency = 0
label.TextScaled = true
label.Font = Enum.Font.GothamBold
label.Parent = bb
if rec then CHS:FinishRecording(rec, Enum.FinishRecordingOperation.Commit) end
return { ref = __MCP.refFor(part), name = name }
`,
  ),

  // ---- event watching ----------------------------------------------------
  dispatchTool(
    {
      name: "event_watch",
      category: "playtest",
      subcategories: ["events", "remote", "observe"],
      keywords: ["watch", "observe", "remoteevent", "bindable", "event", "fire", "remote"],
      write: false,
      description: "Watch an RBXScriptSignal on an instance. Returns watchId; drain with event_drain.",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", description: "Ref or path of the instance carrying the event." },
          eventName: { type: "string", description: "Signal name (e.g. 'OnServerEvent', 'Event', 'Changed'). Default 'Event'." },
          maxBuffer: { type: "number", description: "Max fires buffered between drains (default 100). Overflow tracked as `dropped`." },
        },
        required: ["target"],
      },
    },
    "event_watch",
  ),

  dispatchTool(
    {
      name: "event_drain",
      category: "playtest",
      subcategories: ["events", "remote", "observe"],
      keywords: ["drain", "events", "buffer", "flush", "collect"],
      write: false,
      description: "Drain buffered fires from an event_watch. Returns { events, count, dropped }.",
      inputSchema: {
        type: "object",
        properties: {
          watchId: { type: "number", description: "The watchId returned by event_watch." },
        },
        required: ["watchId"],
      },
    },
    "event_drain",
  ),

  dispatchTool(
    {
      name: "event_unwatch",
      category: "playtest",
      subcategories: ["events", "remote", "observe"],
      keywords: ["unwatch", "stop", "disconnect", "event"],
      write: false,
      description: "Stop a previously-started event_watch and free its connection.",
      inputSchema: {
        type: "object",
        properties: {
          watchId: { type: "number", description: "The watchId returned by event_watch." },
        },
        required: ["watchId"],
      },
    },
    "event_unwatch",
  ),

  evalTool(
    {
      name: "wait_until",
      category: "playtest",
      subcategories: ["wait", "predicate", "polling"],
      keywords: ["wait", "until", "predicate", "watch", "poll", "block"],
      write: false,
      description: "Block until a Luau predicate is truthy or timeout. Predicate has 'game' in scope.",
      inputSchema: {
        type: "object",
        properties: {
          predicate: { type: "string", description: "Lua expression evaluated each poll; truthy result ends the wait. e.g. 'workspace.Foo.Position.X > 50'" },
          timeout: { type: "number", description: "Max seconds to wait (default 5, capped 25)." },
          pollInterval: { type: "number", description: "Poll interval in seconds (default 0.1, min 0.05)." },
        },
        required: ["predicate"],
      },
    },
    (args) => `
local a = __MCP.decode(${luaJson(args)})
local timeout = math.min(a.timeout or 5, 25)
local interval = math.max(a.pollInterval or 0.1, 0.05)
local checkSrc = "return (" .. a.predicate .. ")"
local fn, err = loadstring(checkSrc)
if not fn then return { error = "compile_error", message = tostring(err) } end
local start = os.clock()
while (os.clock() - start) < timeout do
  local ok, result = pcall(fn)
  if ok and result then
    return { matched = true, elapsed = os.clock() - start, result = tostring(result) }
  end
  task.wait(interval)
end
return { matched = false, timedOut = true, elapsed = os.clock() - start }
`,
  ),

  evalTool(
    {
      name: "step_frames",
      category: "playtest",
      subcategories: ["wait", "frames", "advance"],
      keywords: ["frames", "step", "advance", "wait", "heartbeat"],
      write: false,
      description: "Yield for N RunService.Heartbeat steps. Useful for deterministic time advancement.",
      inputSchema: {
        type: "object",
        properties: {
          count: { type: "number", description: "Number of Heartbeat steps (default 1, max 600 ~ 10s at 60fps)." },
        },
      },
    },
    (args) => `
local a = __MCP.decode(${luaJson(args)})
local count = math.min(math.max(a.count or 1, 1), 600)
local RunService = game:GetService("RunService")
local startClock = os.clock()
for _ = 1, count do RunService.Heartbeat:Wait() end
return { ok = true, frames = count, elapsed = os.clock() - startClock }
`,
  ),

  // ---- vision / observation ----------------------------------------------
  // (`screenshot` is now a CORE tool — defined in server.ts. It used to live
  // here as a specialist; promoted because vision is fundamental and being
  // gated behind search_tools added friction every session.)

  dispatchTool(
    {
      name: "viewport_capture",
      category: "viewport",
      subcategories: ["vision", "scene"],
      keywords: ["viewport", "scene", "camera", "visible", "see", "look", "observe"],
      write: false,
      description:
        "Structured scene grounding: camera CFrame + FOV + on-screen BaseParts with projected 2D bboxes and distances. Sorted closest-first. Works in edit and play modes.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max parts (default 20)." },
        },
      },
    },
    "viewport_capture",
  ),

  dispatchTool(
    {
      name: "camera_set",
      category: "camera",
      subcategories: ["vision", "orient", "control"],
      keywords: ["camera", "orient", "look", "fov", "focus", "view", "perspective"],
      write: true,
      description:
        "Orient the workspace camera: set CFrame (12-number array), or position + lookAt, or just one. Optional fov and focus (position array or ref).",
      inputSchema: {
        type: "object",
        properties: {
          position: { type: "array", items: { type: "number" }, description: "World [x,y,z]." },
          lookAt: { type: "array", items: { type: "number" }, description: "Aim at world [x,y,z]." },
          cframe: {
            type: "array",
            items: { type: "number" },
            description: "Full CFrame as 12 numbers (x,y,z,r00..r22). Overrides position/lookAt.",
          },
          fov: { type: "number", description: "FieldOfView (degrees)." },
          focus: {
            description: "Focus point: world [x,y,z] array or a ref/path string.",
            oneOf: [
              { type: "array", items: { type: "number" } },
              { type: "string" },
            ],
          },
        },
      },
    },
    "camera_set",
  ),

  dispatchTool(
    {
      name: "raycast",
      category: "viewport",
      subcategories: ["vision", "probe", "physics"],
      keywords: ["raycast", "probe", "hit", "trace", "ray", "intersect", "what is there"],
      write: false,
      description:
        "Cast a ray and return the first hit: instance, position, normal, material, distance. Use fromCamera=true to cast from the camera (forward direction if no direction given). length defaults to direction.Magnitude or 500.",
      inputSchema: {
        type: "object",
        properties: {
          origin: { type: "array", items: { type: "number" }, description: "World [x,y,z] start. Required unless fromCamera." },
          direction: { type: "array", items: { type: "number" }, description: "World [x,y,z] direction (will be normalized)." },
          length: { type: "number", description: "Max ray length (default direction's magnitude, or 500)." },
          fromCamera: { type: "boolean", description: "Start from camera; uses camera LookVector if direction omitted." },
          ignore: {
            type: "array",
            items: { type: "string" },
            description: "Refs/paths to exclude from the cast.",
          },
        },
      },
    },
    "raycast",
  ),

  // ---- "pro" wave: terrain / animation / audio / effects / physics / world ----
  // Defined in pro.ts to keep seed.ts focused on the original starter set.
  ...PRO_TOOLS,
];
