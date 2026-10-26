--!nonstrict
-- Cross-DataModel signal channel for cube's MCP.
--
-- WHY THIS EXISTS
-- ===============
-- Studio plugins run in a separate "edit" DataModel. When the user presses Play,
-- Studio spawns a new "play" DataModel (a clone of the edit DM) and the plugin
-- code is duplicated there too, but our entry point bails on IsRunning() so only
-- the edit-context plugin keeps polling the MCP server. That means tools like
-- character_teleport — which need a real Player.Character — execute in the edit
-- DM where Players[1].Character is always nil. The result: every Play Solo call
-- returns "no_character".
--
-- The proven pattern (used by Roblox's official MCP + Boshy MCP) is to inject
-- a real Script Instance into ServerScriptService BEFORE ExecutePlayModeAsync.
-- Studio clones that Script along with everything else into the play DM, where
-- it executes with full play-DM access (real Players, Characters, etc.).
--
-- Plugin (edit DM) and bootstrap (play DM) talk via plugin:SetSetting /
-- plugin:GetSetting. These settings are stored on the plugin instance itself,
-- which is shared across DM clones — so a write from the edit DM is visible
-- from the play DM and vice versa.
--
-- PROTOCOL (settings keys are all under the "__cubesMCP_*" namespace)
-- ==================================================================
--   __cubesMCP_cmd_<id>     (string|nil) JSON {tool=string, args=table}
--                           Written by plugin (edit DM), consumed by bootstrap.
--   __cubesMCP_result_<id>  (string|nil) JSON {ok=bool, value=any, error=any}
--                           Written by bootstrap (play DM), consumed by plugin.
--   __cubesMCP_stop         (string|nil) JSON {reason=string}
--                           Signals bootstrap to call StudioTestService:EndTest.
--   __cubesMCP_inbox        (string|nil) JSON [<id>, <id>, ...]
--                           Ordered list of pending command IDs. Bootstrap loop
--                           reads this rather than scanning all settings.
--
-- After read+ack, each side clears its consumed setting (writes nil) so the
-- store doesn't accumulate stale data across plays.

local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")
local ViewGuard = require(script.Parent.ViewGuard)

local PlaytestBus = {}

local _plugin = nil
local _cmdCounter = 0

local KEY_CMD = "__cubesMCP_cmd_"
local KEY_RESULT = "__cubesMCP_result_"
local KEY_STOP = "__cubesMCP_stop"
local KEY_INBOX = "__cubesMCP_inbox"
-- Written by whichever play-DM context is running the bus, every loop tick.
-- The edit DM uses its freshness as the ONLY authority on "is a playtest live".
local KEY_ALIVE = "__cubesMCP_alive"
-- Seconds of silence before the edit DM calls the play DM gone.
local ALIVE_WINDOW = 5
-- The test's player names (JSON list, sorted), written by the server bus. Each
-- client also serves its own inbox, KEY_INBOX .. "client:" .. its name, so a
-- multi-player test can reach any one of them.
local KEY_PLAYERS = "__cubesMCP_players"
-- Which client serves the plain "client" inbox.
local KEY_OWNER = "__cubesMCP_owner_client"
-- JSON list of every "client:<name>" ctx sent to, so cleanup() can wipe them.
local KEY_CTXS = "__cubesMCP_ctxs"
local PLAYERS_EVERY = 1

local function setSetting(key, value)
	if not _plugin then return end
	pcall(function() _plugin:SetSetting(key, value) end)
end

local function getSetting(key)
	if not _plugin then return nil end
	local ok, v = pcall(function() return _plugin:GetSetting(key) end)
	if ok then return v end
	return nil
end

-- Ids whose poll() timed out; their result may still land after it.
local abandoned = {}

-- Wipe all __cubesMCP_* settings. Called at the start of every play so we don't
-- inherit ghost commands/results from a prior session.
function PlaytestBus.cleanup()
	local ctxs = { "server", "client" }
	for _, key in ipairs({ KEY_PLAYERS, KEY_CTXS }) do
		local raw = getSetting(key)
		local ok, list = pcall(function() return HttpService:JSONDecode(raw) end)
		if ok and type(list) == "table" then
			for _, v in ipairs(list) do
				if type(v) == "string" then
					ctxs[#ctxs + 1] = key == KEY_PLAYERS and ("client:" .. v) or v
				end
			end
		end
	end
	setSetting(KEY_STOP, nil)
	setSetting(KEY_PLAYERS, nil)
	setSetting(KEY_CTXS, nil)
	for _, ctx in ipairs(ctxs) do
		setSetting(KEY_INBOX .. ctx, nil)
		setSetting(KEY_ALIVE .. ctx, nil)
	end
	setSetting(KEY_OWNER, nil)
	for _, id in ipairs(abandoned) do
		setSetting(KEY_RESULT .. id, nil)
	end
	table.clear(abandoned)
	-- Best-effort: there's no enumerate API on settings, so we rely on the
	-- per-id clears that bootstrap+plugin do on consume. The inbox+stop
	-- wipe is the only one we can guarantee here.
end

-- Is a play DataModel currently running our bus?
--
-- This exists because the edit DM has no honest signal of its own:
-- RunService:IsRunning() is false in plugin context even mid-playtest, and
-- StudioTestService:ExecutePlayModeAsync returns when the session STARTS, not
-- when it ends. Both were previously used as "is it running" and both lie.
function PlaytestBus.isLive(ctx)
	local n = tonumber(getSetting(KEY_ALIVE .. (ctx or "server")))
	if not n then return false end
	return (os.time() - n) <= ALIVE_WINDOW
end

-- Any play-DM context alive at all. The server bus is the one that owns the
-- session, so callers that just mean "is a playtest up" want this.
function PlaytestBus.isAnyLive()
	return PlaytestBus.isLive("server") or PlaytestBus.isLive("client")
end

-- The running test's player names, as the server bus last saw them.
function PlaytestBus.players()
	local raw = getSetting(KEY_PLAYERS)
	if type(raw) ~= "string" or #raw == 0 then return {} end
	local ok, decoded = pcall(function() return HttpService:JSONDecode(raw) end)
	if ok and type(decoded) == "table" then return decoded end
	return {}
end

function PlaytestBus.bind(pluginInstance)
	_plugin = pluginInstance
end

function PlaytestBus.isBound()
	return _plugin ~= nil
end

local function compileChunk(src)
	local okLs, produced = pcall(function() return loadstring(src) end)
	if okLs and type(produced) == "function" then return produced, nil, "loadstring" end
	if okLs and produced == nil then
		-- loadstring worked and the chunk itself is malformed: that is a real
		-- compile error, not a missing capability. Re-run for the message.
		local _, _, err = pcall(function() return loadstring(src) end)
		return nil, { code = "compile_error", message = tostring(err) }, nil
	end
	local m = Instance.new("ModuleScript")
	local nl = string.char(10)
	local okSrc = pcall(function() m.Source = "return function()" .. nl .. src .. nl .. "end" end)
	if not okSrc then
		m:Destroy()
		return nil, {
			code = "no_compiler",
			message = "the play DM allows neither loadstring (" .. tostring(produced) .. ") nor ModuleScript.Source",
		}, nil
	end
	m.Parent = game:GetService("ServerScriptService")
	local okReq, maker = pcall(require, m)
	m:Destroy()
	if not okReq then
		return nil, { code = "compile_error", message = tostring(maker) }, nil
	end
	if type(maker) ~= "function" then
		return nil, { code = "compile_error", message = "chunk did not produce a function" }, nil
	end
	return maker, nil, "modulescript"
end

-- Allocate a fresh command id. Timestamp prefix prevents collision across plays
-- (the counter resets when the plugin reloads, but timestamp does not).
local function nextId()
	_cmdCounter += 1
	return tostring(os.time()) .. "_" .. tostring(_cmdCounter)
end

-- Note a per-player ctx in KEY_CTXS so cleanup() can clear its inbox and alive key.
local function rememberCtx(ctx)
	if type(ctx) ~= "string" or ctx:sub(1, 7) ~= "client:" then return end
	local list = {}
	local raw = getSetting(KEY_CTXS)
	local ok, decoded = pcall(function() return HttpService:JSONDecode(raw) end)
	if ok and type(decoded) == "table" then list = decoded end
	if table.find(list, ctx) then return end
	list[#list + 1] = ctx
	setSetting(KEY_CTXS, HttpService:JSONEncode(list))
end

-- Push a command to the play-DM bootstrap. Returns the cmd id (use with poll()).
function PlaytestBus.send(tool, args, ctx)
	local id = nextId()
	rememberCtx(ctx)
	local inboxKey = KEY_INBOX .. (ctx or "server")
	local payload = HttpService:JSONEncode({ tool = tool, args = args or {} })
	setSetting(KEY_CMD .. id, payload)
	-- Also append to the inbox so the bootstrap doesn't have to guess ids.
	local inboxRaw = getSetting(inboxKey)
	local inbox = {}
	if type(inboxRaw) == "string" and #inboxRaw > 0 then
		local ok, decoded = pcall(function() return HttpService:JSONDecode(inboxRaw) end)
		if ok and type(decoded) == "table" then inbox = decoded end
	end
	-- The edit DM is the inbox's only writer (a bus clearing it raced this
	-- read-modify-write and lost ids), so drop ids whose command is consumed.
	local pending = {}
	for _, old in ipairs(inbox) do
		if getSetting(KEY_CMD .. old) ~= nil then pending[#pending + 1] = old end
	end
	pending[#pending + 1] = id
	setSetting(inboxKey, HttpService:JSONEncode(pending))
	return id
end

-- Block until the bootstrap writes a result for this cmd id, or timeoutSec
-- elapses. Returns (decoded_result_table | nil, errStr | nil).
function PlaytestBus.poll(id, timeoutSec)
	timeoutSec = tonumber(timeoutSec) or 15
	local deadline = os.clock() + timeoutSec
	local resultKey = KEY_RESULT .. id
	while os.clock() < deadline do
		local raw = getSetting(resultKey)
		if type(raw) == "string" and #raw > 0 then
			-- Consume the result so the store doesn't grow.
			setSetting(resultKey, nil)
			local ok, decoded = pcall(function() return HttpService:JSONDecode(raw) end)
			if not ok then return nil, "decode_failed" end
			return decoded, nil
		end
		task.wait(0.05)
	end
	-- Timeout: drop the command if nothing took it, and clear a late result at
	-- the next cleanup() so it doesn't sit in settings forever.
	setSetting(KEY_CMD .. id, nil)
	abandoned[#abandoned + 1] = id
	return nil, "timeout"
end

-- Signal the bootstrap to call StudioTestService:EndTest. Bootstrap clears its
-- own running flag on the way out.
function PlaytestBus.requestStop(reason)
	setSetting(KEY_STOP, HttpService:JSONEncode({ reason = tostring(reason or "stopped_by_mcp") }))
end

-- Is a stop request still waiting for a play DM to read it?
function PlaytestBus.isStopPending()
	local raw = getSetting(KEY_STOP)
	return type(raw) == "string" and #raw > 0
end

-- Drops a stop request that no play DM is left to read.
function PlaytestBus.clearStop()
	setSetting(KEY_STOP, nil)
end

-- Try to resolve a target hint (instance path like "workspace.SomePart") to a
-- position Vector3. The play DM has no Refs table, so we accept dotted paths
-- and basic names. Returns Vector3 or nil.
local function resolveTargetPos(target)
	if type(target) ~= "string" then return nil end
	local cur = game
	for seg in string.gmatch(target, "[^.]+") do
		if cur == game and (seg == "game" or seg == "Game") then
			-- skip
		else
			cur = cur:FindFirstChild(seg)
			if not cur then return nil end
		end
	end
	if cur and cur:IsA("BasePart") then return cur.Position end
	if cur and cur:IsA("Model") then
		local ok, pivot = pcall(function() return cur:GetPivot().Position end)
		if ok then return pivot end
	end
	if cur and cur:IsA("Attachment") then return cur.WorldPosition end
	return nil
end

-- camera_set / viewport_capture / raycast for a play DM. Shared by the server
-- and client buses: the edit DM forwards them to the client during a playtest,
-- since that is where the camera the user sees lives.
local function addViewHandlers(HANDLERS)
	-- Vision: project on-screen BaseParts to 2D bboxes + depth. Reimplements the
	-- core of Viewport.luau here (no Refs in play DM — return paths instead).
	local CORNER_SIGNS_BUS = {
		{1,1,1},{1,1,-1},{1,-1,1},{1,-1,-1},
		{-1,1,1},{-1,1,-1},{-1,-1,1},{-1,-1,-1},
	}
	HANDLERS.viewport_capture = function(args)
		local Workspace = game:GetService("Workspace")
		local camera = Workspace.CurrentCamera
		if not camera then return false, { error = "no_camera" } end
		local limit = tonumber(args.limit) or 20
		local viewportSize = camera.ViewportSize
		local cullX = viewportSize.X * 2
		local cullY = viewportSize.Y * 2
		local oversampleTarget = limit * 3
		local found = {}
		local scanned = 0
		local MAX_SCAN = 6000
		for _, inst in ipairs(Workspace:GetDescendants()) do
			if inst:IsA("BasePart") then
				if scanned >= MAX_SCAN then break end
				scanned += 1
				local center = camera:WorldToViewportPoint(inst.Position)
				if center.Z > 0 and math.abs(center.X) <= cullX and math.abs(center.Y) <= cullY then
					local cf, size = inst.CFrame, inst.Size
					local hx, hy, hz = size.X / 2, size.Y / 2, size.Z / 2
					local minX, minY = math.huge, math.huge
					local maxX, maxY = -math.huge, -math.huge
					for _, sign in ipairs(CORNER_SIGNS_BUS) do
						local world = cf:PointToWorldSpace(Vector3.new(sign[1] * hx, sign[2] * hy, sign[3] * hz))
						local sp = camera:WorldToViewportPoint(world)
						if sp.X < minX then minX = sp.X end
						if sp.X > maxX then maxX = sp.X end
						if sp.Y < minY then minY = sp.Y end
						if sp.Y > maxY then maxY = sp.Y end
					end
					local fx, fy, fz = math.floor(minX), math.floor(minY), math.floor(maxX), math.floor(maxY)
					local _ = fx + fy + fz -- silence
					found[#found + 1] = {
						refPath = inst:GetFullName(),
						name = inst.Name,
						class = inst.ClassName,
						position = { inst.Position.X, inst.Position.Y, inst.Position.Z },
						distance = math.floor(center.Z * 10) / 10,
						screen = {
							x = math.floor(minX),
							y = math.floor(minY),
							w = math.floor(maxX - minX),
							h = math.floor(maxY - minY),
						},
					}
					if #found >= oversampleTarget then break end
				end
			end
		end
		table.sort(found, function(a, b) return a.distance < b.distance end)
		local items = {}
		for i = 1, math.min(limit, #found) do items[i] = found[i] end
		local cf = camera.CFrame
		local pos = cf.Position
		local focus = camera.Focus.Position
		return true, {
			camera = {
				position = { pos.X, pos.Y, pos.Z },
				cframe = { cf:GetComponents() },
				lookVector = { cf.LookVector.X, cf.LookVector.Y, cf.LookVector.Z },
				fov = camera.FieldOfView,
				focus = { focus.X, focus.Y, focus.Z },
				viewportSize = { math.floor(viewportSize.X), math.floor(viewportSize.Y) },
			},
			items = items,
			count = #items,
			visibleCount = #found,
			scanned = scanned,
		}
	end

	HANDLERS.camera_set = function(args)
		local Workspace = game:GetService("Workspace")
		local camera = Workspace.CurrentCamera
		if not camera then return false, { error = "no_camera" } end
		-- Validated before anything is applied: a NaN or skewed CFrame leaves the
		-- camera unable to move until Workspace.Camera is deleted (ViewGuard).
		local goal, applied, badPlacement = ViewGuard.placement(camera, args)
		if badPlacement then
			return false, { code = "bad_args", error = "bad_args", message = badPlacement, hint = "Nothing was moved." }
		end
		if goal then
			camera.CFrame = goal
		end
		if args.fov ~= nil then
			local fov = tonumber(args.fov)
			if fov and fov == fov then
				camera.FieldOfView = math.clamp(fov, 1, 120)
				applied[#applied + 1] = "fov"
			end
		end
		if args.focus ~= nil then
			local f
			if type(args.focus) == "table" then
				f = ViewGuard.vec(args.focus)
			elseif type(args.focus) == "string" then
				local pos = resolveTargetPos(args.focus)
				if pos then f = pos end
			end
			if f then
				camera.Focus = CFrame.new(f)
				applied[#applied + 1] = "focus"
			end
		end
		local cf = camera.CFrame
		return true, {
			ok = true,
			applied = applied,
			camera = {
				position = { cf.Position.X, cf.Position.Y, cf.Position.Z },
				lookVector = { cf.LookVector.X, cf.LookVector.Y, cf.LookVector.Z },
				fov = camera.FieldOfView,
			},
		}
	end

	HANDLERS.raycast = function(args)
		local Workspace = game:GetService("Workspace")
		local origin
		local direction
		if args.fromCamera then
			local camera = Workspace.CurrentCamera
			if not camera then return false, { error = "no_camera" } end
			origin = camera.CFrame.Position
			if args.direction then
				direction = Vector3.new(args.direction[1] or 0, args.direction[2] or 0, args.direction[3] or 0)
			else
				direction = camera.CFrame.LookVector
			end
		else
			if not args.origin then return false, { error = "bad_args", hint = "origin or fromCamera required." } end
			if not args.direction then return false, { error = "bad_args", hint = "direction required." } end
			origin = Vector3.new(args.origin[1] or 0, args.origin[2] or 0, args.origin[3] or 0)
			direction = Vector3.new(args.direction[1] or 0, args.direction[2] or 0, args.direction[3] or 0)
		end
		if direction.Magnitude < 1e-6 then
			return false, { error = "bad_args", hint = "direction must be non-zero" }
		end
		local length = tonumber(args.length)
		if not length then
			length = direction.Magnitude
			if length < 1 then length = 500 end
		end
		local castVec = direction.Unit * length
		local params = RaycastParams.new()
		params.FilterType = Enum.RaycastFilterType.Exclude
		if args.ignore and type(args.ignore) == "table" then
			local ignoreList = {}
			for _, refPath in ipairs(args.ignore) do
				local inst = resolveTargetPos(refPath) -- only resolves position; need instance
				-- Resolve to instance manually:
				local cur = game
				for seg in string.gmatch(tostring(refPath), "[^.]+") do
					if cur == game and (seg == "game" or seg == "Game") then
						-- skip
					else
						cur = cur:FindFirstChild(seg)
						if not cur then break end
					end
				end
				if cur and cur ~= game then ignoreList[#ignoreList + 1] = cur end
				local _ = inst -- unused
			end
			params.FilterDescendantsInstances = ignoreList
		end
		local result = Workspace:Raycast(origin, castVec, params)
		if not result then
			return true, {
				hit = false,
				origin = { origin.X, origin.Y, origin.Z },
				direction = { castVec.X, castVec.Y, castVec.Z },
				length = length,
			}
		end
		return true, {
			hit = true,
			instance = result.Instance and result.Instance:GetFullName() or nil,
			class = result.Instance and result.Instance.ClassName or nil,
			position = { result.Position.X, result.Position.Y, result.Position.Z },
			normal = { result.Normal.X, result.Normal.Y, result.Normal.Z },
			material = tostring(result.Material.Name),
			distance = result.Distance,
		}
	end
end

-- Server-side bus loop. Called from init.server.luau on the Server-DataModel
-- clone of the plugin during Play Solo (RunService:IsRunning() and IsServer()).
-- Studio shares the `plugin` global across plugin script clones, so
-- _plugin:SetSetting / :GetSetting hit the same key/value store as the edit-DM
-- plugin — that's our cross-DM channel.
function PlaytestBus.startServerBus()
	local Players = game:GetService("Players")
	local LogService = game:GetService("LogService")
	local StudioTestService = game:GetService("StudioTestService")

	if not RunService:IsRunning() then return end

	local logs = {}
	local errors = {}
	local MAX_LOG = 500

	LogService.MessageOut:Connect(function(msg, mt)
		if #logs >= MAX_LOG then table.remove(logs, 1) end
		logs[#logs + 1] = { msg = msg, type = tostring(mt) }
		if mt == Enum.MessageType.MessageError then
			if #errors >= MAX_LOG then table.remove(errors, 1) end
			errors[#errors + 1] = msg
		end
	end)

	local function getS(key)
		if not _plugin then return nil end
		local ok, v = pcall(function() return _plugin:GetSetting(key) end)
		if ok then return v end
		return nil
	end
	local function setS(key, value)
		if not _plugin then return end
		pcall(function() _plugin:SetSetting(key, value) end)
	end

	local function resolvePlayer(hint)
		if hint ~= nil then
			local asNum = tonumber(hint)
			if asNum then
				local p = Players:GetPlayerByUserId(asNum)
				if p then return p end
			end
			if type(hint) == "string" then
				for _, p in ipairs(Players:GetPlayers()) do
					if p.Name == hint then return p end
				end
			end
		end
		return Players:GetPlayers()[1]
	end

	-- Wait briefly for first character to spawn (Players[1] exists before
	-- LoadCharacter completes).
	local function waitForCharacter(plr, sec)
		sec = sec or 5
		if plr.Character and plr.Character:FindFirstChild("HumanoidRootPart") then
			return plr.Character
		end
		local deadline = os.clock() + sec
		while os.clock() < deadline do
			if plr.Character and plr.Character:FindFirstChild("HumanoidRootPart") then
				return plr.Character
			end
			task.wait(0.1)
		end
		return plr.Character
	end

	local function resolveCharacter(args)
		local plr = resolvePlayer(args.player)
		if not plr then return nil, nil, nil, "no_player" end
		local char = waitForCharacter(plr, 5)
		if not char then return nil, nil, nil, "no_character" end
		local hum = char:FindFirstChildOfClass("Humanoid")
		local hrp = char:FindFirstChild("HumanoidRootPart")
		if not hum or not hrp then return nil, char, nil, "no_character" end
		return hum, char, hrp, nil
	end

	local HANDLERS = {}

	-- tune: run arbitrary Luau inside the running play DM (server context). This
	-- mirrors Transport.luau's `eval` handler exactly — same ok / compile_error /
	-- runtime_error shapes, same {__void=true} sentinel for a nil return — so the
	-- MCP server can treat a play-DM `tune` result the same as an edit-DM eval.
	--
	-- This clone runs with plugin security, where loadstring is available. Guard
	-- anyway in case some Studio context strips it.
	-- Compile a chunk INSIDE the play DM. Two routes, because neither is reliable:
	--   loadstring is gated by a place setting (and ServerScriptService.LoadStringEnabled
	--   is no longer even a member, so it cannot be turned on from here).
	--   ModuleScript.Source + require needs the elevated security the plugin clone
	--   may or may not carry. require caches per Instance, so a fresh one each call.
	HANDLERS.tune = function(args)
		local fn, compileErr, via = compileChunk(tostring(args.luau or ""))
		if not fn then
			return false, { code = compileErr and compileErr.code or "compile_error", message = compileErr and compileErr.message or "compile failed" }
		end
		local ok, ret = pcall(fn)
		if not ok then
			return false, { code = "runtime_error", message = tostring(ret) }
		end
		if ret == nil then
			ret = { __void = true }
		end
		if type(ret) == "table" and ret.__via == nil then ret.__via = via end
		return true, ret
	end

	HANDLERS.character_state = function(args)
		local hum, char, hrp, err = resolveCharacter(args)
		if err then return false, { error = err } end
		local toolInst = char:FindFirstChildOfClass("Tool")
		return true, {
			position = { hrp.Position.X, hrp.Position.Y, hrp.Position.Z },
			velocity = { hrp.AssemblyLinearVelocity.X, hrp.AssemblyLinearVelocity.Y, hrp.AssemblyLinearVelocity.Z },
			health = hum.Health,
			maxHealth = hum.MaxHealth,
			walkSpeed = hum.WalkSpeed,
			jumpPower = hum.JumpPower,
			jumpHeight = hum.JumpHeight,
			moveDirection = { hum.MoveDirection.X, hum.MoveDirection.Y, hum.MoveDirection.Z },
			state = tostring(hum:GetState().Name),
			isOnGround = hum.FloorMaterial ~= Enum.Material.Air,
			equippedTool = toolInst and toolInst.Name or nil,
			characterName = char.Name,
		}
	end

	HANDLERS.character_teleport = function(args)
		local hum, char, hrp, err = resolveCharacter(args)
		if err then return false, { error = err } end
		local fromV = hrp.Position
		local toV
		if args.position then
			toV = Vector3.new(args.position[1] or 0, args.position[2] or 0, args.position[3] or 0)
		elseif args.target then
			local tpos = resolveTargetPos(args.target)
			if not tpos then return false, { error = "target_not_found", target = args.target } end
			toV = tpos + Vector3.new(0, 5, 0)
		else
			return false, { error = "bad_args", hint = "Pass position or target." }
		end
		hrp.CFrame = CFrame.new(toV)
		return true, {
			ok = true,
			from = { fromV.X, fromV.Y, fromV.Z },
			to = { toV.X, toV.Y, toV.Z },
		}
	end

	-- Take server-side network ownership of the character so server-driven Move()
	-- and property writes aren't clobbered by the local client (who, in Play Solo,
	-- owns their own character by default). Idempotent — safe to call repeatedly.
	local function seizeAuthority(hrp)
		pcall(function() hrp:SetNetworkOwner(nil) end)
	end

	HANDLERS.character_walk = function(args)
		local hum, char, hrp, err = resolveCharacter(args)
		if err then return false, { error = err } end
		if not args.direction then return false, { error = "bad_args", hint = "direction is required." } end
		seizeAuthority(hrp)
		local raw = Vector3.new(args.direction[1] or 0, args.direction[2] or 0, args.direction[3] or 0)
		if raw.Magnitude < 1e-6 then
			return false, { error = "bad_args", hint = "direction must be non-zero" }
		end
		local dir = raw.Unit
		local dur = math.min(math.max(tonumber(args.duration) or 1, 0), 10)
		-- Humanoid:Move() is for client-side input emulation; on the server it gets
		-- overridden by client control even after SetNetworkOwner. Humanoid:MoveTo()
		-- is the right server-side primitive — it commands the humanoid AI to walk
		-- to a target point at WalkSpeed. Compute target from direction + duration.
		local target = hrp.Position + dir * (hum.WalkSpeed * dur)
		hum:MoveTo(target)
		task.wait(dur)
		-- Stop by writing MoveDirection directly via :Move(zero). Don't use MoveTo
		-- to "cancel" — chaining MoveTo calls leaves the AI in a confused state
		-- that breaks subsequent jumps and walks.
		hum:Move(Vector3.zero, false)
		return true, {
			ok = true,
			walked = true,
			duration = dur,
			target = { target.X, target.Y, target.Z },
			finalPosition = { hrp.Position.X, hrp.Position.Y, hrp.Position.Z },
		}
	end

	HANDLERS.character_jump = function(args)
		local hum, char, hrp, err = resolveCharacter(args)
		if err then return false, { error = err } end
		seizeAuthority(hrp)
		-- Belt + suspenders: drive Humanoid.Jump (client-input style) AND change
		-- state AND apply an impulse for the velocity itself. Server-side jumps
		-- are flaky if you rely on any single mechanism — the client (who owns
		-- input replication in Play Solo) tends to override pure state changes.
		hum.Jump = true
		hum:ChangeState(Enum.HumanoidStateType.Jumping)
		local jp = hum.JumpPower
		if jp and jp > 0 then
			local mass = hrp.AssemblyMass
			pcall(function() hrp:ApplyImpulse(Vector3.new(0, jp * mass, 0)) end)
		end
		return true, { ok = true, jumped = true, jumpPower = jp, state = tostring(hum:GetState().Name) }
	end

	HANDLERS.character_set = function(args)
		local hum, char, hrp, err = resolveCharacter(args)
		if err then return false, { error = err } end
		seizeAuthority(hrp)
		local applied = {}
		local map = {
			walkSpeed = "WalkSpeed",
			jumpPower = "JumpPower",
			jumpHeight = "JumpHeight",
			maxHealth = "MaxHealth",
			health = "Health",
			autoRotate = "AutoRotate",
			hipHeight = "HipHeight",
		}
		for k, prop in pairs(map) do
			if args[k] ~= nil then
				hum[prop] = args[k]
				applied[#applied + 1] = k
			end
		end
		return true, { ok = true, applied = applied }
	end

	HANDLERS.character_respawn = function(args)
		local plr = resolvePlayer(args.player)
		if not plr then return false, { error = "no_player" } end
		plr:LoadCharacter()
		local newChar = waitForCharacter(plr, 5)
		if not newChar then return false, { error = "respawn_timeout" } end
		return true, { ok = true, respawned = true, characterName = newChar.Name }
	end

	HANDLERS.players_state = function(args)
		local out = {}
		for _, plr in ipairs(Players:GetPlayers()) do
			local char = plr.Character
			local entry = {
				name = plr.Name,
				userId = plr.UserId,
				hasCharacter = char ~= nil,
			}
			if char then
				local hrp = char:FindFirstChild("HumanoidRootPart")
				if hrp then
					entry.position = { hrp.Position.X, hrp.Position.Y, hrp.Position.Z }
				end
				local hum = char:FindFirstChildOfClass("Humanoid")
				if hum then
					entry.health = hum.Health
					entry.walkSpeed = hum.WalkSpeed
					entry.jumpPower = hum.JumpPower
				end
			end
			out[#out + 1] = entry
		end
		return true, { players = out, count = #out }
	end

	addViewHandlers(HANDLERS)

	-- Read-only: the edit DM owns the inbox (see PlaytestBus.send).
	local seen = {}
	local function popInbox()
		local raw = getS(KEY_INBOX .. "server")
		if type(raw) ~= "string" or #raw == 0 then return {} end
		local ok, decoded = pcall(function() return HttpService:JSONDecode(raw) end)
		if not ok or type(decoded) ~= "table" then return {} end
		local fresh = {}
		for _, id in ipairs(decoded) do
			if not seen[id] then
				seen[id] = true
				fresh[#fresh + 1] = id
			end
		end
		return fresh
	end

	local function processCommand(id)
		local raw = getS(KEY_CMD .. id)
		if type(raw) ~= "string" or #raw == 0 then return end
		setS(KEY_CMD .. id, nil) -- consume
		local okDec, cmd = pcall(function() return HttpService:JSONDecode(raw) end)
		if not okDec or type(cmd) ~= "table" then
			setS(KEY_RESULT .. id, HttpService:JSONEncode({ ok = false, error = { code = "decode_failed" } }))
			return
		end
		local handler = HANDLERS[cmd.tool]
		if not handler then
			setS(KEY_RESULT .. id, HttpService:JSONEncode({ ok = false, error = { code = "unknown_tool", tool = cmd.tool } }))
			return
		end
		local ok, success, ret = pcall(handler, cmd.args or {})
		local resultPayload
		if not ok then
			resultPayload = { ok = false, error = { code = "handler_error", message = tostring(success) } }
		elseif success then
			resultPayload = { ok = true, value = ret }
		else
			resultPayload = { ok = false, error = ret }
		end
		local okEnc, encoded = pcall(function() return HttpService:JSONEncode(resultPayload) end)
		if not okEnc then
			encoded = HttpService:JSONEncode({
				ok = false,
				error = { code = "encode_failed", message = tostring(encoded) },
			})
		end
		setS(KEY_RESULT .. id, encoded)
	end

	print("[Cubes MCP bootstrap] play-DM bus running")

	local playersWrittenAt = -math.huge
	-- os.time() has 1s resolution, so rewriting it every 0.05s tick stored the
	-- same value 20 times. Write only when it changes; ALIVE_WINDOW is 5s.
	local aliveWritten = nil
	while RunService:IsRunning() do
		local now = os.time()
		if now ~= aliveWritten then
			aliveWritten = now
			setS(KEY_ALIVE .. "server", now)
		end
		if os.clock() - playersWrittenAt >= PLAYERS_EVERY then
			playersWrittenAt = os.clock()
			local names = {}
			for _, p in ipairs(Players:GetPlayers()) do names[#names + 1] = p.Name end
			table.sort(names)
			setS(KEY_PLAYERS, HttpService:JSONEncode(names))
		end
		local stopRaw = getS(KEY_STOP)
		if type(stopRaw) == "string" and #stopRaw > 0 then
			setS(KEY_STOP, nil)
			local reason = "stopped_by_mcp"
			local okDec, decoded = pcall(function() return HttpService:JSONDecode(stopRaw) end)
			if okDec and type(decoded) == "table" and decoded.reason then
				reason = tostring(decoded.reason)
			end
			pcall(function()
				StudioTestService:EndTest({ logs = logs, errors = errors, reason = reason })
			end)
			break
		end
		-- Spawned, so a long command (character_walk, a waiting tune) doesn't
		-- stall the heartbeat and read as the session ending.
		for _, id in ipairs(popInbox()) do
			task.spawn(processCommand, id)
		end
		task.wait(0.05)
	end
	setS(KEY_ALIVE .. "server", nil)
	setS(KEY_PLAYERS, nil)
end

-- ---------------------------------------------------------------------------
-- Generic instrumentation: capture + client eval
--
-- Everything that matters about a camera, a GUI or any render-time signal only
-- exists in the play DM's CLIENT context, which nothing could reach before.
-- ---------------------------------------------------------------------------

-- Sample a caller-supplied function every frame and hand back dense numeric
-- channels. The caller sends a chunk that RETURNS a sampler function; the
-- sampler returns a flat table of numbers, whose keys become channel names.
-- Deliberately dumb about meaning: any signal, any subsystem.
local function makeCaptureHandler(isClient)
	return function(args)
		local fn, err = compileChunk(tostring(args.setup or ""))
		if not fn then return false, err end
		local okSetup, sampler = pcall(fn)
		if not okSetup then
			return false, { code = "setup_error", message = tostring(sampler) }
		end
		if type(sampler) ~= "function" then
			return false, {
				code = "setup_error",
				message = "the setup chunk must RETURN a sampler function; it returned " .. typeof(sampler),
			}
		end

		local RunService = game:GetService("RunService")
		local duration = math.clamp(tonumber(args.duration) or 3, 0.1, 20)
		local hz = math.clamp(tonumber(args.hz) or 60, 1, 240)
		local step = 1 / hz

		local t, chans, order, n = {}, {}, {}, 0
		local elapsed, acc, done, sampleErr = 0, math.huge, false, nil
		-- RenderStepped is the only place a camera offset is observable; the
		-- server has no such frame, so it samples physics instead.
		local sig = if isClient then RunService.RenderStepped else RunService.Heartbeat

		local conn
		conn = sig:Connect(function(dt)
			if done then return end
			elapsed += dt
			acc += dt
			if acc < step then return end
			acc = 0
			local ok, row = pcall(sampler, elapsed)
			if not ok then
				sampleErr = tostring(row)
				done = true
				return
			end
			if type(row) == "table" then
				n += 1
				t[n] = elapsed
				for k, v in pairs(row) do
					local num = tonumber(v)
					if num then
						local c = chans[k]
						if not c then
							c = {}
							chans[k] = c
							order[#order + 1] = k
						end
						c[n] = num
					end
				end
			end
			if elapsed >= duration then done = true end
		end)

		local deadline = os.clock() + duration + 3
		while not done and os.clock() < deadline do
			task.wait(0.03)
		end
		conn:Disconnect()

		if sampleErr then
			return false, { code = "sampler_error", message = sampleErr, samplesBefore = n }
		end
		if n == 0 then
			return false, { code = "no_samples", message = "the sampler never returned a table of numbers" }
		end
		-- A nil hole would make JSON encode the channel as an object instead of
		-- an array, which silently breaks every downstream index.
		for _, k in ipairs(order) do
			local c = chans[k]
			for i = 1, n do
				if c[i] == nil then c[i] = 0 end
			end
		end
		local total = n * #order
		if total > 24000 then
			return false, {
				code = "too_much_data",
				message = string.format("capture would return %d numbers; lower hz or duration", total),
			}
		end
		return true, {
			context = if isClient then "client" else "server",
			sampleCount = n,
			duration = elapsed,
			hz = hz,
			channelNames = order,
			t = t,
			channels = chans,
		}
	end
end

-- One bus loop, shared by contexts. Commands run spawned, not inline, so a
-- long capture cannot starve the heartbeat and make the edit DM think the
-- session died mid-measurement.
-- shouldServe, when given, is asked every tick; while it says no, this loop
-- neither claims the context (alive) nor takes its commands.
local function runBusLoop(ctx, HANDLERS, shouldServe)
	local RunService = game:GetService("RunService")
	local aliveKey = KEY_ALIVE .. ctx
	rememberCtx(ctx)
	local inboxKey = KEY_INBOX .. ctx

	-- Read-only: the edit DM owns the inbox (see PlaytestBus.send).
	local seen = {}
	local function popInbox()
		local raw = getSetting(inboxKey)
		if type(raw) ~= "string" or #raw == 0 then return {} end
		local ok, decoded = pcall(function() return HttpService:JSONDecode(raw) end)
		if not ok or type(decoded) ~= "table" then return {} end
		local fresh = {}
		for _, id in ipairs(decoded) do
			if not seen[id] then
				seen[id] = true
				fresh[#fresh + 1] = id
			end
		end
		return fresh
	end

	local function processCommand(id)
		local raw = getSetting(KEY_CMD .. id)
		if type(raw) ~= "string" or #raw == 0 then return end
		setSetting(KEY_CMD .. id, nil)
		local okDec, cmd = pcall(function() return HttpService:JSONDecode(raw) end)
		if not okDec or type(cmd) ~= "table" then
			setSetting(KEY_RESULT .. id, HttpService:JSONEncode({ ok = false, error = { code = "decode_failed" } }))
			return
		end
		local handler = HANDLERS[cmd.tool]
		if not handler then
			setSetting(KEY_RESULT .. id, HttpService:JSONEncode({
				ok = false,
				error = { code = "unknown_tool", tool = cmd.tool, context = ctx },
			}))
			return
		end
		local ok, success, ret = pcall(handler, cmd.args or {})
		local payload
		if not ok then
			payload = { ok = false, error = { code = "handler_error", message = tostring(success) } }
		elseif success then
			payload = { ok = true, value = ret }
		else
			payload = { ok = false, error = ret }
		end
		local okEnc, encoded = pcall(function() return HttpService:JSONEncode(payload) end)
		if not okEnc then
			encoded = HttpService:JSONEncode({
				ok = false,
				error = { code = "encode_failed", message = tostring(encoded) },
			})
		end
		setSetting(KEY_RESULT .. id, encoded)
	end

	local served = false
	local aliveWritten = nil -- same 1s-resolution dedupe as the server bus
	while RunService:IsRunning() do
		if not shouldServe or shouldServe() then
			served = true
			local now = os.time()
			if now ~= aliveWritten then
				aliveWritten = now
				setSetting(aliveKey, now)
			end
			for _, id in ipairs(popInbox()) do
				task.spawn(processCommand, id)
			end
		end
		task.wait(0.05)
	end
	if served then
		setSetting(aliveKey, nil)
	end
end

-- Client-side bus. Started from init.server.luau on the play DM's Client clone,
-- which previously just printed "idle" and did nothing.
function PlaytestBus.startClientBus()
	local RunService = game:GetService("RunService")
	if not RunService:IsRunning() or not RunService:IsClient() then return end

	local HANDLERS = {}

	HANDLERS.client_eval = function(args)
		local fn, err, via = compileChunk(tostring(args.luau or ""))
		if not fn then return false, err end
		local ok, ret = pcall(fn)
		if not ok then return false, { code = "runtime_error", message = tostring(ret) } end
		if ret == nil then ret = { __void = true } end
		if type(ret) == "table" and ret.__via == nil then ret.__via = via end
		return true, ret
	end

	HANDLERS.signal_capture = makeCaptureHandler(true)
	addViewHandlers(HANDLERS)

	-- Every client answers to its own name; one client claims plain "client",
	-- so a call without a player keeps one target. GetPlayers() can't decide
	-- it: a client that starts early doesn't see the others yet.
	local Players = game:GetService("Players")
	local me = Players.LocalPlayer
	while not me do
		task.wait(0.05)
		me = Players.LocalPlayer
	end
	-- The claim is "name|os.time()", refreshed while held. A client claims
	-- only a missing or stale one, and serves from the tick after, so two
	-- clients claiming together settle on the last writer before either serves.
	local function ownsClientInbox()
		local raw = getSetting(KEY_OWNER)
		local name, at = nil, nil
		if type(raw) == "string" then
			name, at = raw:match("^(.*)|(%d+)$")
			at = tonumber(at)
		end
		local mine = name == me.Name
		-- The claim holds whole seconds; rewriting an identical one is a no-op.
		if (mine and at ~= os.time()) or at == nil or os.time() - at > ALIVE_WINDOW then
			setSetting(KEY_OWNER, me.Name .. "|" .. os.time())
		end
		return mine
	end
	print("[Cubes MCP] play-DM Client bus running for " .. me.Name)
	task.spawn(runBusLoop, "client:" .. me.Name, HANDLERS)
	runBusLoop("client", HANDLERS, ownsClientInbox)
end

-- Legacy: the bootstrap Script source we used to inject into ServerScriptService.
-- Kept for fallback; no longer called from the play_test path now that
-- init.server.luau's Server-DM clone runs startServerBus() natively (which has
-- access to the `plugin` global via Studio's cross-DM plugin sharing).
--
-- Important: the source string is plain Luau (NOT a function) because Studio
-- compiled it as a Script.Source on the play side. The separately-injected
-- Script ran without a `plugin` global, which silently broke every
-- plugin:GetSetting/SetSetting call — hence the rewrite.
local BOOTSTRAP_SOURCE = [[
--!nonstrict
-- cube's MCP play-DM bootstrap. Injected by the plugin before
-- ExecutePlayModeAsync. Reads commands via plugin:GetSetting and writes results
-- via plugin:SetSetting. The plugin (edit DM) does the inverse.

local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local LogService = game:GetService("LogService")
local StudioTestService = game:GetService("StudioTestService")
local RunService = game:GetService("RunService")

if not RunService:IsRunning() then return end

local KEY_CMD = "__cubesMCP_cmd_"
local KEY_RESULT = "__cubesMCP_result_"
local KEY_STOP = "__cubesMCP_stop"
local KEY_INBOX = "__cubesMCP_inboxserver"
local KEY_ALIVE = "__cubesMCP_aliveserver"

local logs = {}
local errors = {}
local MAX_LOG = 500

LogService.MessageOut:Connect(function(msg, mt)
	if #logs >= MAX_LOG then table.remove(logs, 1) end
	logs[#logs + 1] = { msg = msg, type = tostring(mt) }
	if mt == Enum.MessageType.MessageError then
		if #errors >= MAX_LOG then table.remove(errors, 1) end
		errors[#errors + 1] = msg
	end
end)

local function getS(key)
	local ok, v = pcall(function() return plugin:GetSetting(key) end)
	if ok then return v end
	return nil
end
local function setS(key, value)
	pcall(function() plugin:SetSetting(key, value) end)
end

local function resolvePlayer(hint)
	if hint ~= nil then
		local asNum = tonumber(hint)
		if asNum then
			local p = Players:GetPlayerByUserId(asNum)
			if p then return p end
		end
		if type(hint) == "string" then
			for _, p in ipairs(Players:GetPlayers()) do
				if p.Name == hint then return p end
			end
		end
	end
	return Players:GetPlayers()[1]
end

-- Wait briefly for first character to spawn (Players[1] exists before
-- LoadCharacter completes).
local function waitForCharacter(plr, sec)
	sec = sec or 5
	if plr.Character and plr.Character:FindFirstChild("HumanoidRootPart") then
		return plr.Character
	end
	local deadline = os.clock() + sec
	while os.clock() < deadline do
		if plr.Character and plr.Character:FindFirstChild("HumanoidRootPart") then
			return plr.Character
		end
		task.wait(0.1)
	end
	return plr.Character
end

local function resolveCharacter(args)
	local plr = resolvePlayer(args.player)
	if not plr then return nil, nil, nil, "no_player" end
	local char = waitForCharacter(plr, 5)
	if not char then return nil, nil, nil, "no_character" end
	local hum = char:FindFirstChildOfClass("Humanoid")
	local hrp = char:FindFirstChild("HumanoidRootPart")
	if not hum or not hrp then return nil, char, nil, "no_character" end
	return hum, char, hrp, nil
end

-- Try to resolve a target hint (instance path like "workspace.SomePart") to a
-- position Vector3. The play DM has no Refs table, so we accept dotted paths
-- and basic names. Returns Vector3 or nil.
local function resolveTargetPos(target)
	if type(target) ~= "string" then return nil end
	local cur = game
	for seg in string.gmatch(target, "[^.]+") do
		if cur == game and (seg == "game" or seg == "Game") then
			-- skip
		else
			cur = cur:FindFirstChild(seg)
			if not cur then return nil end
		end
	end
	if cur and cur:IsA("BasePart") then return cur.Position end
	if cur and cur:IsA("Model") then
		local ok, pivot = pcall(function() return cur:GetPivot().Position end)
		if ok then return pivot end
	end
	if cur and cur:IsA("Attachment") then return cur.WorldPosition end
	return nil
end

local HANDLERS = {}

-- Compile a chunk INSIDE the play DM. Two routes, because neither is reliable:
--   loadstring is gated by a place setting (and ServerScriptService.LoadStringEnabled
--   is no longer even a member, so it cannot be turned on from here).
--   ModuleScript.Source + require needs the elevated security the plugin clone
--   may or may not carry. require caches per Instance, so a fresh one each call.
local function _tuneCompile(src)
	local okLs, produced = pcall(function() return loadstring(src) end)
	if okLs and type(produced) == "function" then return produced, nil, "loadstring" end
	if okLs and produced == nil then
		-- loadstring worked and the chunk itself is malformed: that is a real
		-- compile error, not a missing capability. Re-run for the message.
		local _, _, err = pcall(function() return loadstring(src) end)
		return nil, { code = "compile_error", message = tostring(err) }, nil
	end
	local m = Instance.new("ModuleScript")
	local nl = string.char(10)
	local okSrc = pcall(function() m.Source = "return function()" .. nl .. src .. nl .. "end" end)
	if not okSrc then
		m:Destroy()
		return nil, {
			code = "no_compiler",
			message = "the play DM allows neither loadstring (" .. tostring(produced) .. ") nor ModuleScript.Source",
		}, nil
	end
	m.Parent = game:GetService("ServerScriptService")
	local okReq, maker = pcall(require, m)
	m:Destroy()
	if not okReq then
		return nil, { code = "compile_error", message = tostring(maker) }, nil
	end
	if type(maker) ~= "function" then
		return nil, { code = "compile_error", message = "chunk did not produce a function" }, nil
	end
	return maker, nil, "modulescript"
end


-- tune: run arbitrary Luau in the play DM (server context). Mirrors the edit-DM
-- eval handler — ok / compile_error / runtime_error, {__void=true} for nil.
HANDLERS.tune = function(args)
	local fn, compileErr, via = _tuneCompile(tostring(args.luau or ""))
	if not fn then
		return false, { code = compileErr and compileErr.code or "compile_error", message = compileErr and compileErr.message or "compile failed" }
	end
	local ok, ret = pcall(fn)
	if not ok then
		return false, { code = "runtime_error", message = tostring(ret) }
	end
	if ret == nil then
		ret = { __void = true }
	end
	if type(ret) == "table" and ret.__via == nil then ret.__via = via end
	return true, ret
end

HANDLERS.character_state = function(args)
	local hum, char, hrp, err = resolveCharacter(args)
	if err then return false, { error = err } end
	local toolInst = char:FindFirstChildOfClass("Tool")
	return true, {
		position = { hrp.Position.X, hrp.Position.Y, hrp.Position.Z },
		velocity = { hrp.AssemblyLinearVelocity.X, hrp.AssemblyLinearVelocity.Y, hrp.AssemblyLinearVelocity.Z },
		health = hum.Health,
		maxHealth = hum.MaxHealth,
		walkSpeed = hum.WalkSpeed,
		jumpPower = hum.JumpPower,
		jumpHeight = hum.JumpHeight,
		moveDirection = { hum.MoveDirection.X, hum.MoveDirection.Y, hum.MoveDirection.Z },
		state = tostring(hum:GetState().Name),
		isOnGround = hum.FloorMaterial ~= Enum.Material.Air,
		equippedTool = toolInst and toolInst.Name or nil,
		characterName = char.Name,
	}
end

HANDLERS.character_teleport = function(args)
	local hum, char, hrp, err = resolveCharacter(args)
	if err then return false, { error = err } end
	local fromV = hrp.Position
	local toV
	if args.position then
		toV = Vector3.new(args.position[1] or 0, args.position[2] or 0, args.position[3] or 0)
	elseif args.target then
		local tpos = resolveTargetPos(args.target)
		if not tpos then return false, { error = "target_not_found", target = args.target } end
		toV = tpos + Vector3.new(0, 5, 0)
	else
		return false, { error = "bad_args", hint = "Pass position or target." }
	end
	hrp.CFrame = CFrame.new(toV)
	return true, {
		ok = true,
		from = { fromV.X, fromV.Y, fromV.Z },
		to = { toV.X, toV.Y, toV.Z },
	}
end

HANDLERS.character_walk = function(args)
	local hum, char, hrp, err = resolveCharacter(args)
	if err then return false, { error = err } end
	if not args.direction then return false, { error = "bad_args", hint = "direction is required." } end
	local dir = Vector3.new(args.direction[1] or 0, args.direction[2] or 0, args.direction[3] or 0)
	local dur = math.min(math.max(tonumber(args.duration) or 1, 0), 10)
	hum:Move(dir, false)
	task.wait(dur)
	hum:Move(Vector3.zero, false)
	return true, {
		ok = true,
		walked = true,
		duration = dur,
		finalPosition = { hrp.Position.X, hrp.Position.Y, hrp.Position.Z },
	}
end

HANDLERS.character_jump = function(args)
	local hum, char, hrp, err = resolveCharacter(args)
	if err then return false, { error = err } end
	hum:ChangeState(Enum.HumanoidStateType.Jumping)
	return true, { ok = true, jumped = true, state = tostring(hum:GetState().Name) }
end

HANDLERS.character_set = function(args)
	local hum, char, hrp, err = resolveCharacter(args)
	if err then return false, { error = err } end
	local applied = {}
	local map = {
		walkSpeed = "WalkSpeed",
		jumpPower = "JumpPower",
		jumpHeight = "JumpHeight",
		maxHealth = "MaxHealth",
		health = "Health",
		autoRotate = "AutoRotate",
		hipHeight = "HipHeight",
	}
	for k, prop in pairs(map) do
		if args[k] ~= nil then
			hum[prop] = args[k]
			applied[#applied + 1] = k
		end
	end
	return true, { ok = true, applied = applied }
end

HANDLERS.character_respawn = function(args)
	local plr = resolvePlayer(args.player)
	if not plr then return false, { error = "no_player" } end
	plr:LoadCharacter()
	local newChar = waitForCharacter(plr, 5)
	if not newChar then return false, { error = "respawn_timeout" } end
	return true, { ok = true, respawned = true, characterName = newChar.Name }
end

HANDLERS.players_state = function(args)
	local out = {}
	for _, plr in ipairs(Players:GetPlayers()) do
		local char = plr.Character
		local entry = {
			name = plr.Name,
			userId = plr.UserId,
			hasCharacter = char ~= nil,
		}
		if char then
			local hrp = char:FindFirstChild("HumanoidRootPart")
			if hrp then
				entry.position = { hrp.Position.X, hrp.Position.Y, hrp.Position.Z }
			end
			local hum = char:FindFirstChildOfClass("Humanoid")
			if hum then
				entry.health = hum.Health
				entry.walkSpeed = hum.WalkSpeed
				entry.jumpPower = hum.JumpPower
			end
		end
		out[#out + 1] = entry
	end
	return true, { players = out, count = #out }
end

local seen = {}
local function popInbox()
	local raw = getS(KEY_INBOX)
	if type(raw) ~= "string" or #raw == 0 then return {} end
	local ok, decoded = pcall(function() return HttpService:JSONDecode(raw) end)
	if not ok or type(decoded) ~= "table" then return {} end
	local fresh = {}
	for _, id in ipairs(decoded) do
		if not seen[id] then
			seen[id] = true
			fresh[#fresh + 1] = id
		end
	end
	return fresh
end

local function processCommand(id)
	local raw = getS(KEY_CMD .. id)
	if type(raw) ~= "string" or #raw == 0 then return end
	setS(KEY_CMD .. id, nil) -- consume
	local okDec, cmd = pcall(function() return HttpService:JSONDecode(raw) end)
	if not okDec or type(cmd) ~= "table" then
		setS(KEY_RESULT .. id, HttpService:JSONEncode({ ok = false, error = { code = "decode_failed" } }))
		return
	end
	local handler = HANDLERS[cmd.tool]
	if not handler then
		setS(KEY_RESULT .. id, HttpService:JSONEncode({ ok = false, error = { code = "unknown_tool", tool = cmd.tool } }))
		return
	end
	local ok, success, ret = pcall(handler, cmd.args or {})
	local resultPayload
	if not ok then
		resultPayload = { ok = false, error = { code = "handler_error", message = tostring(success) } }
	elseif success then
		resultPayload = { ok = true, value = ret }
	else
		resultPayload = { ok = false, error = ret }
	end
	setS(KEY_RESULT .. id, HttpService:JSONEncode(resultPayload))
end

print("[Cubes MCP bootstrap] play-DM bus running")

while RunService:IsRunning() do
	setS(KEY_ALIVE, os.time())
	local stopRaw = getS(KEY_STOP)
	if type(stopRaw) == "string" and #stopRaw > 0 then
		setS(KEY_STOP, nil)
		local reason = "stopped_by_mcp"
		local okDec, decoded = pcall(function() return HttpService:JSONDecode(stopRaw) end)
		if okDec and type(decoded) == "table" and decoded.reason then
			reason = tostring(decoded.reason)
		end
		pcall(function()
			StudioTestService:EndTest({ logs = logs, errors = errors, reason = reason })
		end)
		break
	end
	local ids = popInbox()
	for _, id in ipairs(ids) do
		processCommand(id)
	end
	task.wait(0.05)
end
setS(KEY_ALIVE, nil)
]]

function PlaytestBus.bootstrapSource()
	return BOOTSTRAP_SOURCE
end

-- Ensure (create or refresh) the bootstrap Script in ServerScriptService so
-- that ExecutePlayModeAsync clones it into the play DM.
function PlaytestBus.installBootstrap()
	local SSS = game:GetService("ServerScriptService")
	local existing = SSS:FindFirstChild("__CubesMCPBootstrap")
	local script_
	if existing and existing:IsA("Script") then
		script_ = existing
	else
		if existing then existing:Destroy() end
		script_ = Instance.new("Script")
		script_.Name = "__CubesMCPBootstrap"
		script_.Parent = SSS
	end
	script_.Source = BOOTSTRAP_SOURCE
	-- Belt and suspenders: ensure the script is enabled and runs on server.
	pcall(function() script_.Enabled = true end)
	pcall(function() script_.RunContext = Enum.RunContext.Server end)
	return script_
end

return PlaytestBus
