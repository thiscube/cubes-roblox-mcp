import { type ToolEntry, commandTool, evalTool, dispatchTool, localTool, luaJson, timeoutFor } from "../registry.js";
import { analyzeSignals } from "../signal.js";
import { objectResult } from "../output-schema.js";

/**
 * Driving and observing a running playtest.
 *
 * One file per Category value — the registry's own taxonomy names the file,
 * so there is never a question of where a new tool goes (A6).
 */

/**
 * Real player input, through UserInputService:CreateVirtualInput().
 *
 * Runs through the `client_eval` plugin command because the virtual input only
 * works in the play client, and that needs no plugin change. `__MCP` does not
 * exist there, so arguments are decoded with HttpService directly.
 */
const CLIENT_GUI_LUAU = `
local HttpService = game:GetService("HttpService")
local me = game:GetService("Players").LocalPlayer
local playerGui = me:FindFirstChildOfClass("PlayerGui")
local function shown(g)
  if not g:IsA("GuiObject") or g.AbsoluteSize.X <= 0 or g.AbsoluteSize.Y <= 0 then return false end
  -- A SurfaceGui or BillboardGui's positions are not screen positions.
  if not g:FindFirstAncestorWhichIsA("ScreenGui") then return false end
  local node = g
  while node and node ~= playerGui do
    if node:IsA("GuiObject") and not node.Visible then return false end
    if node:IsA("LayerCollector") and not node.Enabled then return false end
    node = node.Parent
  end
  return true
end
local function pathOf(g)
  return string.sub(g:GetFullName(), #playerGui:GetFullName() + 2)
end
local function clickable(g)
  return g:IsA("GuiButton") or g:IsA("TextBox")
end
local function textOf(g)
  if g:IsA("TextButton") or g:IsA("TextLabel") or g:IsA("TextBox") then return g.Text end
  return nil
end
`;

