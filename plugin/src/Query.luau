--!nonstrict
-- Selector engine.
--
-- "Root/seg/seg" where each seg is a child name, "*" (children), or "**"
-- (all descendants), optionally followed by one OR MORE [Key OP Value] filters,
-- which are AND-ed together. Supported operators:
--   =   equals      (ClassName also matches via :IsA)
--   ~=  contains    (plain substring, e.g. on a script's Source)
--   !=  not equals
-- Special keys:
--   Tag          CollectionService tag membership — [Tag=Enemy] is "has tag Enemy"
--   @<name>      attribute lookup — [@hp=100], [@type=boss], [@frozen=true]
-- Examples:
--   Workspace/**[ClassName=Part][Anchored=true]
--   Workspace/**[Tag=Enemy]
--   Workspace/**[@hp!=0][Tag=Boss]
--   ServerScriptService/**[ClassName=Script][Source~=DataStore]
--   Lighting/*

local CollectionService = game:GetService("CollectionService")

local Refs = require(script.Parent.Refs)
local Serialize = require(script.Parent.Serialize)

local Query = {}

-- Parse one "[...]" body into { key, op, value }. nil if it doesn't parse.
-- The key may carry a "@" prefix to look up an attribute instead of a property.
local function parseFilter(body)
	local key, value = string.match(body, "^%s*(@?[%w_]+)%s*~=%s*(.-)%s*$")
	if key then
		return { key = key, op = "contains", value = value }
	end
	key, value = string.match(body, "^%s*(@?[%w_]+)%s*!=%s*(.-)%s*$")
	if key then
		return { key = key, op = "ne", value = value }
	end
	key, value = string.match(body, "^%s*(@?[%w_]+)%s*=%s*(.-)%s*$")
	if key then
		return { key = key, op = "eq", value = value }
	end
	return nil
end

-- Split a segment into its name and its (possibly empty) list of filters.
local function parseSegment(seg)
	local bracket = string.find(seg, "%[")
	if not bracket then
		return seg, {}
	end
	local name = string.sub(seg, 1, bracket - 1)
	local filters = {}
	for body in string.gmatch(seg, "%[(.-)%]") do
		local filter = parseFilter(body)
		if filter then
			filters[#filters + 1] = filter
		end
	end
	return name, filters
end

local function matchOne(inst, filter)
	local key, op, value = filter.key, filter.op, filter.value

	-- Tag filter: [Tag=Enemy] / [Tag!=Enemy] — uses CollectionService.
	if key == "Tag" then
		local has = CollectionService:HasTag(inst, value)
		if op == "eq" then
			return has
		end
		if op == "ne" then
			return not has
		end
		return false
	end

	-- Attribute filter: [@hp=100], [@type=boss], [@frozen=true].
	if string.sub(key, 1, 1) == "@" then
		local attrName = string.sub(key, 2)
		local raw = inst:GetAttribute(attrName)
		if raw == nil then
			return op == "ne" -- absent attribute only matches !=
		end
		local actual = tostring(raw)
		if op == "eq" then
			return actual == value
		end
		if op == "ne" then
			return actual ~= value
		end
		if op == "contains" then
			return string.find(actual, value, 1, true) ~= nil
		end
		return false
	end

	if key == "ClassName" and op == "eq" then
		return inst.ClassName == value or inst:IsA(value)
	end

	local actual
	if key == "ClassName" then
		actual = inst.ClassName
	elseif key == "Name" then
		actual = inst.Name
	else
		actual = Serialize.getProp(inst, key)
	end
	actual = tostring(actual)

	if op == "eq" then
		return actual == value
	elseif op == "ne" then
		return actual ~= value
	elseif op == "contains" then
		return string.find(actual, value, 1, true) ~= nil
	end
	return false
end

local function matchesFilters(inst, filters)
	for _, filter in ipairs(filters) do
		if not matchOne(inst, filter) then
			return false
		end
	end
	return true
end

function Query.run(query)
	local segments = {}
	for seg in string.gmatch(query, "[^/]+") do
		segments[#segments + 1] = seg
	end
	if #segments == 0 then
		return {}
	end

	local rootName, rootFilters = parseSegment(segments[1])
	local root = Refs.resolve(rootName)
	if not root then
		return {}
	end
	if not matchesFilters(root, rootFilters) then
		return {}
	end
	local current = { root }

	-- Fast path: `<root>/**[Tag=X]` — use CollectionService's tag index instead
	-- of walking GetDescendants(). Only eligible when there is exactly one
	-- segment after the root, its name is "**", and its sole filter is an
	-- equality on Tag. Any extra filters or segments fall through to the slow
	-- path so semantics stay identical.
	if #segments == 2 then
		local fpName, fpFilters = parseSegment(segments[2])
		if fpName == "**" and #fpFilters == 1 then
			local f = fpFilters[1]
			if f.key == "Tag" and f.op == "eq" then
				local results = {}
				local rootIsGame = root == game
				for _, inst in ipairs(CollectionService:GetTagged(f.value)) do
					if rootIsGame or inst:IsDescendantOf(root) then
						results[#results + 1] = inst
					end
				end
				return results
			end
		end
	end

	for i = 2, #segments do
		local name, filters = parseSegment(segments[i])
		if name == "" and #filters > 0 then
			name = "*"
		end
		local nextSet = {}
		for _, node in ipairs(current) do
			if name == "**" then
				for _, descendant in ipairs(node:GetDescendants()) do
					if matchesFilters(descendant, filters) then
						nextSet[#nextSet + 1] = descendant
					end
				end
			elseif name == "*" then
				for _, child in ipairs(node:GetChildren()) do
					if matchesFilters(child, filters) then
						nextSet[#nextSet + 1] = child
					end
				end
			else
				local child = node:FindFirstChild(name)
				if child and matchesFilters(child, filters) then
					nextSet[#nextSet + 1] = child
				end
			end
		end
		current = nextSet
	end
	return current
end

return Query
