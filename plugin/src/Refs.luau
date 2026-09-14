--!nonstrict
-- Reference tokens.
--
-- After first sight, every instance gets a short opaque ID (p3, f12, s7, ...)
-- backed by a live Instance pointer — so tokens survive renames and reparents.
-- Also resolves ref tokens and dotted paths back to instances.

local Refs = {}

Refs.refs = {} -- ref string -> Instance
Refs.byInst = {} -- Instance -> ref string
Refs._counter = 0

-- Both directions of the ref map are weak so deleted instances (deleted in
-- Studio, not via mutate) can be GC'd. With weak values on refs and weak keys
-- on byInst, GC removes both entries together — tokens for dead instances
-- simply stop resolving, which callers already handle as `ref_dead`.
setmetatable(Refs.byInst, { __mode = "k" })
setmetatable(Refs.refs, { __mode = "v" })

function Refs.refFor(inst)
	local existing = Refs.byInst[inst]
	if existing then
		return existing
	end
	Refs._counter += 1
	local prefix
	if inst:IsA("BasePart") then prefix = "p"
	elseif inst:IsA("LuaSourceContainer") then prefix = "s"
	elseif inst:IsA("Folder") then prefix = "f"
	elseif inst:IsA("Model") then prefix = "m"
	else prefix = "x" end
	local ref = prefix .. tostring(Refs._counter)
	Refs.refs[ref] = inst
	Refs.byInst[inst] = ref
	return ref
end

-- Drop a ref (e.g. after the instance is destroyed).
function Refs.forget(inst)
	local ref = Refs.byInst[inst]
	if ref then
		Refs.refs[ref] = nil
		Refs.byInst[inst] = nil
	end
end

-- Resolve a ref token or dotted path to an Instance (nil if not found).
-- A leading "@" is tolerated and stripped.
function Refs.resolve(token)
	if type(token) ~= "string" then
		return nil
	end
	if token == "" then return nil end
	if string.sub(token, 1, 1) == "@" then
		token = string.sub(token, 2)
	end
	if Refs.refs[token] then
		return Refs.refs[token]
	end
	local node = game
	for part in string.gmatch(token, "[^%.]+") do
		if part ~= "game" and part ~= "DataModel" then
			local nxt = node:FindFirstChild(part)
			if not nxt and node == game then
				local ok, svc = pcall(game.GetService, game, part)
				if ok then
					nxt = svc
				end
			end
			node = nxt
			if not node then
				return nil
			end
		end
	end
	return node
end

-- Case-insensitive Levenshtein distance for short strings.
local function distance(a, b)
	a, b = string.lower(a), string.lower(b)
	if a == b then return 0 end
	local la, lb = #a, #b
	if la == 0 then return lb end
	if lb == 0 then return la end
	local prev, cur = {}, {}
	for j = 0, lb do prev[j] = j end
	for i = 1, la do
		cur[0] = i
		local ac = string.byte(a, i)
		for j = 1, lb do
			local cost = (ac == string.byte(b, j)) and 0 or 1
			local del = prev[j] + 1
			local ins = cur[j - 1] + 1
			local sub = prev[j - 1] + cost
			local m = del
			if ins < m then m = ins end
			if sub < m then m = sub end
			cur[j] = m
		end
		for j = 0, lb do prev[j] = cur[j] end
	end
	return prev[lb]
end

-- Try to resolve a path like Refs.resolve, but when it fails, walk back to the
-- last successful node and return up to 5 sibling-name suggestions (ranked by
-- name similarity to the failed segment). Used to make `not_found` errors
-- actionable instead of dead-ends.
--
-- Returns: { ok = true, instance = inst } on success,
--          { ok = false, suggestions = {...}, lastFoundPath = "..." } on miss.
function Refs.resolveWithSuggestions(token)
	if type(token) ~= "string" or token == "" then
		return { ok = false, suggestions = {}, lastFoundPath = "" }
	end
	if string.sub(token, 1, 1) == "@" then
		token = string.sub(token, 2)
	end
	if Refs.refs[token] then
		return { ok = true, instance = Refs.refs[token] }
	end

	local node = game
	local lastFound = node
	local lastFoundPath = "game"
	local failedSegment = nil
	for part in string.gmatch(token, "[^%.]+") do
		if part ~= "game" and part ~= "DataModel" then
			local nxt = node:FindFirstChild(part)
			if not nxt and node == game then
				local ok, svc = pcall(game.GetService, game, part)
				if ok then
					nxt = svc
				end
			end
			if not nxt then
				failedSegment = part
				break
			end
			node = nxt
			lastFound = nxt
			lastFoundPath = lastFoundPath .. "." .. part
		end
	end

	if not failedSegment then
		return { ok = true, instance = node }
	end

	-- Rank siblings (children of lastFound) by Levenshtein distance to the
	-- failed segment, cap at 5. If lastFound IS game, also include the top
	-- common services since FindFirstChild misses non-replicated services.
	local candidates = {}
	for _, child in ipairs(lastFound:GetChildren()) do
		candidates[#candidates + 1] = child.Name
	end
	if lastFound == game then
		for _, svcName in ipairs({
			"Workspace", "ServerScriptService", "ServerStorage", "ReplicatedStorage",
			"ReplicatedFirst", "StarterGui", "StarterPack", "StarterPlayer",
			"Lighting", "SoundService", "Players", "Teams", "TestService",
		}) do
			candidates[#candidates + 1] = svcName
		end
	end

	-- Dedupe + score
	local seen, scored = {}, {}
	for _, name in ipairs(candidates) do
		if not seen[name] then
			seen[name] = true
			scored[#scored + 1] = { name = name, d = distance(failedSegment, name) }
		end
	end
	table.sort(scored, function(a, b)
		if a.d == b.d then return a.name < b.name end
		return a.d < b.d
	end)

	local suggestions = {}
	for i = 1, math.min(5, #scored) do
		suggestions[#suggestions + 1] = lastFoundPath .. "." .. scored[i].name
	end

	return {
		ok = false,
		suggestions = suggestions,
		lastFoundPath = lastFoundPath,
		failedSegment = failedSegment,
	}
end

return Refs
