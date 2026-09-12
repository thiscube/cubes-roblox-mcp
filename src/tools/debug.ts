import { type ToolEntry, evalTool, luaJson } from "../registry.js";

/**
 * Visual debugging overlays and error introspection.
 *
 * One file per Category value — the registry's own taxonomy names the file,
 * so there is never a question of where a new tool goes (A6).
 */

export const DEBUG_TOOLS: ToolEntry[] = [
  evalTool(
    {
      name: "debug_highlight",
      // Scaffolding under Workspace._CubesMCPDebug, cleared by debug_clear.
      // A waypoint here would make Ctrl+Z remove an overlay instead of the
      // edit the user was looking at.
      undo: "none",
      category: "debug",
      subcategories: ["visualize", "overlay"],
      keywords: ["highlight", "outline", "color", "overlay", "mark", "see", "find", "show", "debug"],
      description:
        "Add a colored Highlight overlay to instances so a screenshot shows exactly which parts a change targets. AlwaysOnTop, parented under Workspace._CubesMCPDebug. duration>0 auto-clears after N seconds.",
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
      // Scaffolding under Workspace._CubesMCPDebug, cleared by debug_clear.
      // A waypoint here would make Ctrl+Z remove an overlay instead of the
      // edit the user was looking at.
      undo: "none",
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
      // Scaffolding under Workspace._CubesMCPDebug, cleared by debug_clear.
      // A waypoint here would make Ctrl+Z remove an overlay instead of the
      // edit the user was looking at.
      undo: "none",
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
      // Scaffolding under Workspace._CubesMCPDebug, cleared by debug_clear.
      // A waypoint here would make Ctrl+Z remove an overlay instead of the
      // edit the user was looking at.
      undo: "none",
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
      // Scaffolding under Workspace._CubesMCPDebug, cleared by debug_clear.
      // A waypoint here would make Ctrl+Z remove an overlay instead of the
      // edit the user was looking at.
      undo: "none",
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
      name: "debug_error",
      category: "debug",
      subcategories: ["errors", "diagnostics", "context"],
      keywords: ["error", "crash", "stack", "debug", "fix", "exception", "traceback", "broken"],
      readOnly: true,
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
];

/**
 * Non-pausing breakpoints (PLAN.md #9).
 *
 * Checked against the API dump before writing a line of Luau: every member of
 * `ScriptDebugger` and `DebuggerBreakpoint` is `Security: None`, and
 * `DebuggerManager:AddDebugger` / `GetDebuggers` are too. So this needs no
 * plugin change — only `EnableDebugging` is gated, and it is not needed to set a
 * breakpoint on a script that is already being debugged.
 *
 * `EnableDebugging` is the one member that is NOT open — it is
 * `LocalUserSecurity`, which a plugin does not have. So when script debugging is
 * off in a Studio build, `debugger_unavailable` is the end of the road and
 * nothing this server can do will change it. The descriptions say so rather than
 * letting the agent retry.
 *
 * `ContinueExecution` is the whole point. A breakpoint that pauses the VM during
 * a playtest is useless to an agent: nothing can answer the next tool call while
 * Studio is stopped at a line. With it set, the breakpoint records the hit and
 * carries on, which turns a breakpoint into a log line you did not have to edit
 * the script to add.
 */
export const BREAKPOINT_TOOLS: ToolEntry[] = [
  evalTool(
    {
      name: "breakpoint_set",
      category: "debug",
      subcategories: ["debugger", "inspect", "trace"],
      keywords: ["breakpoint", "debug", "trace", "line", "hit", "watch", "log", "pause", "step"],
      description:
        "Set a breakpoint on a script line WITHOUT pausing the VM: it records the hit and execution continues. Optional condition and log expression. Turns a breakpoint into a log line you did not have to edit the script to add.",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", description: "Ref or path of the script." },
          line: { type: "number", description: "1-based line number." },
          condition: { type: "string", description: "Luau expression; break only when true." },
          logExpression: { type: "string", description: "Luau expression to record on each hit." },
          pause: { type: "boolean", description: "Actually stop the VM. Default false." },
        },
        required: ["target", "line"],
      },
    },
    (args) => `
local a = __MCP.decode(${luaJson(args)})
local inst = __MCP.resolve(a.target)
if not inst then return { error = "not_found", target = a.target } end
if not inst:IsA("LuaSourceContainer") then return { error = "not_a_script", class = inst.ClassName } end

local manager = game:GetService("DebuggerManager")
-- pcall'd like AddDebugger below. With script debugging disabled this throws,
-- and an unguarded throw here means the agent gets a raw bridge error instead
-- of the hint written for exactly this case.
local okList, existing = pcall(function() return manager:GetDebuggers() end)
if not okList then
  return { error = "debugger_unavailable", message = tostring(existing), hint = "Script debugging is off in this Studio build, and a plugin cannot turn it on (EnableDebugging is LocalUserSecurity). Enable it in Studio settings." }
end
local debugger
for _, d in ipairs(existing) do
  if d.Script == inst then debugger = d break end
end
if not debugger then
  local ok, made = pcall(function() return manager:AddDebugger(inst) end)
  if not ok or not made then
    return { error = "debugger_unavailable", message = tostring(made), hint = "Script debugging may be disabled in this Studio build." }
  end
  debugger = made
end

local line = math.max(1, math.floor(tonumber(a.line) or 1))
local okSet, bp = pcall(function() return debugger:SetBreakpoint(line, false) end)
if not okSet or not bp then
  return { error = "breakpoint_failed", line = line, message = tostring(bp) }
end

-- Continue by default. A breakpoint that stops the VM mid-playtest also stops
-- the plugin answering, so the next tool call times out.
bp.ContinueExecution = a.pause ~= true
if a.condition then pcall(function() bp.Condition = a.condition end) end
if a.logExpression then pcall(function() bp.LogExpression = a.logExpression end) end

return {
  ok = true,
  script = inst:GetFullName(),
  ref = __MCP.refFor(inst),
  line = bp.Line,
  pauses = not bp.ContinueExecution,
  condition = bp.Condition ~= "" and bp.Condition or nil,
}
`,
  ),

  evalTool(
    {
      name: "breakpoint_list",
      // DebuggerBreakpoints are debugger state, not DataModel state, so they
      // are not in the undo stack to begin with.
      undo: "none",
      // Listing only. `clear` used to live here as a boolean, which made the
      // whole tool write-class — so a read-only build could not even LIST
      // breakpoints. A flag that flips a tool between reading and deleting can
      // only ever be classified as the more dangerous of the two.
      readOnly: true,
      category: "debug",
      subcategories: ["debugger", "inspect", "trace"],
      keywords: ["breakpoint", "list", "debug", "debugger", "active", "show", "clear", "remove"],
      description:
        "List every active breakpoint across all debugged scripts, with line, condition and whether it pauses. Read-only; use breakpoint_clear to remove them.",
      inputSchema: { type: "object", properties: {} },
    },
    () => `
local manager = game:GetService("DebuggerManager")
local out = {}

local okList, debuggers = pcall(function() return manager:GetDebuggers() end)
if not okList then
  return { error = "debugger_unavailable", message = tostring(debuggers), hint = "Script debugging is off in this Studio build." }
end
for _, d in ipairs(debuggers) do
  local okBp, breakpoints = pcall(function() return d:GetBreakpoints() end)
  if okBp and breakpoints then
    for _, bp in ipairs(breakpoints) do
      table.insert(out, {
        script = d.Script and d.Script:GetFullName() or "?",
        line = bp.Line,
        enabled = bp.IsEnabled,
        pauses = not bp.ContinueExecution,
        condition = bp.Condition ~= "" and bp.Condition or nil,
      })
    end
  end
end

return { breakpoints = out, count = #out }
`,
  ),

  evalTool(
    {
      name: "breakpoint_clear",
      category: "debug",
      subcategories: ["debugger", "trace"],
      keywords: ["breakpoint", "clear", "remove", "delete", "reset", "debugger", "stop"],
      description:
        "Remove every breakpoint across all debugged scripts. Separate from breakpoint_list so that listing stays read-only and survives into a read-only build.",
      inputSchema: { type: "object", properties: {} },
      undo: "none",
    },
    () => `
local manager = game:GetService("DebuggerManager")
local removed = 0

local okList, debuggers = pcall(function() return manager:GetDebuggers() end)
if not okList then
  return { error = "debugger_unavailable", message = tostring(debuggers), hint = "Script debugging is off in this Studio build." }
end
for _, d in ipairs(debuggers) do
  local okBp, breakpoints = pcall(function() return d:GetBreakpoints() end)
  if okBp and breakpoints then
    for _, bp in ipairs(breakpoints) do
      pcall(function() bp:Destroy() end)
      removed += 1
    end
  end
end

return { ok = true, removed = removed }
`,
  ),
];
