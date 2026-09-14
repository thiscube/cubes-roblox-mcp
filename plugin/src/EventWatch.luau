--!nonstrict
-- Event signal watcher.
--
-- Connects to an RBXScriptSignal on an instance, buffers fires (with serialized
-- args), and lets the server drain them at its own cadence. Buffer is bounded —
-- overflow is tracked as `dropped` so the caller knows fires were lost.

local Serialize = require(script.Parent.Serialize)

local EventWatch = {}

-- watchId → { conn, buffer, dropped, target, eventName, maxBuffer, ancestryConn }
local watches = {}
local nextId = 1
local watchCount = 0

local DEFAULT_MAX_BUFFER = 100
local MAX_WATCHES = 64

-- Forward declaration so EventWatch.start can call the local stop helper.
local stopWatchInternal

-- Start observing an event signal on an instance.
function EventWatch.start(target, eventName, options)
	if typeof(target) ~= "Instance" then
		return nil, "target_not_instance"
	end
	if watchCount >= MAX_WATCHES then
		return nil, "too_many_watches"
	end
	local ok, event = pcall(function()
		return target[eventName]
	end)
	if not ok or typeof(event) ~= "RBXScriptSignal" then
		return nil, "not_a_signal"
	end

	options = options or {}
	local maxBuffer = tonumber(options.maxBuffer) or DEFAULT_MAX_BUFFER
	if maxBuffer < 1 then maxBuffer = DEFAULT_MAX_BUFFER end

	local id = nextId
	nextId += 1

	local watch = {
		buffer = {},
		dropped = 0,
		target = target,
		eventName = eventName,
		maxBuffer = maxBuffer,
	}

	watch.conn = event:Connect(function(...)
		-- Buffer-full check BEFORE serialization — avoids wasted CPU on
		-- args we're about to throw away.
		if #watch.buffer >= watch.maxBuffer then
			watch.dropped += 1
			return
		end
		local args = table.pack(...)
		local serialized = {}
		for i = 1, args.n do
			-- pcall around serialization so a weird argument can't poison the loop.
			local sok, sv = pcall(Serialize.value, args[i])
			if sok then
				serialized[i] = sv
			else
				serialized[i] = { __t = "unserializable", value = tostring(args[i]) }
			end
		end
		watch.buffer[#watch.buffer + 1] = {
			timestamp = os.time(),
			clockTime = os.clock(),
			args = serialized,
		}
	end)

	-- Auto-stop when the watched instance is removed from the DataModel
	-- (deleted, reparented outside game). Prevents orphaned watches piling up.
	watch.ancestryConn = target.AncestryChanged:Connect(function()
		if not target:IsDescendantOf(game) then
			stopWatchInternal(id)
		end
	end)

	watches[id] = watch
	watchCount += 1
	return id
end

stopWatchInternal = function(watchId)
	local watch = watches[watchId]
	if not watch then return false end
	if watch.conn then
		pcall(function() watch.conn:Disconnect() end)
	end
	if watch.ancestryConn then
		pcall(function() watch.ancestryConn:Disconnect() end)
	end
	watches[watchId] = nil
	watchCount -= 1
	return true
end

-- Drain the buffered fires; resets buffer + dropped counter.
function EventWatch.drain(watchId)
	local watch = watches[watchId]
	if not watch then return nil end
	local events = watch.buffer
	local dropped = watch.dropped
	watch.buffer = {}
	watch.dropped = 0
	return {
		events = events,
		count = #events,
		dropped = dropped,
	}
end

-- Stop watching and free the connection.
function EventWatch.stop(watchId)
	return stopWatchInternal(watchId)
end

-- Stop all watches (call from plugin.Unloading).
function EventWatch.stopAll()
	for id, _ in pairs(watches) do
		stopWatchInternal(id)
	end
end

return EventWatch