const PLAYER_INPUT_LUAU = `
local UIS = game:GetService("UserInputService")
local GuiService = game:GetService("GuiService")
-- One per client, kept between calls so a key pressed in one is released in the next.
local state = _G.__CUBES_INPUT
if not state then
  state = { vi = UIS:CreateVirtualInput(), held = {} }
  _G.__CUBES_INPUT = state
end
local vi = state.vi

local KEY_ALIASES = { shift = "LeftShift", ctrl = "LeftControl", alt = "LeftAlt", enter = "Return", esc = "Escape" }
local function keyCode(name)
  local want = string.lower(tostring(name))
  want = string.lower(KEY_ALIASES[want] or want)
  for _, item in Enum.KeyCode:GetEnumItems() do
    if string.lower(item.Name) == want then return item end
  end
  return nil
end

local function findTarget(name)
  local want = string.lower(name)
  local seen, hits = {}, {}
  for _, g in playerGui:GetDescendants() do
    if shown(g) then
      local path = string.lower(pathOf(g))
      local text = textOf(g)
      if string.lower(g.Name) == want or path == want or string.sub(path, -#want - 1) == "." .. want
        or (text and string.lower(text) == want) then
        -- A label inside a button means the button.
        local hit = clickable(g) and g or g:FindFirstAncestorWhichIsA("GuiButton") or g
        if not seen[hit] then
          seen[hit] = true
          hits[#hits + 1] = hit
        end
      end
    end
  end
  local buttons = {}
  for _, g in hits do
    if clickable(g) then buttons[#buttons + 1] = g end
  end
  return #buttons > 0 and buttons or hits
end

local function pressAt(pos, kind)
  local screen = pos + GuiService:GetGuiInset()
  vi:SendMousePosition(screen)
  task.wait(0.05)
  vi:SendMouseButton(screen, kind, true, 0)
  task.wait(0.05)
  vi:SendMouseButton(screen, kind, false, 0)
end

local function topAt(pos)
  local top = playerGui:GetGuiObjectsAtPosition(pos.X, pos.Y)[1]
  return top and pathOf(top) or nil
end

local function click(act)
  local kind = act.button == "right" and Enum.UserInputType.MouseButton2 or Enum.UserInputType.MouseButton1
  if type(act.at) == "table" then
    local pos = Vector2.new(tonumber(act.at[1]) or 0, tonumber(act.at[2]) or 0)
    pressAt(pos, kind)
    task.wait(0.1)
    return { at = act.at, under = topAt(pos) }
  end
  if type(act.target) ~= "string" or act.target == "" then
    return nil, "bad_action", "click needs 'target' or 'at'."
  end
  local found = findTarget(act.target)
  if #found == 0 then
    return nil, "not_found", "Nothing visible on screen matches '" .. act.target .. "'. ui_inspect lists what is there."
  end
  if #found > 1 then
    local paths = {}
    for i, g in found do
      if i > 8 then break end
      local center = g.AbsolutePosition + g.AbsoluteSize / 2
      paths[i] = pathOf(g) .. " at [" .. math.floor(center.X) .. ", " .. math.floor(center.Y) .. "]"
    end
    return nil, "ambiguous", "'" .. act.target .. "' matches several things: " .. table.concat(paths, ", ") .. ". Use a longer path, or click 'at' one of those."
  end
  local g = found[1]
  local pos = g.AbsolutePosition + g.AbsoluteSize / 2
  local view = workspace.CurrentCamera.ViewportSize
  if pos.X < 0 or pos.Y < -GuiService:GetGuiInset().Y or pos.X > view.X or pos.Y > view.Y then
    return nil, "off_screen", pathOf(g) .. " is outside the screen."
  end
  local fired = false
  local conn
  if g:IsA("GuiButton") then
    local signal = kind == Enum.UserInputType.MouseButton2 and g.MouseButton2Click or g.Activated
    conn = signal:Connect(function() fired = true end)
  end
  pressAt(pos, kind)
  local started = os.clock()
  while not fired and os.clock() - started < 0.3 do task.wait() end
  if conn then conn:Disconnect() end
  if g:IsA("TextBox") then fired = g:IsFocused() end
  if clickable(g) and not fired then
    return nil, "click_missed", "Clicked " .. pathOf(g) .. " and it did not respond. On top there: " .. tostring(topAt(pos)) .. "."
  end
  return { clicked = pathOf(g), verified = clickable(g) }
end

-- Where the right button can go down and reach the camera: a button there would take it.
local function openSpot()
  local inset = GuiService:GetGuiInset()
  local view = workspace.CurrentCamera.ViewportSize
  for _, fx in { 0.5, 0.25, 0.75 } do
    for _, fy in { 0.5, 0.25, 0.75 } do
      local screen = Vector2.new(view.X * fx, view.Y * fy)
      local blocked = false
      for _, g in playerGui:GetGuiObjectsAtPosition(screen.X - inset.X, screen.Y - inset.Y) do
        if g.Active then blocked = true break end
      end
      if not blocked then return screen end
    end
  end
  return nil
end

local function look(act)
  local cam = workspace.CurrentCamera
  local before = cam.CFrame.LookVector
  local dx, dy = tonumber(act.dx) or 0, tonumber(act.dy) or 0
  -- A fixed cap, so a big turn takes bigger steps rather than outlasting the call.
  local steps = math.clamp(math.ceil(math.max(math.abs(dx), math.abs(dy)) / 30), 1, 30)
  -- The default camera only turns while the right button is down, unless the mouse is locked.
  local free = UIS.MouseBehavior == Enum.MouseBehavior.Default
  local right = Enum.UserInputType.MouseButton2
  local spot = nil
  if free then
    spot = openSpot()
    if not spot then
      return nil, "no_open_spot", "A menu covers the screen, so the camera can't be turned. Close it first."
    end
    if UIS:IsMouseButtonPressed(right) then vi:SendMouseButton(spot, right, false, 0) task.wait(0.05) end
    vi:SendMouseButton(spot, right, true, 0)
    task.wait(0.05)
  end
  local okTurn, turnErr = pcall(function()
    for _ = 1, steps do
      vi:SendMouseDelta(Vector2.new(dx / steps, dy / steps))
      task.wait(0.03)
    end
  end)
  -- Whatever happened above: a button left down blocks every later turn.
  if free then pcall(function() vi:SendMouseButton(spot, right, false, 0) end) end
  if not okTurn then return nil, "look_failed", tostring(turnErr) end
  task.wait(0.05)
  local dot = math.clamp(cam.CFrame.LookVector:Dot(before), -1, 1)
  return { turnedDegrees = math.floor(math.deg(math.acos(dot)) * 10) / 10 }
end

local function run(act)
  local kind = act["do"]
  if kind == "wait" then
    task.wait(tonumber(act.seconds) or 0)
    return { waited = tonumber(act.seconds) or 0 }
  elseif kind == "click" then
    return click(act)
  elseif kind == "look" then
    return look(act)
  elseif kind == "type" then
    if not UIS:GetFocusedTextBox() then
      return nil, "no_text_box", "No text box has focus. Click one first."
    end
    vi:SendTextInput(tostring(act.text or ""))
    task.wait(0.05)
    return { typed = UIS:GetFocusedTextBox() and UIS:GetFocusedTextBox().Text }
  elseif kind == "release" and act.key == nil then
    for name, code in state.held do
      vi:SendKey(false, code, false)
      state.held[name] = nil
    end
    return { released = "all" }
  elseif kind == "key" or kind == "press" or kind == "release" then
    local code = keyCode(act.key)
    if not code then return nil, "bad_key", "No key called '" .. tostring(act.key) .. "'." end
    if kind == "release" then
      vi:SendKey(false, code, false)
      state.held[code.Name] = nil
      return { released = code.Name }
    end
    vi:SendKey(true, code, false)
    if kind == "press" then
      state.held[code.Name] = code
      return { pressed = code.Name }
    end
    task.wait(tonumber(act.hold) or 0.05)
    vi:SendKey(false, code, false)
    return { key = code.Name, held = tonumber(act.hold) or 0.05 }
  end
  return nil, "bad_action", "Unknown action '" .. tostring(kind) .. "'."
end

local function rootPosition()
  local root = me.Character and me.Character:FindFirstChild("HumanoidRootPart")
  return root and root.Position or nil
end
local function heldKeys()
  local names = {}
  for name in state.held do names[#names + 1] = name end
  return names
end
local function moved(from)
  local to = rootPosition()
  return from and to and math.floor((to - from).Magnitude * 10) / 10 or nil
end

local start = rootPosition()
local done = {}
for i, act in a.actions do
  local okRun, result, code, message = pcall(run, act)
  if not okRun then
    code, message, result = "input_failed", tostring(result), nil
  end
  if not result then
    return { error = code, at = i, message = message, done = done, moved = moved(start), held = heldKeys() }
  end
  done[#done + 1] = result
end
return { done = done, moved = moved(start), held = heldKeys() }
`;

