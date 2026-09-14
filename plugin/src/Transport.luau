--!nonstrict
-- HTTP long-poll client.
--
-- Studio plugins can't be servers, but they can poll: ask the MCP server for a
-- command, run it in Studio, post the result back, repeat. This module also owns
-- the live connection `status` table that the StatusUi panel renders.

local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")
local StudioTestService = game:GetService("StudioTestService")

local Config = require(script.Parent.Config)
local Serialize = require(script.Parent.Serialize)
local Read = require(script.Parent.Read)
local Mutate = require(script.Parent.Mutate)
local Diagnostics = require(script.Parent.Diagnostics)
local Refs = require(script.Parent.Refs)
local EventWatch = require(script.Parent.EventWatch)
local PlaytestBus = require(script.Parent.PlaytestBus)
local Snapshot = require(script.Parent.Snapshot)
local HudOverlay = require(script.Parent.HudOverlay)
local ViewGuard = require(script.Parent.ViewGuard)
local MeshTools = require(script.Parent.MeshTools)

local Transport = {}

-- StudioTestService session state. Module-level so it survives across dispatch
-- calls (the plugin keeps polling across edit→play→edit transitions).
local _STS_running = false
local _STS_mode = "edit"  -- "edit" | "run" | "play"
local _STS_lastResult = nil
-- Generation counter: each play/run start bumps this. Spawned coroutines remember
-- their generation and refuse to write state back if a newer play has superseded
-- them (play → stop → play race; old coroutine resumes after new one started).
local _STS_gen = 0

