--!nonstrict
-- Structured error / playtest stream.
--
-- Connects to LogService.MessageOut (edit + playtest output) and, best-effort,
-- ScriptContext.Error (richer: script instance + stack). Keeps a ring buffer the
-- MCP server reads via the `diagnostics` bridge tool, which backs the
-- studio://errors/recent resource.

local LogService = game:GetService("LogService")
local RunService = game:GetService("RunService")
local ScriptContext = game:GetService("ScriptContext")

local Refs = require(script.Parent.Refs)

local Diagnostics = {}

local MAX_ENTRIES = 150
Diagnostics.entries = {}

local KIND = {
	[Enum.MessageType.MessageError] = "error",
	[Enum.MessageType.MessageWarning] = "warning",
}

local function push(entry)
	table.insert(Diagnostics.entries, entry)
	if #Diagnostics.entries > MAX_ENTRIES then
		table.remove(Diagnostics.entries, 1)
	end
end

-- Roblox errors are usually prefixed "Path.To.Script:42: message" — pull the
-- script path and line number out so the agent gets structured location info.
local function parseLocation(message)
	local path, line = string.match(message, "^(%S+):(%d+):")
	if path and line then
		return path, tonumber(line)
	end
	return nil, nil
end

local logConn = LogService.MessageOut:Connect(function(message, messageType)
	local kind = KIND[messageType]
	if not kind then
		return -- ignore plain output / info messages
	end
	local entry = { kind = kind, message = message, at = DateTime.now():ToIsoDate() }
	if kind == "error" then
		local path, line = parseLocation(message)
		if path then
			entry.scriptPath = path
			entry.line = line
		end
	end
	push(entry)
end)

-- ScriptContext.Error gives the script instance + a stack trace. Not guaranteed
-- to be available across the edit/playtest boundary, so it's best-effort.
local errConn
pcall(function()
	errConn = ScriptContext.Error:Connect(function(message, stackTrace, scriptInstance)
		local entry = {
			kind = "script_error",
			message = message,
			stack = stackTrace,
			at = DateTime.now():ToIsoDate(),
		}
		if scriptInstance then
			entry.scriptPath = scriptInstance:GetFullName()
			entry.scriptRef = Refs.refFor(scriptInstance)
		end
		local _, line = parseLocation(message)
		if line then
			entry.line = line
		end
		push(entry)
	end)
end)

-- Disconnect signal handlers so plugin reload doesn't double-subscribe.
function Diagnostics.stop()
	if logConn then
		pcall(function() logConn:Disconnect() end)
		logConn = nil
	end
	if errConn then
		pcall(function() errConn:Disconnect() end)
		errConn = nil
	end
end

local function runMode()
	local ok, mode = pcall(function()
		if RunService:IsRunning() then
			return RunService:IsServer() and "playtest-server" or "playtest-client"
		end
		return "edit"
	end)
	return ok and mode or "unknown"
end

-- The most recent n captured entries (newest last) plus the current run mode.
function Diagnostics.recent(n)
	n = tonumber(n) or 25
	local total = #Diagnostics.entries
	local startIdx = math.max(1, total - n + 1)
	local out = {}
	for i = startIdx, total do
		out[#out + 1] = Diagnostics.entries[i]
	end
	return { errors = out, count = #out, totalCaptured = total, runMode = runMode() }
end

return Diagnostics