const UI_INSPECT_LUAU = `
local want = type(a.find) == "string" and string.lower(a.find) or nil
local limit = math.clamp(tonumber(a.limit) or 40, 1, 200)
local items, total = {}, 0
for _, g in playerGui:GetDescendants() do
  if shown(g) then
    local text = textOf(g)
    local isHit
    if want then
      isHit = string.find(string.lower(pathOf(g)), want, 1, true) ~= nil
        or (text ~= nil and string.find(string.lower(text), want, 1, true) ~= nil)
    else
      isHit = clickable(g) or (a.all == true)
    end
    if isHit then
      total += 1
      if #items < limit then
        local center = g.AbsolutePosition + g.AbsoluteSize / 2
        items[#items + 1] = {
          path = pathOf(g),
          class = g.ClassName,
          text = text and string.sub(text, 1, 80) or nil,
          clickable = clickable(g),
          at = { math.floor(center.X), math.floor(center.Y) },
          size = { math.floor(g.AbsoluteSize.X), math.floor(g.AbsoluteSize.Y) },
        }
      end
    end
  end
end
return { elements = items, total = total, truncated = total > #items }
`;

/** What the plugin allows a client_eval, less room for the round trip. */
const INPUT_MAX_SECONDS = 20;
const INPUT_MAX_ACTIONS = 30;

