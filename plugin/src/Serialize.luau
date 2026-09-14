--!nonstrict
-- Value serialization (Roblox types -> JSON-safe), deep sanitize, and hashing.

local Refs = require(script.Parent.Refs)

local Serialize = {}

-- Safe property read: returns (value, ok).
function Serialize.getProp(inst, name)
	local ok, value = pcall(function()
		return inst[name]
	end)
	if not ok then
		return nil, false
	end
	return value, true
end

-- Convert a single Luau/Roblox value into something JSON-encodable.
function Serialize.value(v)
	local t = typeof(v)
	if t == "nil" then
		return nil
	elseif t == "number" or t == "boolean" or t == "string" then
		return v
	elseif t == "Instance" then
		return { __ref = Refs.refFor(v), __path = v:GetFullName(), __class = v.ClassName }
	elseif t == "EnumItem" then
		return { __enum = tostring(v) }
	else
		-- Vector3, Vector2, Color3, CFrame, UDim, UDim2, BrickColor, NumberRange, ...
		return { __t = t, value = tostring(v) }
	end
end

local function isArray(tbl)
	local n = 0
	for k in pairs(tbl) do
		n += 1
		if type(k) ~= "number" or k ~= math.floor(k) or k < 1 then
			return false
		end
	end
	return n == #tbl
end

-- Deep-sanitize an arbitrary value so HttpService:JSONEncode never throws.
function Serialize.deep(v, depth)
	depth = depth or 0
	local t = typeof(v)
	if t == "table" then
		if depth > 6 then
			return "<max-depth>"
		end
		local out = {}
		if isArray(v) then
			for i, item in ipairs(v) do
				out[i] = Serialize.deep(item, depth + 1)
			end
		else
			local n = 0
			for k, item in pairs(v) do
				n += 1
				if n > 250 then
					out.__truncated = true
					break
				end
				out[tostring(k)] = Serialize.deep(item, depth + 1)
			end
		end
		return out
	elseif t == "number" or t == "boolean" or t == "string" or t == "nil" then
		return v
	else
		return Serialize.value(v)
	end
end

-- djb2 hash, kept inside uint32 via bit32 so it is precision-safe.
function Serialize.hash(s)
	local h = 5381
	for i = 1, #s do
		h = bit32.band(bit32.lshift(h, 5) + h + string.byte(s, i), 0xFFFFFFFF)
	end
	return string.format("s_%08x", h)
end

return Serialize
