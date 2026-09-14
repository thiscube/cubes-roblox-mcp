--!nonstrict
-- The read path.
--
-- Resolve targets (ref / path / query), rank them by relevance, project a small
-- per-class property set, paginate, and stamp a snapshot hash so re-reads with
-- `since` are near-free.

local HttpService = game:GetService("HttpService")
local Selection = game:GetService("Selection")
local CollectionService = game:GetService("CollectionService")

local Refs = require(script.Parent.Refs)
local Serialize = require(script.Parent.Serialize)
local Query = require(script.Parent.Query)
local SessionState = require(script.Parent.SessionState)
local Diagnostics = require(script.Parent.Diagnostics)
local Viewport = require(script.Parent.Viewport)

local Read = {}

-- Predictive prefetch: when a read targets a small set of instances, the server
-- guesses the obvious follow-up and bundles it under `prefetched` (free to use,
-- cheap to ignore). Capped so big list reads stay lean.
local PREFETCH_MAX_PAGE = 3
local PREFETCH_SOURCE_CAP = 3000

local function prefetchFor(inst)
	if inst:IsA("LuaSourceContainer") then
		local pre = {}
		local source = Serialize.getProp(inst, "Source")
		if type(source) == "string" then
			pre.source = string.sub(source, 1, PREFETCH_SOURCE_CAP)
			if #source > PREFETCH_SOURCE_CAP then
				pre.sourceTruncated = true
			end
		end
		local mentions = {}
		for _, entry in ipairs(Diagnostics.entries) do
			if inst.Name ~= "" and string.find(entry.message, inst.Name, 1, true) then
				mentions[#mentions + 1] = entry
			end
		end
		if #mentions > 0 then
			pre.recentErrors = mentions
		end
		return pre
	end

	-- a non-script instance with a script child: bundle that child's source
	for _, child in ipairs(inst:GetChildren()) do
		if child:IsA("LuaSourceContainer") then
			local source = Serialize.getProp(child, "Source")
			return {
				childScript = {
					ref = Refs.refFor(child),
					name = child.Name,
					class = child.ClassName,
					source = type(source) == "string" and string.sub(source, 1, PREFETCH_SOURCE_CAP) or nil,
				},
			}
		end
	end
	return nil
end

-- Top ~5 most-relevant properties per class. Full dumps need an explicit select.
local DEFAULT_PROPS = {
	BasePart = { "Position", "Size", "Color", "Material", "Anchored" },
	MeshPart = { "Position", "Size", "Color", "Material", "MeshId" },
	Model = { "PrimaryPart" },
	Folder = {},
	Script = { "Enabled", "RunContext" },
	LocalScript = { "Enabled" },
	ModuleScript = {},
	Lighting = { "Brightness", "ClockTime", "Ambient", "OutdoorAmbient", "FogEnd", "GlobalShadows" },
	PointLight = { "Brightness", "Range", "Color", "Enabled" },
	SpotLight = { "Brightness", "Range", "Angle", "Color" },
	ParticleEmitter = { "Rate", "Lifetime", "Speed", "Enabled" },
	Decal = { "Texture", "Transparency", "Face" },
	Atmosphere = { "Density", "Offset", "Color", "Haze" },
	Sound = { "SoundId", "Volume", "Playing", "Looped" },
}
local GENERIC_PROPS = { "Name", "ClassName" }

-- Well-known Roblox defaults. Skip emitting these to save tokens.
-- Only booleans + unambiguous numeric scalars — DO NOT add Color3/Vector3 (type-sensitive eq).
local DEFAULT_PROP_VALUES = {
	Anchored = false,
	CanCollide = true,
	Transparency = 0,
	Reflectance = 0,
	Enabled = true,
}

local function defaultPropsFor(inst)
	if DEFAULT_PROPS[inst.ClassName] then
		return DEFAULT_PROPS[inst.ClassName]
	end
	if inst:IsA("BasePart") then
		return DEFAULT_PROPS.BasePart
	end
	if inst:IsA("LuaSourceContainer") then
		return DEFAULT_PROPS.Script
	end
	return GENERIC_PROPS
end

local function projectInstance(inst, format, select)
	local ref = Refs.refFor(inst)
	if format == "names_only" then
		return { ref = ref, name = inst.Name, class = inst.ClassName }
	end

	local propNames
	if type(select) == "table" then
		propNames = select
	else
		propNames = defaultPropsFor(inst)
	end

	local props = {}
	local hasProp = false
	for _, propName in ipairs(propNames) do
		local value, ok = Serialize.getProp(inst, propName)
		if ok and value ~= DEFAULT_PROP_VALUES[propName] then
			props[propName] = Serialize.value(value)
			hasProp = true
		end
	end

	local entry = {
		ref = ref,
		class = inst.ClassName,
		name = inst.Name,
	}
	if hasProp then
		entry.props = props
	end
	if format == "full" then
		entry.path = inst:GetFullName()
	end

	-- Attributes — only include if present (saves tokens on the common case).
	local attrs = inst:GetAttributes()
	if next(attrs) then
		local serialized = {}
		for k, v in pairs(attrs) do
			serialized[k] = Serialize.value(v)
		end
		entry.attrs = serialized
	end

	-- Tags — only include if present.
	local tags = CollectionService:GetTags(inst)
	if #tags > 0 then
		entry.tags = tags
	end

	if format == "summary" then
		entry.childCount = #inst:GetChildren()
	elseif format == "full" then
		local kids = {}
		for _, child in ipairs(inst:GetChildren()) do
			kids[#kids + 1] = { ref = Refs.refFor(child), name = child.Name, class = child.ClassName }
		end
		entry.children = kids
	end
	return entry
end

-- Sort targets by relevance so the first page is the useful page:
--   recently modified this session  >  selected in Studio  >  sticky class  >  name
-- `stickyClasses` is an optional ordered list passed down by the MCP server.
local function rankTargets(targets, stickyClasses)
	if #targets < 2 then
		return targets
	end

	local selected = {}
	for _, inst in ipairs(Selection:Get()) do
		selected[inst] = true
	end

	local stickyRank = {}
	if type(stickyClasses) == "table" then
		for i, className in ipairs(stickyClasses) do
			stickyRank[className] = #stickyClasses - i + 1
		end
	end

	local score = {}
	for _, inst in ipairs(targets) do
		local s = 0
		local recency = SessionState.recency(inst)
		if recency > 0 then
			s += 1000000 + recency
		end
		if selected[inst] then
			s += 100000
		end
		s += (stickyRank[inst.ClassName] or 0) * 1000
		score[inst] = s
	end

	table.sort(targets, function(a, b)
		if score[a] == score[b] then
			return a.Name < b.Name
		end
		return score[a] > score[b]
	end)
	return targets
end

function Read.read(args)
	args = args or {}

	-- viewport mode: a vision-grounded scene instead of a tree read.
	if args.viewport then
		return Viewport.capture(args.limit)
	end

	-- Fail loudly on wildcard select instead of silently falling back to the
	-- per-class default set with a note (which agents routinely missed).
	if args.select == "*" then
		return {
			error = "wildcard_select_unsupported",
			hint = "Pass an explicit list (e.g. select: ['Position', 'Size', 'Color', 'Material']), or omit `select` for the per-class default. Phase 1 has no API dump.",
		}
	end

	local targets = {}

	if args.ref then
		local inst = Refs.resolve(args.ref)
		if not inst then
			return { error = "ref_dead", ref = args.ref, hint = "Re-read the parent to get a fresh ref." }
		end
		if not inst:IsDescendantOf(game) then
			return { error = "ref_dead", ref = args.ref, last_seen_path = "(destroyed or unparented)" }
		end
		targets = args.children and inst:GetChildren() or { inst }
	elseif args.query then
		targets = Query.run(args.query)
	elseif args.path then
		local res = Refs.resolveWithSuggestions(args.path)
		if not res.ok then
			return {
				error = "not_found",
				path = args.path,
				failedSegment = res.failedSegment,
				lastFoundPath = res.lastFoundPath,
				suggestions = res.suggestions,
				hint = #res.suggestions > 0
					and ("Did you mean: " .. table.concat(res.suggestions, ", ") .. "?")
					or nil,
			}
		end
		targets = args.children and res.instance:GetChildren() or { res.instance }
	else
		-- Default: top-level services so the agent sees the full game shape, not
		-- just Workspace. Previously this returned Workspace:GetChildren() only,
		-- which made the agent blind to ServerScriptService / ReplicatedStorage /
		-- StarterGui / etc. unless it explicitly navigated there.
		targets = game:GetChildren()
	end

	targets = rankTargets(targets, args.stickyClasses)

	local total = #targets
	local limit = tonumber(args.limit) or 20
	local offset = tonumber(args.cursor) or 0
	local page = {}
	for i = offset + 1, math.min(offset + limit, total) do
		page[#page + 1] = targets[i]
	end
	local nextCursor = nil
	if offset + limit < total then
		nextCursor = tostring(offset + limit)
	end

	local format = args.format or "summary"
	local items = {}
	for _, inst in ipairs(page) do
		items[#items + 1] = projectInstance(inst, format, args.select)
	end

	-- Fingerprint over the projected `items` themselves so any change to a
	-- returned property — including manual Studio edits the agent didn't make —
	-- flips the snapshot. Previously hashed only ref+childCount+recency, which
	-- missed user-driven edits since recency only bumps on MCP-driven changes
	-- and would falsely report `unchanged` on a stale re-read.
	local okEncode, encoded = pcall(HttpService.JSONEncode, HttpService, items)
	local snapshot = Serialize.hash(okEncode and encoded or tostring(#items) .. ":" .. tostring(total))
	if args.since and args.since == snapshot then
		return { snapshot = snapshot, unchanged = true }
	end

	-- Predictive prefetch for focused reads (small page, not names-only).
	local prefetched = nil
	if args.prefetch ~= false and format ~= "names_only" and #page <= PREFETCH_MAX_PAGE then
		for i, inst in ipairs(page) do
			local pre = prefetchFor(inst)
			if pre then
				prefetched = prefetched or {}
				prefetched[items[i].ref] = pre
			end
		end
	end

	local result = {
		snapshot = snapshot,
		count = #items,
		total = total,
		cursor = nextCursor,
		items = items,
		prefetched = prefetched,
	}
	return result
end

return Read