function clientChunk(body: string, args: unknown): string {
  return `${CLIENT_GUI_LUAU}\nlocal a = HttpService:JSONDecode(${luaJson(args)})\n${body}`;
}

/** Drop the chunk's own bookkeeping; the server's isError comes from `error`. */
function fromClient(reply: unknown): unknown {
  if (!reply || typeof reply !== "object") return reply;
  const { __via: _via, ...rest } = reply as Record<string, unknown>;
  return rest;
}


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
 * rather than fidelity; for the game's own controls, use player_input.
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
        "Start a playtest: Play Solo, or with players 2-8 a local server and that many clients (like Clients and Servers). Drive players with character_* tools; reach one client with client_eval's player.",
      inputSchema: {
        type: "object",
        properties: {
          testArgs: { description: "Optional value passed to StudioTestService:GetTestArgs() inside the session." },
          players: { type: "number", description: "Clients to start (1-8, default 1). 2 or more runs a local server with that many test players." },
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
  commandTool(
    {
      name: "client_eval",
      category: "playtest",
      subcategories: ["live", "eval", "client"],
      keywords: ["client", "camera", "gui", "localscript", "render", "local"],
      description:
        "Run Luau in the running playtest's CLIENT DataModel: the only way to reach the camera, PlayerGui or LocalScripts, none of which exist where `tune` runs. `return <v>` comes back as JSON. Needs a playtest.",
      inputSchema: {
        type: "object",
        properties: {
          luau: { type: "string", description: "Luau to run in the live play-DM client. Use 'return <value>' to get data back." },
          player: { type: "string", description: "Which client in a multi-player test (e.g. 'Player2'; playtest_result lists them). Default: the first player." },
        },
        required: ["luau"],
      },
    },
    "client_eval",
    async (args, ctx) => {
      const luau = (args ?? {}).luau;
      if (typeof luau !== "string" || luau.trim() === "") {
        return { error: "bad_args", hint: "client_eval requires a non-empty 'luau' string." };
      }
      const player = (args ?? {}).player;
      return {
        result: await ctx.bridge.send(
          "client_eval",
          typeof player === "string" && player !== "" ? { luau, player } : { luau },
          30_000,
        ),
      };
    },
  ),
  commandTool(
    {
      name: "player_input",
      category: "playtest",
      subcategories: ["live", "input", "client"],
      keywords: ["input", "keyboard", "key", "press", "mouse", "click", "button", "type", "camera", "look", "controls", "menu"],
      description:
        "Play as a real player through the game's own controls and GUI: keys, clicks, camera, typing. Stops at the first failure, including a click the button did not respond to.",
      inputSchema: {
        type: "object",
        properties: {
          actions: {
            type: "array",
            description: "At most 20s in total.",
            items: {
              type: "object",
              properties: {
                do: { type: "string", enum: ["key", "press", "release", "click", "look", "type", "wait"] },
                key: { type: "string", description: "W, Space, shift. release with none lets go of all." },
                hold: { type: "number", description: "Seconds, for key." },
                target: { type: "string", description: "Name, path or text of a visible GUI element." },
                at: { type: "array", items: { type: "number" }, description: "[x, y] from ui_inspect, instead of target." },
                button: { type: "string", enum: ["left", "right"] },
                dx: { type: "number", description: "Mouse pixels." },
                dy: { type: "number", description: "Mouse pixels." },
                text: { type: "string", description: "Into the focused text box." },
                seconds: { type: "number", description: "wait." },
              },
              required: ["do"],
            },
          },
          player: { type: "string", description: "Which client. Default: the first." },
        },
        required: ["actions"],
      },
      outputSchema: objectResult(),
    },
    "client_eval",
    async (args, ctx) => {
      const actions = (args ?? {}).actions;
      if (!Array.isArray(actions) || actions.length === 0 || actions.length > INPUT_MAX_ACTIONS) {
        return { error: "bad_args", hint: `player_input needs 1-${INPUT_MAX_ACTIONS} actions.` };
      }
      // Each action costs a little even with no wait in it, hence the 0.3. A look
      // takes up to 30 frames whatever its size.
      const seconds = actions.reduce(
        (sum: number, act: any) =>
          sum + (act?.do === "look" ? 1.5 : 0.3) + Math.max(0, Number(act?.hold) || 0) + Math.max(0, Number(act?.seconds) || 0),
        0,
      );
      if (seconds > INPUT_MAX_SECONDS) {
        return { error: "bad_args", hint: `That is about ${Math.round(seconds)}s of input; split it into calls of ${INPUT_MAX_SECONDS}s or less.` };
      }
      const player = (args ?? {}).player;
      const luau = clientChunk(PLAYER_INPUT_LUAU, { actions });
      return fromClient(
        await ctx.bridge.send("client_eval", typeof player === "string" && player !== "" ? { luau, player } : { luau }, 30_000),
      );
    },
  ),
  commandTool(
    {
      name: "ui_inspect",
      category: "playtest",
      subcategories: ["live", "gui", "client"],
      keywords: ["ui", "gui", "button", "menu", "screen", "shop", "text", "visible", "hud", "find"],
      description:
        "What is on the player's screen in a playtest: name, text and position of each visible GUI element, clickable ones by default.",
      inputSchema: {
        type: "object",
        properties: {
          find: { type: "string", description: "Path or text contains this." },
          all: { type: "boolean", description: "Labels and frames too." },
          limit: { type: "number", description: "Default 40." },
          player: { type: "string", description: "Which client." },
        },
      },
      outputSchema: objectResult({ elements: { type: "array" }, total: { type: "number" } }),
    },
    "client_eval",
    async (args, ctx) => {
      const { player, ...rest } = (args ?? {}) as Record<string, unknown>;
      const luau = clientChunk(UI_INSPECT_LUAU, rest);
      return fromClient(
        await ctx.bridge.send("client_eval", typeof player === "string" && player !== "" ? { luau, player } : { luau }, 30_000),
      );
    },
  ),
  commandTool(
    {
      name: "signal_capture",
      category: "playtest",
      subcategories: ["live", "measure"],
      keywords: ["measure", "sample", "signal", "frequency", "oscillation", "bob", "telemetry"],
      description:
        "Sample any numeric signal every frame in the playtest client, then report amplitude, dominant frequency, how cleanly it repeats, second-harmonic ratio, roughness and cross-channel phase. Use instead of eyeballing.",
      inputSchema: {
        type: "object",
        properties: {
          setup: {
            type: "string",
            description: "Luau that RETURNS a sampler function; the sampler returns a flat table of numbers keyed by channel name.",
          },
          duration: { type: "number", description: "Seconds to record (default 3, max 20)." },
          hz: { type: "number", description: "Samples per second (default 60, max 240)." },
          raw: { type: "boolean", description: "Also return the per-sample series (large; off by default)." },
          player: { type: "string", description: "Which client in a multi-player test (e.g. 'Player2'). Default: the first player." },
        },
        required: ["setup"],
      },
    },
    "signal_capture",
    async (args, ctx) => {
      const a = (args ?? {}) as Record<string, unknown>;
      const setup = a.setup;
      if (typeof setup !== "string" || setup.trim() === "") {
        return { error: "bad_args", hint: "signal_capture needs a 'setup' chunk that RETURNS a sampler function." };
      }
      const duration = Math.min(20, Math.max(0.1, Number(a.duration) || 3));
      const hz = Math.min(240, Math.max(1, Number(a.hz) || 60));
      const res = (await ctx.bridge.send(
        "signal_capture",
        typeof a.player === "string" && a.player !== "" ? { setup, duration, hz, player: a.player } : { setup, duration, hz },
        Math.round((duration + 20) * 1000),
      )) as any;
      const channels = (res?.channels ?? {}) as Record<string, number[]>;
      if (!Object.keys(channels).length) {
        return { result: { ...res, warning: "no channels captured — does the sampler return a table of numbers?" } };
      }
      return {
        result: {
          context: res?.context ?? "client",
          ...analyzeSignals(channels, res?.t),
          ...(a.raw === true ? { t: res?.t, series: channels } : {}),
        },
      };
    },
  ),
];