-- Live status, observed by the UI. `mode` is one of:
--   "off"                — bridge disabled, not polling
--   "connecting"         — polling started, no successful contact yet
--   "online"             — polling, MCP server responding
--   "server_unreachable" — polling, but the MCP server can't be reached
--   "version_mismatch"   — server rejected the protocol version; plugin is stale
--   "unauthorized"       — server rejected the bridge token (missing or wrong)
Transport.status = {
	polling = false,
	mode = "off",
	host = Config.HOST,
	port = Config.port,
	commandsHandled = 0,
	connectedAt = 0, -- os.clock() when the current online streak began (for uptime)
	lastPollAt = 0, -- os.clock() of last successful contact
	lastCommandTool = nil,
	lastCommandAt = 0,
	-- Panel activity label of the last command, and whether it is still running.
	lastActivity = nil,
	busy = false,
	lastError = nil,
	-- The user's "Allow writes" toggle. Sent in every poll body; the server gates
	-- every write-class command on it, and dispatch() enforces it locally too so
	-- turning it OFF takes effect immediately instead of on the next poll.
	-- Persisted; ON until the user turns it off.
	writeEnabled = true,
	-- Bridge bearer token (the server's ~/.cubesmcp/token). Persisted.
	token = "",
	-- When true, the plugin polls but rejects every command with code "paused"
	-- so you can work in Studio without Claude clobbering changes.
	paused = false,
	-- Recent operation log (most-recent last). Capped at OP_LOG_MAX.
	opLog = {},
	-- Rolling error count since the panel was last cleared.
	errorCount = 0,
	-- Plugin protocol version reported to the server in every /poll.
	protocolVersion = Config.PROTOCOL_VERSION,
}

local OP_LOG_MAX = 25

-- Commands that never change the place. Mirrors the server's derived set
-- (rpcReadOnlyCommands in src/rpc-policy.ts); everything else needs writes ON.
local READ_ONLY_COMMANDS = {
	read = true,
	diagnostics = true,
	viewport = true,
	snapshot = true,
	playtest_result = true,
	players_state = true,
	character_state = true,
	event_drain = true,
	viewport_capture = true,
	raycast = true,
	capture = true,
	mesh_bake = true,
}

-- Panel activity label for a command. The server sends the one-word label as
-- via.activity (src/activity.ts, where every tool has one). Commands sent
-- outside any tool call (a resource read, a startup probe) carry no via; those
-- few low-level commands are labelled here.
local FALLBACK_ACTIVITY = {
	read = "Reading",
	eval = "Executing",
	diagnostics = "Debugging",
	viewport = "Looking",
	capture = "Looking",
	snapshot = "Capturing",
}

local MUTATE_ACTIVITY = { script = "Scripting", script_create = "Scripting", delete = "Deleting", create = "Building" }

local function activityFor(cmd)
	local via = type(cmd.via) == "table" and cmd.via or nil
	if via and type(via.activity) == "string" and via.activity ~= "" then
		return via.activity
	end
	if cmd.tool == "mutate" then
		local ok, kind = pcall(HudOverlay.mutateKind, cmd.args)
		return (ok and MUTATE_ACTIVITY[kind]) or "Editing"
	end
	return FALLBACK_ACTIVITY[cmd.tool] or "Working"
end

-- What the island shows next to the word. The server's via.target is usually a
-- ref or a dotted path, so resolve it to the instance's real path and keep the
-- last two segments ("Lobby.Door"); anything that does not resolve (a player
-- name, a class, a search) is shown as given. A trailing " +N" (more ops or
-- targets in the same call) is kept.
local function islandTarget(cmd)
	local via = type(cmd.via) == "table" and cmd.via or nil
	local raw = via and via.target
	if type(raw) ~= "string" and type(cmd.args) == "table" then
		raw = cmd.args.path or cmd.args.target or cmd.args.ref
	end
	if type(raw) ~= "string" or raw == "" then return nil end
	local subject, extra = raw:match("^(.-)(%s%+%d+)$")
	subject = subject or raw
	local ok, inst = pcall(Refs.resolve, subject)
	if ok and typeof(inst) == "Instance" then
		local parts = string.split(inst:GetFullName(), ".")
		subject = #parts > 2 and (parts[#parts - 1] .. "." .. parts[#parts]) or inst:GetFullName()
	end
	return subject .. (extra or "")
end

local function requestHeaders()
	local headers = { ["Content-Type"] = "application/json" }
	if Transport.status.token ~= "" then
		headers["Authorization"] = "Bearer " .. Transport.status.token
	end
	return headers
end

local function recordOp(tool, ok, errCode)
	local entry = { tool = tool, ok = ok, at = os.clock() }
	if not ok then
		entry.err = errCode or "error"
		Transport.status.errorCount += 1
	end
	table.insert(Transport.status.opLog, entry)
	if #Transport.status.opLog > OP_LOG_MAX then
		table.remove(Transport.status.opLog, 1)
	end
end

function Transport.clearOpLog()
	Transport.status.opLog = {}
	Transport.status.errorCount = 0
	Transport.changed:Fire()
end

-- Fires whenever something display-worthy in `status` changes.
Transport.changed = Instance.new("BindableEvent")

local generation = 0

-- Cache compiled eval chunks so repeat-source calls (e.g. studio://selection)
-- don't pay `loadstring` cost every time. Bounded LRU — failures and
-- runtime errors are never cached. compiledOrder is move-to-back on hit so
-- hot entries don't get evicted by cold one-shot inserts.
local compiledCache = {}
local compiledOrder = {}
local COMPILED_CACHE_MAX = 32

local function compile(src)
	local cached = compiledCache[src]
	if cached then
		-- Move-to-back: mark this src as most-recently-used.
		for i = 1, #compiledOrder do
			if compiledOrder[i] == src then
				table.remove(compiledOrder, i)
				break
			end
		end
		compiledOrder[#compiledOrder + 1] = src
		return cached, nil
	end
	local fn, err = loadstring(src)
	if not fn then return nil, err end
	compiledCache[src] = fn
	compiledOrder[#compiledOrder + 1] = src
	if #compiledOrder > COMPILED_CACHE_MAX then
		local oldest = table.remove(compiledOrder, 1)
		compiledCache[oldest] = nil
	end
	return fn, nil
end

-- Resolve a player hint (UserId number or Name string) to a Player instance.
-- Falls back to the first player when no hint is given.
local function resolvePlayer(playerHint)
	local Players = game:GetService("Players")
	if playerHint ~= nil then
		local asNum = tonumber(playerHint)
		if asNum then
			local p = Players:GetPlayerByUserId(asNum)
			if p then return p end
		end
		if type(playerHint) == "string" then
			for _, p in ipairs(Players:GetPlayers()) do
				if p.Name == playerHint then return p end
			end
		end
	end
	return Players:GetPlayers()[1]
end

-- Resolve a target character. Priority: explicit ref (Humanoid, Model with
-- Humanoid, or character) → player.Character (player resolved by hint or default).
-- Returns (humanoid, character, hrp, err). When args.ref is supplied but does
-- not resolve to a character-shaped instance, we do NOT silently fall back to
-- the first player — matches the original eval behavior.
local function resolveCharacter(args)
	local char
	if args.ref then
		local inst = Refs.resolve(args.ref)
		if inst then
			if inst:IsA("Humanoid") then
				char = inst.Parent
			elseif inst:IsA("Model") then
				char = inst
			end
		end
		if not char then return nil, nil, nil, "no_character" end
	else
		local plr = resolvePlayer(args.player)
		if not plr then return nil, nil, nil, "no_player" end
		char = plr.Character
		if not char then return nil, nil, nil, "no_character" end
	end
	local hum = char:FindFirstChildOfClass("Humanoid")
	local hrp = char:FindFirstChild("HumanoidRootPart")
	if not hum or not hrp then return nil, char, nil, "no_character" end
	return hum, char, hrp, nil
end

-- The Plugin instance is injected by init.server.luau so we can persist a few
-- user-toggleable settings (e.g. custom port) across plugin reloads.
local _plugin = nil
function Transport.bindPlugin(pluginInstance)
	_plugin = pluginInstance
	-- custom port (persisted)
	local persistedPort = nil
	pcall(function() persistedPort = pluginInstance:GetSetting("port") end)
	if type(persistedPort) == "number" and Config.setPort(persistedPort) then
		Transport.status.host = Config.HOST
		Transport.status.port = Config.port
	end
	-- bridge token + Allow writes (persisted)
	local persistedToken, persistedWrites = nil, nil
	pcall(function()
		persistedToken = pluginInstance:GetSetting("token")
		persistedWrites = pluginInstance:GetSetting("writeEnabled")
	end)
	if type(persistedToken) == "string" then
		Transport.status.token = persistedToken
	end
	if type(persistedWrites) == "boolean" then
		Transport.status.writeEnabled = persistedWrites
	end
	-- A token baked in by `npm run setup` is adopted the first time this plugin
	-- file loads with it, so a reinstall with a new token takes effect by itself.
	-- After that a token pasted into the panel is kept until the next install.
	local baked = Config.BAKED_TOKEN
	if type(baked) == "string" and baked ~= "" and not baked:find("^__CUBES_MCP_") then
		local seen = nil
		pcall(function() seen = pluginInstance:GetSetting("bakedTokenSeen") end)
		if seen ~= baked then
			Transport.status.token = baked
			pcall(function()
				pluginInstance:SetSetting("token", baked)
				pluginInstance:SetSetting("bakedTokenSeen", baked)
			end)
		end
	end
	-- paused is intentionally NOT persisted — surprising to come back paused.
	Transport.changed:Fire()
end

-- Set the bridge token. Restarts polling so a loop backing off after a 401
-- picks the new token up now rather than on its next retry.
function Transport.setToken(token)
	token = (tostring(token or ""):gsub("^%s+", ""):gsub("%s+$", ""))
	if token == Transport.status.token then return false end
	Transport.status.token = token
	if _plugin then
		pcall(function() _plugin:SetSetting("token", token) end)
	end
	if Transport.status.polling then
		Transport.setPolling(false)
		Transport.setPolling(true)
	else
		Transport.changed:Fire()
	end
	return true
end

-- Allow writes. OFF is enforced locally at once; the server learns the new
-- value on the next poll.
function Transport.setWriteEnabled(on)
	on = on and true or false
	if on == Transport.status.writeEnabled then return end
	Transport.status.writeEnabled = on
	if _plugin then
		pcall(function() _plugin:SetSetting("writeEnabled", on) end)
	end
	Transport.changed:Fire()
end

-- Pause the bridge: keep polling so we don't drop the connection, but reject
-- every incoming command with code "paused". Lets the user work in Studio
-- without Claude clobbering changes.
function Transport.setPaused(on)
	on = on and true or false
	if on ~= Transport.status.paused then
		Transport.status.paused = on
		Transport.changed:Fire()
	end
end

-- Change the port the bridge connects to. Persisted via plugin settings. If we
-- were already polling, restart so the new URL takes effect on the next loop.
function Transport.setPort(port)
	if not Config.setPort(port) then return false end
	Transport.status.host = Config.HOST
	Transport.status.port = Config.port
	if _plugin then
		pcall(function() _plugin:SetSetting("port", Config.port) end)
	end
	local wasPolling = Transport.status.polling
	if wasPolling then
		Transport.setPolling(false)
		Transport.setPolling(true)
	else
		Transport.changed:Fire()
	end
	return true
end

local function setMode(mode, err)
	local status = Transport.status
	local didChange = (status.mode ~= mode) or (status.lastError ~= err)
	local wasOnline = status.mode == "online"
	status.mode = mode
	status.lastError = err
	-- Track an uptime streak: stamp `connectedAt` the first time we hit online,
	-- clear it whenever we drop out.
	if mode == "online" and not wasOnline then
		status.connectedAt = os.clock()
	elseif mode ~= "online" and wasOnline then
		status.connectedAt = 0
	end
	if didChange then
		Transport.changed:Fire()
	end
end

-- Forward a character_* tool to the play-DM bootstrap via PlaytestBus.
-- Used while _STS_running because plugin context has no live Character; the
-- bootstrap (running inside the play DM) does the actual work and writes back
-- a JSON-encoded result that we re-shape into (success, value|error).
local function forwardToBus(tool, args)
	local id = PlaytestBus.send(tool, args)
	-- character_walk yields up to 10s in-bootstrap (duration up to 10), plus
	-- transport overhead. Generous timeout (20s) + a bit for slack.
	local timeout = 20
	if tool == "character_walk" then
		local dur = math.min(math.max(tonumber(args and args.duration) or 1, 0), 10)
		timeout = dur + 10
	elseif tool == "tune" then
		-- tune runs arbitrary Luau in the play DM; it may task.wait. Give it the
		-- same generous budget as a long bridge eval so a deliberate sleep in the
		-- tuned snippet doesn't read back as bus_timeout.
		timeout = 30
	end
	local res, err = PlaytestBus.poll(id, timeout)
	if err then
		return false, { code = "bus_" .. err, tool = tool }
	end
	if type(res) ~= "table" then
		return false, { code = "bus_bad_result", tool = tool }
	end
	if res.ok then return true, res.value end
	return false, res.error or { code = "bus_unknown_error" }
end

-- Run one command from the server. Returns (success, resultOrErrorObject).
local function dispatch(cmd)
	local tool = cmd.tool
	local args = cmd.args or {}

	if Transport.status.paused then
		return false, {
			code = "paused",
			message = "Plugin is paused — open the Cubes MCP panel and unpause to accept commands.",
		}
	end

	if not Transport.status.writeEnabled and not READ_ONLY_COMMANDS[tool] then
		return false, {
			code = "write_mode_disabled",
			message = "Writes are off. Open the Cubes MCP panel in Roblox Studio and enable 'Allow writes', then retry.",
		}
	end

	if tool == "eval" then
		-- loadstring is available in plugin context (elevated permissions).
		if not loadstring then
			return false, { code = "no_loadstring", message = "loadstring is unavailable in this Studio context" }
		end
		-- __MCP (assembled in init.server.luau) is exposed via _G to eval chunks.
		local src = "local __MCP = _G.__CUBES_MCP; " .. tostring(args.luau or "")
		local fn, compileErr = compile(src)
		if not fn then
			return false, { code = "compile_error", message = tostring(compileErr) }
		end
		local ok, ret = pcall(fn)
		if not ok then
			return false, { code = "runtime_error", message = tostring(ret) }
		end
		if ret == nil then
			ret = { __void = true }
		end
		return true, ret
	elseif tool == "tune" then
		-- tune is `eval`, but inside the RUNNING play DM instead of the edit DM.
		-- The edit-context plugin (this code) has no live play DataModel, so we
		-- forward the Luau over the PlaytestBus to the play-DM bootstrap, which
		-- loadstrings + runs it and writes back a structured result.
		-- Desync guard: if the flag thinks we're running but Studio isn't, clear it
		-- (matches the playtest_play/stop guards) so the error below is accurate.
		if _STS_running and not RunService:IsRunning() then
			_STS_running = false
			_STS_mode = "edit"
		end
		if not _STS_running then
			return false, {
				code = "no_playtest",
				message = "tune runs Luau inside a live playtest — no playtest is running.",
				hint = "Start one with playtest_play first, then call tune.",
			}
		end
		if type(args.luau) ~= "string" or args.luau == "" then
			return false, { code = "bad_args", message = "tune requires a non-empty 'luau' string." }
		end
		-- forwardToBus reshapes the bootstrap's {ok,value|error} into (success, ...).
		return forwardToBus("tune", { luau = args.luau })
	elseif tool == "read" then
		local ok, ret = pcall(Read.read, args)
		if not ok then
			return false, { code = "read_error", message = tostring(ret) }
		end
		return true, ret
	elseif tool == "mutate" then
		local ok, ret = pcall(Mutate.mutate, args)
		if not ok then
			return false, { code = "mutate_error", message = tostring(ret) }
		end
		return true, ret
	elseif tool == "diagnostics" then
		local ok, ret = pcall(Diagnostics.recent, args.n)
		if not ok then
			return false, { code = "diagnostics_error", message = tostring(ret) }
		end
		return true, ret
	elseif tool == "snapshot" then
		-- Capture a subtree for the `snapshot` / `diff` specialist tools. Read-class:
		-- it only serializes, never mutates. The server stores the records and the
		-- summary; we just hand back the flat capture.
		local root = Refs.resolve(args.path)
		if not root then
			return false, {
				code = "not_found",
				path = args.path,
				message = "No instance at path/ref: " .. tostring(args.path),
			}
		end
		if not root:IsDescendantOf(game) and root ~= game then
			return false, { code = "not_found", path = args.path, message = "Target is not in the DataModel." }
		end
		local ok, records, truncated = pcall(Snapshot.capture, root)
		if not ok then
			return false, { code = "snapshot_error", message = tostring(records) }
		end
		return true, {
			path = root:GetFullName(),
			instances = records,
			instanceCount = #records,
			truncated = truncated or nil,
			capLimit = Snapshot.MAX_INSTANCES,
		}
	elseif tool == "playtest_play" then
		-- ExecutePlayModeAsync yields. Spawn it so we return immediately.
		-- Result (when EndTest fires) is captured into a module-level slot.
		-- Desync guard: if the flag thinks we're running but Studio isn't, clear it.
		-- Can happen when EndTest never resumed the prior spawned coroutine.
		if _STS_running and not RunService:IsRunning() then
			_STS_running = false
			_STS_mode = "edit"
		end
		if _STS_running then
			return false, { code = "already_running", mode = _STS_mode }
		end
		-- Cross-DM bus now runs natively inside the cloned plugin's Server-DM
		-- context (see init.server.luau): when Studio clones our plugin into the
		-- play DM's Server context, it shares the `plugin` global, so
		-- PlaytestBus.startServerBus() can use plugin:Get/SetSetting as the
		-- bidirectional channel. No Script injection needed.
		PlaytestBus.cleanup()
		_STS_running = true
		_STS_mode = "play"
		_STS_lastResult = nil
		_STS_gen += 1
		local myGen = _STS_gen
		task.spawn(function()
			local ok, result = pcall(function()
				return StudioTestService:ExecutePlayModeAsync(args.testArgs or {})
			end)
			-- A newer play has superseded us (play → stop → play race). Don't
			-- clobber state belonging to the new run.
			if myGen ~= _STS_gen then return end
			_STS_lastResult = ok and result or { error = tostring(result) }
			_STS_running = false
			_STS_mode = "edit"
		end)
		return true, { ok = true, started = "play", spawning = true }
	elseif tool == "playtest_run_mode" then
		if _STS_running and not RunService:IsRunning() then
			_STS_running = false
			_STS_mode = "edit"
		end
		if _STS_running then
			return false, { code = "already_running", mode = _STS_mode }
		end
		PlaytestBus.cleanup()
		_STS_running = true
		_STS_mode = "run"
		_STS_lastResult = nil
		_STS_gen += 1
		local myGen = _STS_gen
		task.spawn(function()
			local ok, result = pcall(function()
				return StudioTestService:ExecuteRunModeAsync(args.testArgs or {})
			end)
			-- Newer run has superseded us; don't clobber its state.
			if myGen ~= _STS_gen then return end
			_STS_lastResult = ok and result or { error = tostring(result) }
			_STS_running = false
			_STS_mode = "edit"
		end)
		return true, { ok = true, started = "run", spawning = true }
	elseif tool == "playtest_stop" then
		if not _STS_running then
			-- Fall back to RunService:Stop for legacy RunService:Run starts (or no-op).
			if RunService:IsRunning() then
				pcall(function() RunService:Stop() end)
				return true, { ok = true, stopped = "runservice", isRunning = RunService:IsRunning() }
			end
			return true, { ok = true, already_stopped = true }
		end
		local reason = args.reason or "stopped_by_mcp"
		local prevMode = _STS_mode
		-- Ask the play-DM bootstrap to flush logs + call EndTest from inside
		-- the play DM (it has the captured LogService stream). Fall through to
		-- StudioTestService:EndTest from edit context as a belt-and-suspenders
		-- in case the bootstrap is missing or unresponsive.
		PlaytestBus.requestStop(reason)
		pcall(function() StudioTestService:EndTest(reason) end)
		-- Eagerly clear flags. The spawned coroutine for ExecutePlay/RunModeAsync
		-- *should* also reset these when it resumes, but EndTest is sometimes slow
		-- to resume the yielded thread (or doesn't at all in certain Studio states),
		-- leaving the plugin permanently stuck at _STS_running=true. Clear up front.
		_STS_running = false
		_STS_mode = "edit"
		-- Bump generation so a late-resuming spawned coroutine from the stopped
		-- play won't clobber state for any subsequent play.
		_STS_gen += 1
		return true, { ok = true, ended = reason, mode = prevMode }
	elseif tool == "playtest_result" then
		return true, {
			running = _STS_running,
			mode = _STS_mode or "edit",
			lastResult = _STS_lastResult,
		}
	elseif tool == "playtest_set_players" then
		local n = math.clamp(tonumber(args.count) or 1, 1, 8)
		local TestService = game:GetService("TestService")
		TestService.NumberOfPlayers = n
		return true, { ok = true, numberOfPlayers = n }
	elseif tool == "event_watch" then
		local target = Refs.resolve(args.target)
		if not target then return false, { code = "target_not_found", message = "no instance for ref: " .. tostring(args.target) } end
		local eventName = args.eventName or "Event"
		local id, err = EventWatch.start(target, eventName, { maxBuffer = args.maxBuffer })
		if not id then return false, { code = err or "watch_failed" } end
		return true, { ok = true, watchId = id, target = Refs.refFor(target), eventName = eventName }
	elseif tool == "event_drain" then
		local result = EventWatch.drain(args.watchId)
		if not result then return false, { code = "unknown_watch" } end
		return true, result
	elseif tool == "event_unwatch" then
		local stopped = EventWatch.stop(args.watchId)
		if not stopped then return false, { code = "unknown_watch" } end
		return true, { ok = true, stopped = true }
	elseif tool == "players_state" then
		if _STS_running then return forwardToBus(tool, args) end
		local Players = game:GetService("Players")
		local out = {}
		for _, plr in ipairs(Players:GetPlayers()) do
			local char = plr.Character
			local entry = {
				ref = Refs.refFor(plr),
				name = plr.Name,
				userId = plr.UserId,
				hasCharacter = char ~= nil,
			}
			if char then
				entry.characterRef = Refs.refFor(char)
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
	elseif tool == "character_state" then
		if _STS_running then return forwardToBus(tool, args) end
		local hum, char, hrp, err = resolveCharacter(args)
		if err == "no_player" then return false, { code = "no_player", error = "no_player", hint = "Press Play in Studio first." } end
		if err then return false, { error = err } end
		local toolInst = char:FindFirstChildOfClass("Tool")
		return true, {
			ref = Refs.refFor(char),
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
			equippedTool = toolInst and Refs.refFor(toolInst) or nil,
		}
	elseif tool == "character_teleport" then
		if _STS_running then return forwardToBus(tool, args) end
		local hum, char, hrp, err = resolveCharacter(args)
		if err == "no_player" then return false, { code = "no_player", error = "no_player", hint = "Press Play in Studio first." } end
		if err then return false, { error = err } end
		local fromV = hrp.Position
		local toV
		if args.position then
			toV = Vector3.new(args.position[1] or 0, args.position[2] or 0, args.position[3] or 0)
		elseif args.target then
			local inst = Refs.resolve(args.target)
			if not inst then return false, { code = "target_not_found", error = "target_not_found", target = args.target } end
			local tpos
			if inst:IsA("BasePart") then
				tpos = inst.Position
			elseif inst:IsA("Model") then
				local ok, pivot = pcall(function() return inst:GetPivot().Position end)
				if ok then tpos = pivot end
			elseif inst:IsA("Attachment") then
				tpos = inst.WorldPosition
			elseif inst:IsA("Humanoid") then
				-- Humanoid alone has no position — fall back to its character's HRP
				-- so the agent can `character_teleport({ target = "<humanoid ref>" })`
				-- the same way every other character_* tool accepts a humanoid.
				local parentChar = inst.Parent
				local targetHrp = parentChar and parentChar:FindFirstChild("HumanoidRootPart")
				if targetHrp then tpos = targetHrp.Position end
			end
			if not tpos then return false, { code = "target_not_found", error = "target_not_found", target = args.target, hint = "Target has no position." } end
			toV = tpos + Vector3.new(0, 5, 0)
		else
			return false, { code = "bad_args", error = "bad_args", hint = "Pass position or target." }
		end
		hrp.CFrame = CFrame.new(toV)
		return true, {
			ok = true,
			from = { fromV.X, fromV.Y, fromV.Z },
			to = { toV.X, toV.Y, toV.Z },
		}
	elseif tool == "character_walk" then
		if _STS_running then return forwardToBus(tool, args) end
		local hum, char, hrp, err = resolveCharacter(args)
		if err == "no_player" then return false, { code = "no_player", error = "no_player", hint = "Press Play in Studio first." } end
		if err then return false, { error = err } end
		if not args.direction then return false, { code = "bad_args", error = "bad_args", hint = "direction is required." } end
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
	elseif tool == "character_jump" then
		if _STS_running then return forwardToBus(tool, args) end
		local hum, char, hrp, err = resolveCharacter(args)
		if err == "no_player" then return false, { code = "no_player", error = "no_player", hint = "Press Play in Studio first." } end
		if err then return false, { error = err } end
		hum:ChangeState(Enum.HumanoidStateType.Jumping)
		return true, { ok = true, jumped = true, state = tostring(hum:GetState().Name) }
	elseif tool == "character_set" then
		if _STS_running then return forwardToBus(tool, args) end
		local hum, char, hrp, err = resolveCharacter(args)
		if err == "no_player" then return false, { code = "no_player", error = "no_player", hint = "Press Play in Studio first." } end
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
	elseif tool == "character_respawn" then
		if _STS_running then return forwardToBus(tool, args) end
		local plr = resolvePlayer(args.player)
		if not plr then return false, { code = "no_player", error = "no_player", hint = "Press Play in Studio first." } end
		plr:LoadCharacter()
		local newChar = plr.Character
		if not newChar then
			local thread = coroutine.running()
			local connected = true
			local conn
			conn = plr.CharacterAdded:Connect(function(c)
				if connected then
					connected = false
					newChar = c
					task.spawn(thread)
				end
			end)
			task.delay(5, function()
				if connected then
					connected = false
					if conn then conn:Disconnect() end
					task.spawn(thread)
				end
			end)
			coroutine.yield()
			if conn then pcall(function() conn:Disconnect() end) end
		end
		if not newChar then return false, { code = "respawn_timeout", error = "respawn_timeout", hint = "Character did not spawn within 5s." } end
		return true, { ok = true, respawned = true, characterRef = Refs.refFor(newChar) }
	elseif tool == "viewport_capture" then
		if _STS_running then return forwardToBus(tool, args) end
		local Viewport = require(script.Parent.Viewport)
		local ok, ret = pcall(Viewport.capture, args.limit)
		if not ok then return false, { code = "viewport_error", error = "viewport_error", message = tostring(ret) } end
		return true, ret
	elseif tool == "camera_set" then
		if _STS_running then return forwardToBus(tool, args) end
		local Workspace = game:GetService("Workspace")
		local camera = Workspace.CurrentCamera
		if not camera then return false, { code = "no_camera", error = "no_camera" } end
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
				local inst = Refs.resolve(args.focus)
				if inst and inst:IsA("BasePart") then f = inst.Position
				elseif inst and inst:IsA("Model") then
					local okPivot, pivot = pcall(function() return inst:GetPivot().Position end)
					if okPivot then f = pivot end
				end
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
	elseif tool == "raycast" then
		if _STS_running then return forwardToBus(tool, args) end
		local Workspace = game:GetService("Workspace")
		local origin, direction
		if args.fromCamera then
			local camera = Workspace.CurrentCamera
			if not camera then return false, { code = "no_camera", error = "no_camera" } end
			origin = camera.CFrame.Position
			if args.direction then
				direction = Vector3.new(args.direction[1] or 0, args.direction[2] or 0, args.direction[3] or 0)
			else
				direction = camera.CFrame.LookVector
			end
		else
			if not args.origin then return false, { code = "bad_args", error = "bad_args", hint = "origin or fromCamera required." } end
			if not args.direction then return false, { code = "bad_args", error = "bad_args", hint = "direction required." } end
			origin = Vector3.new(args.origin[1] or 0, args.origin[2] or 0, args.origin[3] or 0)
			direction = Vector3.new(args.direction[1] or 0, args.direction[2] or 0, args.direction[3] or 0)
		end
		if direction.Magnitude < 1e-6 then
			return false, { code = "bad_args", error = "bad_args", hint = "direction must be non-zero" }
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
				local inst = Refs.resolve(refPath)
				if inst then ignoreList[#ignoreList + 1] = inst end
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
			instance = result.Instance and Refs.refFor(result.Instance) or nil,
			path = result.Instance and result.Instance:GetFullName() or nil,
			class = result.Instance and result.Instance.ClassName or nil,
			position = { result.Position.X, result.Position.Y, result.Position.Z },
			normal = { result.Normal.X, result.Normal.Y, result.Normal.Z },
			material = tostring(result.Material.Name),
			distance = result.Distance,
		}
	elseif tool == "mesh_bake" then
		return MeshTools.bake(args)
	elseif tool == "mesh_build" then
		return MeshTools.build(args)
	else
		return false, { code = "unknown_tool", message = tostring(tool) }
	end
end

local function postResult(id, success, result, errObj)
	local ok, err = pcall(function()
		HttpService:RequestAsync({
			Url = Config.RESULT_URL,
			Method = "POST",
			Headers = requestHeaders(),
			Body = HttpService:JSONEncode({
				id = id,
				ok = success,
				result = success and Serialize.deep(result) or nil,
				error = errObj,
			}),
		})
	end)
	if ok then return end
	-- First attempt failed (likely JSONEncode threw on a non-serializable
	-- result, or RequestAsync itself errored). Without this, the bridge's
	-- pending entry sits until its 30s timer fires as studio_timeout.
	-- Best-effort fallback: tell the server the command failed.
	local fallbackOk = pcall(function()
		HttpService:RequestAsync({
			Url = Config.RESULT_URL,
			Method = "POST",
			Headers = requestHeaders(),
			Body = HttpService:JSONEncode({
				id = id,
				ok = false,
				error = { code = "post_failed", message = tostring(err) },
			}),
		})
	end)
	if not fallbackOk then
		warn("[Cubes MCP] postResult failed twice for id " .. tostring(id) .. ": " .. tostring(err))
	end
end

-- The view goes back to how it was once Claude is done: Config.IDLE_AFTER
-- seconds with no command (when the activity bar says Idle), or a disconnect.
-- Every command cancels the pending revert and arms a new one when it lands.
local viewRevertGen = 0

local function revertView(reason)
	local ok, reverted = pcall(ViewGuard.revert)
	if ok and type(reverted) == "table" and #reverted > 0 then
		print("[Cubes MCP] put your view back (" .. reason .. "): " .. table.concat(reverted, ", "))
	end
end

local function cancelViewRevert()
	viewRevertGen += 1
end

local function scheduleViewRevert()
	viewRevertGen += 1
	local myGen = viewRevertGen
	task.delay(Config.IDLE_AFTER, function()
		if myGen == viewRevertGen then
			revertView("Claude finished")
		end
	end)
end

-- Returns (command|nil, errorTag|nil, errorMessage|nil). A nil command with nil
-- error means the long-poll timed out cleanly (server alive, just idle) —
-- re-poll immediately.
local function pollOnce()
	local ok, response = pcall(function()
		return HttpService:RequestAsync({
			Url = Config.POLL_URL,
			Method = "POST",
			Headers = requestHeaders(),
			-- Poll body carries write-mode toggle + protocol version to the server.
			Body = HttpService:JSONEncode({
				writeEnabled = Transport.status.writeEnabled,
				protocol = Config.PROTOCOL_VERSION,
			}),
		})
	end)
	if not ok then
		return nil, "request_failed", nil
	end
	if response.StatusCode == 204 then
		return nil, nil, nil
	end
	-- 401 = the server refused our bearer token (none set, or a stale one).
	if response.StatusCode == 401 then
		local message = Transport.status.token == ""
			and "No bridge token. Paste the one from ~/.cubesmcp/token into Controls → Bridge token."
			or "Bridge token rejected. Paste the current one from ~/.cubesmcp/token into Controls → Bridge token."
		return nil, "unauthorized", message
	end
	-- 426 Upgrade Required = server says our wire-protocol version doesn't match.
	if response.StatusCode == 426 then
		local message = "Plugin/server protocol mismatch — rebuild the plugin."
		local okDecode, body = pcall(function()
			return HttpService:JSONDecode(response.Body)
		end)
		if okDecode and type(body) == "table" and type(body.message) == "string" then
			message = body.message
		end
		return nil, "version_mismatch", message
	end
	if response.StatusCode ~= 200 then
		return nil, "http_" .. tostring(response.StatusCode), nil
	end
	local okDecode, cmd = pcall(function()
		return HttpService:JSONDecode(response.Body)
	end)
	if not okDecode then
		return nil, "decode_failed", nil
	end
	return cmd, nil, nil
end

local function loop(myGen)
	local consecutiveErrors = 0
	while Transport.status.polling and myGen == generation do
		local cmd, err, detail = pollOnce()
		-- Generation may have advanced WHILE pollOnce was in flight (e.g., a
		-- plugin reload or mode transition spawned a new loop). If so, drop
		-- whatever this stale loop picked up — the new loop owns the bridge now.
		-- Without this guard, the stale loop services one last command with
		-- old refs, producing the OK/ERR alternation we saw during play tests.
		if myGen ~= generation then
			if cmd then
				postResult(cmd.id, false, nil, { code = "loop_superseded", message = "command received by a stale plugin loop after reload; retry." })
			end
			break
		end
		if cmd then
			consecutiveErrors = 0
			Transport.status.lastPollAt = os.clock()
			setMode("online", nil)
			-- HUD: announce the task before dispatch, settle it after. The HUD
			-- module is a no-op when the Visual debug toggle is off, so we can
			-- always call into it without branching.
			local shownTool = type(cmd.via) == "table" and type(cmd.via.tool) == "string" and cmd.via.tool
				or cmd.tool
			-- Show the activity while the command runs, not only after it lands:
			-- a character_walk or a slow eval used to read as the previous thing.
			Transport.status.lastCommandTool = shownTool
			Transport.status.lastActivity = activityFor(cmd)
			Transport.status.busy = true
			Transport.changed:Fire()
			local _, hudTaskId = pcall(HudOverlay.startTask, Transport.status.lastActivity, islandTarget(cmd))
			-- pcall: a handler that throws must fail its own command, not kill
			-- this loop (which would leave the panel "online" and every later
			-- command timing out until the plugin reloads).
			cancelViewRevert()
			local _, viewBefore = pcall(ViewGuard.capture)
			local callOk, success, result = pcall(dispatch, cmd)
			if not callOk then
				result = { code = "plugin_error", tool = cmd.tool, message = tostring(success) }
				success = false
			end
			-- Whatever the command was, the edit camera must still move afterwards,
			-- and what it changed about the view is remembered for revertView.
			local _, cameraFixed = pcall(ViewGuard.afterCommand, viewBefore)
			scheduleViewRevert()
			if type(cameraFixed) == "table" then
				warn("[Cubes MCP] " .. tostring(shownTool) .. " left the camera stuck; put back: " .. table.concat(cameraFixed, ", "))
				if success and type(result) == "table" and result[1] == nil then
					result.cameraRestored = cameraFixed
				end
			end
			local errCode = not success and ((type(result) == "table" and result.code) or "error") or nil
			if success then
				pcall(HudOverlay.finishTask, hudTaskId)
			else
				pcall(HudOverlay.failTask, hudTaskId, errCode)
			end
			postResult(cmd.id, success, success and result or nil, success and nil or result)
			Transport.status.commandsHandled += 1
			Transport.status.busy = false
			Transport.status.lastCommandAt = os.clock()
			recordOp(shownTool, success, errCode)
			Transport.changed:Fire()
		elseif err == nil then
			-- 204 long-poll timeout: server is alive, just idle.
			consecutiveErrors = 0
			Transport.status.lastPollAt = os.clock()
			setMode("online", nil)
		elseif err == "version_mismatch" then
			setMode("version_mismatch", detail or "Plugin protocol mismatch — rebuild the plugin.")
			task.wait(Config.VERSION_MISMATCH_WAIT)
		elseif err == "unauthorized" then
			local baked = Config.BAKED_TOKEN
			if type(baked) == "string" and baked ~= "" and not baked:find("^__CUBES_MCP_") and Transport.status.token ~= baked then
				-- A stale or mistyped token from the panel: the one `npm run setup` baked in
				-- is the server's current one, so fall back to it. setToken restarts the loop.
				Transport.setToken(baked)
			else
				-- Retrying with the same token cannot succeed; setToken restarts the
				-- loop as soon as the user pastes a new one.
				setMode("unauthorized", detail)
				task.wait(Config.VERSION_MISMATCH_WAIT)
			end
		elseif err == "request_failed" then
			consecutiveErrors += 1
			setMode("server_unreachable", "Cannot reach MCP server at " .. Config.HOST)
			task.wait(math.min(Config.RETRY_WAIT * 2 ^ math.min(consecutiveErrors - 1, 5), 30))
		else
			consecutiveErrors += 1
			setMode("server_unreachable", "Poll error: " .. tostring(err))
			task.wait(math.min(Config.ERROR_WAIT * 2 ^ math.min(consecutiveErrors - 1, 5), 30))
		end
	end
end

function Transport.setPolling(on)
	if on == Transport.status.polling then
		return
	end
	Transport.status.polling = on
	if on then
		generation += 1
		local myGen = generation
		Transport.status.mode = "connecting"
		Transport.changed:Fire()
		task.spawn(function()
			loop(myGen)
		end)
	else
		generation += 1
		setMode("off", nil)
	end
end

function Transport.toggle()
	local turningOff = Transport.status.polling
	Transport.setPolling(not Transport.status.polling)
	if turningOff then
		cancelViewRevert()
		revertView("disconnected")
	end
end

function Transport.stop()
	Transport.setPolling(false)
	cancelViewRevert()
	revertView("plugin unloading")
end

return Transport
