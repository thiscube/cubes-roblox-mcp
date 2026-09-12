import { type ToolEntry, commandTool, evalTool, dispatchTool, luaJson, timeoutFor } from "../registry.js";
import { objectResult } from "../output-schema.js";

/**
 * Driving and observing a running playtest.
 *
 * One file per Category value — the registry's own taxonomy names the file,
 * so there is never a question of where a new tool goes (A6).
 */


/**
 * Walk a character along a computed path.
 *
 * Runs through the `tune` plugin command, which evaluates in the RUNNING
 * playtest's server DataModel — so this needs no plugin change, and it is why
 * the tool is a commandTool rather than an evalTool: eval lands in the edit
 * place, where there is no character to move.
 *
 * The honest limit: Humanoid:MoveTo is server-side puppeteering, so the game's
 * own control scripts still do not run. It buys intent ("get to that door")
 * rather than fidelity; real input needs the client DataModel, which cannot
 * reach this bridge at all (see PLAN.md #10).
 */
const gotoBudgetMs = (args: any): number =>
  (Math.min(60, Math.max(1, Number(args?.timeout) || 20)) + 10) * 1000;

function gotoLuau(args: Record<string, unknown>): string {
  return `
local a = __MCP.decode(${luaJson(args)})
local Players = game:GetService("Players")
local PFS = game:GetService("PathfindingService")

local plr
if a.player ~= nil and a.player ~= "" then
  plr = Players:FindFirstChild(tostring(a.player))
else
  plr = Players:GetPlayers()[1]
end
if not plr then return { error = "no_player", hint = "Start a playtest first." } end
local char = plr.Character
local hum = char and char:FindFirstChildOfClass("Humanoid")
local root = char and char:FindFirstChild("HumanoidRootPart")
if not (hum and root) then return { error = "no_character", player = plr.Name } end

-- Destination is one string so the tool keeps one argument: either three
-- comma-separated numbers, or anything __MCP.resolve understands.
local dest
local raw = tostring(a.to)
local x, y, z = raw:match("^%s*(-?[%d%.]+)%s*,%s*(-?[%d%.]+)%s*,%s*(-?[%d%.]+)%s*$")
if x then
  -- The pattern accepts "1.2.3", which tonumber does not, and Vector3.new(nil)
  -- would throw uncaught inside someone's running game.
  local nx, ny, nz = tonumber(x), tonumber(y), tonumber(z)
  if not (nx and ny and nz) then
    return { error = "bad_destination", target = raw, hint = "Coordinates look like \"12, 4, -30\"." }
  end
  dest = Vector3.new(nx, ny, nz)
else
  local inst = __MCP.resolve(raw)
  if not inst then return { error = "not_found", target = raw } end
  if inst:IsA("BasePart") then
    dest = inst.Position
  elseif inst:IsA("Model") then
    local pp = inst.PrimaryPart or inst:FindFirstChildWhichIsA("BasePart", true)
    if not pp then return { error = "no_position", target = raw } end
    dest = pp.Position
  else
    return { error = "no_position", target = raw, hint = "Point at a BasePart, a Model, or x,y,z." }
  end
end

local budget = math.clamp(tonumber(a.timeout) or 20, 1, 60)
local tolerance = math.max(0.5, tonumber(a.tolerance) or 4)
local deadline = os.clock() + budget

local path = PFS:CreatePath({ AgentRadius = 2, AgentHeight = 5, AgentCanJump = true })
local okc, errc = pcall(function() path:ComputeAsync(root.Position, dest) end)
if not okc then return { error = "path_error", message = tostring(errc) } end
if path.Status ~= Enum.PathStatus.Success then
  return {
    status = "blocked",
    arrived = false,
    pathStatus = tostring(path.Status),
    remaining = (root.Position - dest).Magnitude,
  }
end

local pts = path:GetWaypoints()
local reached = 0
for i = 2, #pts do
  if os.clock() >= deadline then break end
  local wp = pts[i]
  if wp.Action == Enum.PathWaypointAction.Jump then hum.Jump = true end
  hum:MoveTo(wp.Position)
  local finished, arrivedAtWp = false, false
  local conn = hum.MoveToFinished:Connect(function(ok)
    finished, arrivedAtWp = true, ok
  end)
  -- MoveToFinished also fires false on the engine's own 8s timeout, so the wait
  -- is bounded by the caller's budget rather than by trusting the signal alone.
  local wpDeadline = os.clock() + math.min(8, math.max(0.1, deadline - os.clock()))
  repeat
    task.wait(0.05)
  until finished or os.clock() >= wpDeadline
  conn:Disconnect()
  if not (finished and arrivedAtWp) then break end
  -- A death respawns the character, which leaves this loop driving a humanoid
  -- that is no longer the player's and reporting a corpse's position as the
  -- result. Stop and say so instead.
  if hum.Health <= 0 or plr.Character ~= char then
    return {
      arrived = false,
      status = "died",
      remaining = (root.Position - dest).Magnitude,
      waypoints = #pts,
      reached = i,
    }
  end
  reached = i
end

local remaining = (root.Position - dest).Magnitude
local arrived = remaining <= tolerance
return {
  arrived = arrived,
  status = arrived and "arrived" or (os.clock() >= deadline and "timeout" or "blocked"),
  remaining = remaining,
  waypoints = #pts,
  reached = reached,
  position = { root.Position.X, root.Position.Y, root.Position.Z },
}
`;
}

