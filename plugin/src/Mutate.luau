--!nonstrict
-- The write path.
--
-- An ordered batch of create/set/delete ops. Use @id to reference the result of
-- an earlier op in the same batch. The whole batch runs inside ONE undo waypoint;
-- if any op throws, created instances are destroyed and the waypoint is cancelled.

local ChangeHistoryService = game:GetService("ChangeHistoryService")
local CollectionService = game:GetService("CollectionService")
local Workspace = game:GetService("Workspace")

local Refs = require(script.Parent.Refs)
local Serialize = require(script.Parent.Serialize)
local SessionState = require(script.Parent.SessionState)

local Mutate = {}

-- Extract all signed numeric components from a stringified Roblox value.
-- Handles tostring() output like "0, 50, 0" (Vector3), "{0, 50}, {0, 100}" (UDim2),
-- or "0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1" (CFrame).
local function extractNumbers(str)
	local nums = {}
	for n in string.gmatch(str, "-?%d*%.?%d+") do
		nums[#nums + 1] = tonumber(n)
	end
	return nums
end

-- Parse the string form of a typed value (Serialize.value uses tostring()).
-- Returns the constructed Roblox value, or nil if the typed/string pair is unsupported.
local function parseTypedString(typed, str)
	if type(str) ~= "string" then
		return nil
	end
	local n = extractNumbers(str)
	if typed == "Vector3" and #n >= 3 then
		return Vector3.new(n[1], n[2], n[3])
	end
	if typed == "Vector2" and #n >= 2 then
		return Vector2.new(n[1], n[2])
	end
	if typed == "Color3" and #n >= 3 then
		local maxC = math.max(n[1], n[2], n[3])
		if maxC > 1 then
			return Color3.fromRGB(n[1], n[2], n[3])
		end
		return Color3.new(n[1], n[2], n[3])
	end
	if typed == "UDim" and #n >= 2 then
		return UDim.new(n[1], n[2])
	end
	if typed == "UDim2" and #n >= 4 then
		return UDim2.new(n[1], n[2], n[3], n[4])
	end
	if typed == "NumberRange" and #n >= 2 then
		return NumberRange.new(n[1], n[2])
	end
	if typed == "NumberRange" and #n == 1 then
		return NumberRange.new(n[1])
	end
	if typed == "CFrame" then
		if #n >= 12 then
			return CFrame.new(n[1], n[2], n[3], n[4], n[5], n[6], n[7], n[8], n[9], n[10], n[11], n[12])
		end
		if #n >= 3 then
			return CFrame.new(n[1], n[2], n[3])
		end
	end
	return nil
end

-- Coerce a JSON value into something SetAttribute will accept.
-- Primitives pass through; complex types use the {__t, value} envelope.
local function coerceAttrValue(value)
	local vt = type(value)
	if vt == "boolean" or vt == "string" or vt == "number" then
		return value
	end
	if vt == "table" then
		local typed = value.__t
		local v = value.value
		if typed == "Vector3" and type(v) == "table" and #v == 3 then
			return Vector3.new(v[1], v[2], v[3])
		end
		if typed == "Vector2" and type(v) == "table" and #v == 2 then
			return Vector2.new(v[1], v[2])
		end
		if typed == "Color3" and type(v) == "table" and #v == 3 then
			local maxC = math.max(v[1], v[2], v[3])
			if maxC > 1 then
				return Color3.fromRGB(v[1], v[2], v[3])
			end
			return Color3.new(v[1], v[2], v[3])
		end
		if typed == "UDim" and type(v) == "table" and #v == 2 then
			return UDim.new(v[1], v[2])
		end
		if typed == "UDim2" and type(v) == "table" and #v == 4 then
			return UDim2.new(v[1], v[2], v[3], v[4])
		end
		if typed == "NumberRange" and type(v) == "table" and #v == 2 then
			return NumberRange.new(v[1], v[2])
		end
		-- String form: Serialize.value emits {__t = T, value = tostring(v)}.
		if typed and type(v) == "string" then
			local parsed = parseTypedString(typed, v)
			if parsed ~= nil then
				return parsed
			end
		end
	end
	-- Best effort — SetAttribute will reject unsupported shapes with a clear error.
	return value
end

local function applyAttrs(inst, attrs)
	local modified = {}
	for name, raw in pairs(attrs or {}) do
		local value = coerceAttrValue(raw)
		local ok, err = pcall(function()
			inst:SetAttribute(name, value)
		end)
		if not ok then
			error(string.format("attribute '%s' on %s: %s", name, inst.ClassName, tostring(err)))
		end
		modified[#modified + 1] = name
	end
	return modified
end

local function applyTags(inst, tags)
	local added = {}
	for _, tag in ipairs(tags or {}) do
		if type(tag) == "string" then
			CollectionService:AddTag(inst, tag)
			added[#added + 1] = tag
		end
	end
	return added
end

local function removeTagsList(inst, tags)
	local removed = {}
	for _, tag in ipairs(tags or {}) do
		if type(tag) == "string" then
			CollectionService:RemoveTag(inst, tag)
			removed[#removed + 1] = tag
		end
	end
	return removed
end

local function removeAttrsList(inst, names)
	local removed = {}
	for _, name in ipairs(names or {}) do
		if type(name) == "string" then
			inst:SetAttribute(name, nil)
			removed[#removed + 1] = name
		end
	end
	return removed
end

-- Coerce a JSON value into the Roblox type the property currently holds.
local function coerceValue(target, propName, value)
	-- Fast path: booleans are unambiguous — no Roblox property accepts a bool
	-- as anything else, so we can skip the getProp read. Saves a typed read on
	-- every Anchored/CanCollide/Disabled/Enabled set in large mutate batches.
	if type(value) == "boolean" then
		return value
	end
	local current, ok = Serialize.getProp(target, propName)
	local t = ok and typeof(current) or nil

	if type(value) == "table" then
		if value.__ref then
			return Refs.resolve(value.__ref)
		end
		-- Envelope string form: {__t = T, value = tostring(v)} from Serialize.value.
		if value.__t and type(value.value) == "string" then
			local parsed = parseTypedString(value.__t, value.value)
			if parsed ~= nil then
				return parsed
			end
		end
		if (value.__t == "Vector3" or t == "Vector3") and #value == 3 then
			return Vector3.new(value[1], value[2], value[3])
		end
		if t == "Vector2" and #value == 2 then
			return Vector2.new(value[1], value[2])
		end
		if t == "Color3" and #value == 3 then
			local maxC = math.max(value[1], value[2], value[3])
			if maxC > 1 then
				return Color3.fromRGB(value[1], value[2], value[3])
			end
			return Color3.new(value[1], value[2], value[3])
		end
		if t == "UDim2" and #value == 4 then
			return UDim2.new(value[1], value[2], value[3], value[4])
		end
		if (value.__t == "UDim" or t == "UDim") and #value == 2 then
			return UDim.new(value[1], value[2])
		end
		if t == "NumberRange" and #value == 2 then
			return NumberRange.new(value[1], value[2])
		end
		if t == "ColorSequence" then
			-- {keypoints: [{time, value:[r,g,b]}, ...]} OR [r,g,b] for a single color.
			if type(value.keypoints) == "table" then
				local kps = {}
				for _, kp in ipairs(value.keypoints) do
					local c = kp.value
					if type(c) == "table" and #c == 3 then
						local maxC = math.max(c[1], c[2], c[3])
						local color = maxC > 1 and Color3.fromRGB(c[1], c[2], c[3])
							or Color3.new(c[1], c[2], c[3])
						kps[#kps + 1] = ColorSequenceKeypoint.new(kp.time, color)
					end
				end
				if #kps >= 2 then
					return ColorSequence.new(kps)
				end
			end
			if #value == 3 then
				local maxC = math.max(value[1], value[2], value[3])
				local color = maxC > 1 and Color3.fromRGB(value[1], value[2], value[3])
					or Color3.new(value[1], value[2], value[3])
				return ColorSequence.new(color)
			end
		end
		if t == "NumberSequence" then
			-- {keypoints: [{time, value, envelope?}, ...]} OR [min, max] OR n.
			if type(value.keypoints) == "table" then
				local kps = {}
				for _, kp in ipairs(value.keypoints) do
					kps[#kps + 1] = NumberSequenceKeypoint.new(kp.time, kp.value, kp.envelope or 0)
				end
				if #kps >= 2 then
					return NumberSequence.new(kps)
				end
			end
			if #value == 2 then
				return NumberSequence.new(value[1], value[2])
			end
		end
		if t == "CFrame" then
			if #value == 3 then
				return CFrame.new(value[1], value[2], value[3])
			end
			if #value == 12 then
				return CFrame.new(
					value[1], value[2], value[3],
					value[4], value[5], value[6],
					value[7], value[8], value[9],
					value[10], value[11], value[12]
				)
			end
		end
		return value
	end

	if type(value) == "number" then
		-- A bare number can stand in for several scalar-like Roblox types.
		if t == "UDim" then
			return UDim.new(0, value)
		end
		if t == "NumberSequence" then
			return NumberSequence.new(value)
		end
		if t == "NumberRange" then
			return NumberRange.new(value)
		end
	end

	if type(value) == "string" then
		if t == "Instance" then
			return Refs.resolve(value)
		end
		if t == "EnumItem" and current then
			local leaf = string.match(value, "([%w_]+)$")
			local okEnum, item = pcall(function()
				return current.EnumType[leaf]
			end)
			if okEnum then
				return item
			end
		end
		if t == "Color3" then
			local r, g, b = string.match(value, "(-?[%d%.]+)%D*[%s,]+(-?[%d%.]+)%D*[%s,]+(-?[%d%.]+)")
			if r then
				local rn, gn, bn = tonumber(r), tonumber(g), tonumber(b)
				if rn and gn and bn then
					local maxC = math.max(rn, gn, bn)
					if maxC > 1 then
						return Color3.fromRGB(rn, gn, bn)
					end
					return Color3.new(rn, gn, bn)
				end
			end
		end
		if t == "Vector3" then
			local x, y, z = string.match(value, "(-?[%d%.]+)%D+(-?[%d%.]+)%D+(-?[%d%.]+)")
			if x then
				return Vector3.new(tonumber(x), tonumber(y), tonumber(z))
			end
		end
		if t == "number" then
			return tonumber(value) or value
		end
		if t == "boolean" then
			return value == "true"
		end
		return value
	end

	return value
end

local function applyProps(inst, props)
	local modified = {}
	for propName, raw in pairs(props or {}) do
		local value = coerceValue(inst, propName, raw)
		local ok, err = pcall(function()
			inst[propName] = value
		end)
		if not ok then
			error(string.format("property '%s' on %s: %s", propName, inst.ClassName, tostring(err)))
		end
		modified[#modified + 1] = propName
	end
	return modified
end

function Mutate.mutate(args)
	args = args or {}
	local ops = args.ops or {}
	local results = {} -- op id -> created Instance
	local created = {} -- for rollback
	local changes = {}

	local function resolveTarget(token)
		if type(token) ~= "string" then
			return nil
		end
		if string.sub(token, 1, 1) == "@" then
			local key = string.sub(token, 2)
			if results[key] then
				return results[key]
			end
			return Refs.resolve(key)
		end
		return Refs.resolve(token)
	end

	local waypointName = "Cubes MCP mutate"
	local recording = ChangeHistoryService:TryBeginRecording(waypointName)

	-- Atomicity guard: without a ChangeHistoryService recording, we cannot
	-- truly roll back `set` (prior prop/attr/tag values are lost) or `delete`
	-- (Destroy() is permanent). The manual `created` loop below only undoes
	-- `create` ops. Rather than silently lying about `rolled_back = true`,
	-- we reject the batch up front. Chose this conservative interim fix over
	-- a full snapshot/restore mechanism to avoid introducing new bugs.
	if not recording then
		return {
			error = "no_undo_available",
			message = "ChangeHistoryService recording could not start; aborting to preserve atomicity",
		}
	end

	local ok, err = pcall(function()
		for index, op in ipairs(ops) do
			if op.op == "create" then
				if type(op.class) ~= "string" or op.class == "" then
					error(string.format("op %d (create): missing or invalid 'class'", index))
				end
				local inst = Instance.new(op.class)
				created[#created + 1] = inst
				if op.name then
					inst.Name = op.name
				end
				if op.props then
					applyProps(inst, op.props)
				end
				if op.attrs then
					applyAttrs(inst, op.attrs)
				end
				if op.tags then
					applyTags(inst, op.tags)
				end
				local parent
				if op.parent then
					parent = resolveTarget(op.parent)
					if not parent then
						error(string.format("op %d (create): parent not found: %s", index, tostring(op.parent)))
					end
				else
					parent = Workspace
				end
				inst.Parent = parent
				if op.id then
					results[op.id] = inst
				end
				SessionState.touch(inst)
				local entry = {
					op = "create",
					ref = Refs.refFor(inst),
					class = inst.ClassName,
					path = inst:GetFullName(),
				}
				if op.attrs and next(op.attrs) then
					local names = {}
					for k in pairs(op.attrs) do names[#names+1] = k end
					entry.attrs = names
				end
				if op.tags and #op.tags > 0 then
					entry.tags = op.tags
				end
				changes[#changes + 1] = entry
			elseif op.op == "set" then
				local target = resolveTarget(op.target)
				if not target then
					error(string.format("op %d (set): target not found: %s", index, tostring(op.target)))
				end
				local modified = applyProps(target, op.props or {})
				local modAttrs = nil
				if op.attrs then modAttrs = applyAttrs(target, op.attrs) end
				local addedTags = nil
				if op.tags then addedTags = applyTags(target, op.tags) end
				local removedTags = nil
				if op.remove_tags then removedTags = removeTagsList(target, op.remove_tags) end
				local removedAttrs = nil
				if op.remove_attrs then removedAttrs = removeAttrsList(target, op.remove_attrs) end
				SessionState.touch(target)
				local entry = { op = "set", ref = Refs.refFor(target), modified = modified }
				if modAttrs and #modAttrs > 0 then
					entry.attrs = modAttrs
				end
				if addedTags and #addedTags > 0 then
					entry.tags_added = addedTags
				end
				if removedTags and #removedTags > 0 then
					entry.tags_removed = removedTags
				end
				if removedAttrs and #removedAttrs > 0 then
					entry.attrs_removed = removedAttrs
				end
				changes[#changes + 1] = entry
			elseif op.op == "delete" then
				local target = resolveTarget(op.target)
				if not target then
					error(string.format("op %d (delete): target not found: %s", index, tostring(op.target)))
				end
				local path = target:GetFullName()
				SessionState.forget(target)
				Refs.forget(target)
				target:Destroy()
				changes[#changes + 1] = { op = "delete", path = path }
			else
				error(string.format("op %d: unknown op '%s'", index, tostring(op.op)))
			end
		end
	end)

	if not ok then
		for _, inst in ipairs(created) do
			pcall(function() Refs.forget(inst) end)
			pcall(function() SessionState.forget(inst) end)
			pcall(function() inst:Destroy() end)
		end
		if recording then
			ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Cancel)
		end
		return { error = "mutate_failed", message = tostring(err), rolled_back = true }
	end

	if recording then
		ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit)
	end

	return {
		applied = true,
		changes = changes,
		waypoint = waypointName, -- always set: we return early at line 365 if recording is nil
	}
end

return Mutate