export const PLAYTEST_TOOLS: ToolEntry[] = [
  evalTool(
    {
      name: "test_run",
      category: "playtest",
      subcategories: ["testez", "tests", "verify"],
      keywords: ["test", "testez", "unit test", "spec", "suite", "run tests", "verify", "regression"],
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
      description:
        "Start Play Solo (StudioTestService:ExecutePlayModeAsync). Plugin stays connected, so drive the player with character_* tools. Temporarily enables LoadStringEnabled so eval tools work in the play DM, restored on stop (`loadStringFlipped`).",
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
      readOnly: true,
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
      readOnly: true,
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
  commandTool(
    {
      name: "tune",
      category: "playtest",
      subcategories: ["live", "eval", "tweak"],
      keywords: ["tune", "live", "eval", "playtest", "tweak", "gravity", "walkspeed", "stats", "mid-run", "hotfix"],
      description:
        "Run Luau in the RUNNING playtest's server DataModel: the live game, not the edit place. Tweak values mid-playtest (Gravity, WalkSpeed, enemy stats) live. `return <v>` comes back as JSON, a nil return as `{__void=true}`. Needs a playtest.",
      inputSchema: {
        type: "object",
        properties: {
          luau: { type: "string", description: "Luau source to run in the live play-DM server. Use 'return <value>' to return data." },
        },
        required: ["luau"],
      },
    },
    "tune",
    async (args, ctx) => {
      const luau = (args ?? {}).luau;
      if (typeof luau !== "string" || luau.trim() === "") {
        return { error: "bad_args", hint: "tune requires a non-empty 'luau' string." };
      }
      const result = await ctx.bridge.send("tune", { luau });
      return { result };
    },
  ),
  commandTool(
    {
      name: "character_goto",
      category: "playtest",
      subcategories: ["move", "navigate", "path"],
      keywords: ["goto", "walk", "path", "pathfinding", "navigate", "moveto", "route", "travel"],
      description:
        "Walk the character somewhere with PathfindingService, jumping where the path says to. Returns arrived/blocked/timeout and the distance left. YIELDS. Needs a playtest.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", description: "A ref, a dotted path, or \"x,y,z\" world coordinates." },
          player: { type: "string", description: "Player name. Defaults to the first player." },
          timeout: { type: "number", minimum: 1, maximum: 60, description: "Seconds to keep walking (default 20)." },
          tolerance: { type: "number", description: "Studs from target that counts as arrived (default 4)." },
        },
        required: ["to"],
      },
      yieldBudgetMs: gotoBudgetMs,
      outputSchema: objectResult({
        arrived: { type: "boolean" },
        status: { type: "string" },
        remaining: { type: "number" },
      }),
    },
    "tune",
    async (args, ctx) => {
      const to = String((args ?? {}).to ?? "").trim();
      if (!to) return { error: "bad_args", hint: "character_goto needs a destination in 'to'." };
      const result = await ctx.bridge.send(
        "tune",
        { luau: gotoLuau(args ?? {}) },
        timeoutFor({ yieldBudgetMs: gotoBudgetMs }, args),
      );
      return { result };
    },
  ),
  dispatchTool(
    {
      name: "players_state",
      category: "playtest",
      subcategories: ["players", "state", "introspect"],
      keywords: ["players", "list", "who", "online", "roster"],
      readOnly: true,
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
      readOnly: true,
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
      readOnly: true,
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
      readOnly: true,
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
      yieldBudgetMs: (args) => Math.min(Number(args?.timeout) || 5, 25) * 1000,
      category: "playtest",
      subcategories: ["logs", "diagnostics", "wait"],
      keywords: ["wait", "log", "pattern", "match", "expect", "watch"],
      readOnly: true,
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
      name: "spawn_marker",
      category: "playtest",
      subcategories: ["debug", "visualize"],
      keywords: ["marker", "flag", "label", "pin", "debug", "visualize"],
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
  dispatchTool(
    {
      name: "event_watch",
      category: "playtest",
      subcategories: ["events", "remote", "observe"],
      keywords: ["watch", "observe", "remoteevent", "bindable", "event", "fire", "remote"],
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
      readOnly: true,
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
      yieldBudgetMs: (args) => Math.min(Number(args?.timeout) || 5, 25) * 1000,
      category: "playtest",
      subcategories: ["wait", "predicate", "polling"],
      keywords: ["wait", "until", "predicate", "watch", "poll", "block"],
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
      yieldBudgetMs: (args) => Math.min(Math.max(Number(args?.count) || 1, 1), 600) * 50,
      category: "playtest",
      subcategories: ["wait", "frames", "advance"],
      keywords: ["frames", "step", "advance", "wait", "heartbeat"],
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
];
