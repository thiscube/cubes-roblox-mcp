--!nonstrict
-- HudOverlay: the activity island at the top centre of the 3D viewport.
--
-- One pill that says what Claude is doing, in one word, and on what:
--   working    spinner   Scripting   Lobby.Door   4s
--   done       dot       Scripting   Lobby.Door
--   failed     dot       Scripting   not_found            (in red)
--   thinking   dots      Thinking                         (shimmer)
--   idle       dot       Idle                             (dim)
-- The island is always on screen while the toggle is on.
--
-- Behind it, a glow around the edge of the viewport while Claude is active
-- (working or thinking): it appears at full strength with no fade in, pulses
-- gently, and fades out slowly once Claude goes Idle.
--
-- "Thinking" is inferred. The plugin cannot see the model, only the gaps
-- between its tool calls: a gap right after a command is Claude deciding what
-- to do next, and a long one means the turn is over, so the island says Idle.

local CoreGui = game:GetService("CoreGui")
local TweenService = game:GetService("TweenService")
local TextService = game:GetService("TextService")
local RunService = game:GetService("RunService")

local Config = require(script.Parent.Config)

local HudOverlay = {}

-- ---- tokens -----------------------------------------------------------

local C = {
	surface = Color3.fromRGB(13, 14, 17),
	edge = Color3.fromRGB(255, 255, 255),
	text = Color3.fromRGB(244, 245, 248),
	soft = Color3.fromRGB(184, 188, 199),
	dim = Color3.fromRGB(148, 152, 164),
	faint = Color3.fromRGB(98, 102, 114),
	accent = Color3.fromRGB(125, 166, 255),
	ok = Color3.fromRGB(94, 214, 148),
	err = Color3.fromRGB(255, 110, 110),
}

local FAMILY = "rbxasset://fonts/families/BuilderSans.json"
local WORD_FONT = Font.new(FAMILY, Enum.FontWeight.Bold)
local META_FONT = Font.new(FAMILY, Enum.FontWeight.Medium)

local HEIGHT = 36
local TOP = 14
local PAD_LEFT = 12
local PAD_RIGHT = 16
local GAP = 8
local ICON = 16
local WORD_SIZE = 15
local META_SIZE = 14
local TARGET_MAX = 220

-- Edge glow. Image and colour are the ones from the design in StarterGui.
local GLOW_IMAGE = "rbxassetid://113279140467776"
local GLOW_COLOR = Color3.new(1, 0.407843, 0.0666667)
local GLOW_BRIGHT = 0.5 -- ImageTransparency at the top of the pulse
local GLOW_DIM = 0.75 -- and at the bottom
local GLOW_PERIOD = 2.4 -- seconds for one full pulse
local GLOW_FADE = TweenInfo.new(1.6, Enum.EasingStyle.Sine, Enum.EasingDirection.Out)

local HOLD_AFTER_FINISH = 0.45 -- the finished word stays before "Thinking"
local HOLD_AFTER_FAIL = 2.5 -- long enough to read the error
local THINKING_TIMEOUT = Config.IDLE_AFTER -- no command for this long: the turn is over, show Idle
local TIMER_AFTER = 1.5 -- elapsed time only shows for slow commands

local RESIZE = TweenInfo.new(0.42, Enum.EasingStyle.Quint, Enum.EasingDirection.Out)
local FADE_IN = TweenInfo.new(0.22, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)
local FADE_OUT = TweenInfo.new(0.2, Enum.EasingStyle.Quad, Enum.EasingDirection.In)
local POP = TweenInfo.new(0.5, Enum.EasingStyle.Back, Enum.EasingDirection.Out)

-- ---- mutate classification ---------------------------------------------
-- Used by Transport to label a mutate that arrives without the server's
-- `via.activity` (a command sent outside any tool call).

local SCRIPT_CLASSES = { Script = true, LocalScript = true, ModuleScript = true }

function HudOverlay.mutateKind(args)
	local ops = args and args.ops
	if type(ops) ~= "table" or #ops == 0 then return "edit" end
	local counts, script = {}, false
	for _, op in ipairs(ops) do
		local k = type(op) == "table" and op.op or nil
		if k then counts[k] = (counts[k] or 0) + 1 end
		local props = type(op) == "table" and type(op.props) == "table" and op.props or nil
		if (k == "create" and SCRIPT_CLASSES[op.class]) or (props and props.Source ~= nil) then
			script = true
		end
	end
	if counts.delete then return "delete" end
	if script then return counts.create and "script_create" or "script" end
	if counts.create then return "create" end
	return "edit"
end

-- ---- text measuring ------------------------------------------------------

local widthCache, widthCacheSize = {}, 0

local function textWidth(text, font, size)
	if text == nil or text == "" then return 0 end
	local key = text .. "\0" .. tostring(size) .. "\0" .. font.Weight.Name
	local cached = widthCache[key]
	if cached then return cached end
	local params = Instance.new("GetTextBoundsParams")
	params.Text = text
	params.Font = font
	params.Size = size
	params.Width = 100000
	local ok, bounds = pcall(function()
		return TextService:GetTextBoundsAsync(params)
	end)
	local width = ok and math.ceil(bounds.X) or math.ceil(#text * size * 0.55)
	if widthCacheSize > 256 then
		widthCache, widthCacheSize = {}, 0
	end
	widthCache[key] = width
	widthCacheSize += 1
	return width
end

-- ---- tree ------------------------------------------------------------------

local screen, island, islandScale, glow
local spinner, spinnerGradient, dots, statusDot
local wordLabel, wordShimmer, targetLabel, timerLabel
local heartbeat

local function corner(parent, radius)
	local c = Instance.new("UICorner")
	c.CornerRadius = radius or UDim.new(0.5, 0)
	c.Parent = parent
	return c
end

local function label(parent, order, font, size, color)
	local t = Instance.new("TextLabel")
	t.LayoutOrder = order
	t.BackgroundTransparency = 1
	t.FontFace = font
	t.TextSize = size
	t.TextColor3 = color
	t.TextXAlignment = Enum.TextXAlignment.Left
	t.TextYAlignment = Enum.TextYAlignment.Center
	t.TextTruncate = Enum.TextTruncate.AtEnd
	t.Size = UDim2.fromOffset(0, 20)
	t.Text = ""
	t.Parent = parent
	return t
end

local function build()
	if screen then return end

	screen = Instance.new("ScreenGui")
	screen.Name = "CubesMCPActivity"
	screen.ResetOnSpawn = false
	screen.IgnoreGuiInset = true
	screen.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
	screen.DisplayOrder = 10000
	screen.Enabled = false
	screen.Parent = CoreGui

	-- Parented first, so the island draws on top of it.
	glow = Instance.new("ImageLabel")
	glow.Name = "Glow"
	glow.AnchorPoint = Vector2.new(0.5, 0.5)
	glow.Position = UDim2.fromScale(0.5, 0.5)
	glow.Size = UDim2.fromScale(1, 1)
	glow.BackgroundTransparency = 1
	glow.Image = GLOW_IMAGE
	glow.ImageColor3 = GLOW_COLOR
	glow.ScaleType = Enum.ScaleType.Stretch
	glow.ImageTransparency = 1
	glow.Active = false
	-- It covers the whole viewport, so it must never eat a click on a part.
	pcall(function() glow.Interactable = false end)
	glow.Parent = screen

	-- CanvasGroup so the whole island fades as one surface, and so content
	-- sliding in during a resize is clipped by the pill's own rounded edge.
	island = Instance.new("CanvasGroup")
	island.Name = "Island"
	island.AnchorPoint = Vector2.new(0.5, 0)
	island.Position = UDim2.new(0.5, 0, 0, TOP)
	island.Size = UDim2.fromOffset(HEIGHT, HEIGHT)
	island.BackgroundColor3 = C.surface
	island.BackgroundTransparency = 0.04
	island.BorderSizePixel = 0
	island.GroupTransparency = 1
	island.Parent = screen
	corner(island)

	local edge = Instance.new("UIStroke")
	edge.Color = C.edge
	edge.Transparency = 0.9
	edge.Thickness = 1
	edge.ApplyStrokeMode = Enum.ApplyStrokeMode.Border
	edge.Parent = island

	islandScale = Instance.new("UIScale")
	islandScale.Scale = 1
	islandScale.Parent = island

	-- Content is left-anchored at its natural width, so widening the pill
	-- reveals it rather than reflowing it.
	local content = Instance.new("Frame")
	content.Name = "Content"
	content.BackgroundTransparency = 1
	content.Size = UDim2.new(0, 1000, 1, 0)
	content.Parent = island

	local padding = Instance.new("UIPadding")
	padding.PaddingLeft = UDim.new(0, PAD_LEFT)
	padding.Parent = content

	local layout = Instance.new("UIListLayout")
	layout.FillDirection = Enum.FillDirection.Horizontal
	layout.VerticalAlignment = Enum.VerticalAlignment.Center
	layout.SortOrder = Enum.SortOrder.LayoutOrder
	layout.Padding = UDim.new(0, GAP)
	layout.Parent = content

	-- Icon slot: exactly one of spinner / dots / statusDot is visible.
	local iconSlot = Instance.new("Frame")
	iconSlot.Name = "Icon"
	iconSlot.LayoutOrder = 1
	iconSlot.BackgroundTransparency = 1
	iconSlot.Size = UDim2.fromOffset(ICON, ICON)
	iconSlot.Parent = content

	-- Spinner: a ring whose stroke fades along a rotating gradient, which reads
	-- as a sweeping arc. No image assets, so nothing to fail to load.
	spinner = Instance.new("Frame")
	spinner.AnchorPoint = Vector2.new(0.5, 0.5)
	spinner.Position = UDim2.fromScale(0.5, 0.5)
	spinner.Size = UDim2.fromOffset(13, 13)
	spinner.BackgroundTransparency = 1
	spinner.Visible = false
	spinner.Parent = iconSlot
	corner(spinner)
	local ring = Instance.new("UIStroke")
	ring.Color = C.accent
	ring.Thickness = 2
	ring.ApplyStrokeMode = Enum.ApplyStrokeMode.Border
	ring.Parent = spinner
	spinnerGradient = Instance.new("UIGradient")
	-- Opaque for the first ~third, gone by the middle: a clear arc, not a ring.
	spinnerGradient.Transparency = NumberSequence.new({
		NumberSequenceKeypoint.new(0, 0),
		NumberSequenceKeypoint.new(0.3, 0),
		NumberSequenceKeypoint.new(0.55, 1),
		NumberSequenceKeypoint.new(1, 1),
	})
	spinnerGradient.Parent = ring

	-- Thinking dots: three 4px dots filling the 16px slot (4+2+4+2+4).
	dots = Instance.new("Frame")
	dots.BackgroundTransparency = 1
	dots.Size = UDim2.fromScale(1, 1)
	dots.Visible = false
	dots.Parent = iconSlot
	local dotsLayout = Instance.new("UIListLayout")
	dotsLayout.FillDirection = Enum.FillDirection.Horizontal
	dotsLayout.VerticalAlignment = Enum.VerticalAlignment.Center
	dotsLayout.SortOrder = Enum.SortOrder.LayoutOrder
	dotsLayout.Padding = UDim.new(0, 2)
	dotsLayout.Parent = dots
	for i = 1, 3 do
		local d = Instance.new("Frame")
		d.Name = "Dot" .. i
		d.LayoutOrder = i
		d.BackgroundColor3 = C.soft
		d.BorderSizePixel = 0
		d.Size = UDim2.fromOffset(4, 4)
		d.Parent = dots
		corner(d)
	end

	-- Status dot for done / failed.
	statusDot = Instance.new("Frame")
	statusDot.AnchorPoint = Vector2.new(0.5, 0.5)
	statusDot.Position = UDim2.fromScale(0.5, 0.5)
	statusDot.Size = UDim2.fromOffset(8, 8)
	statusDot.BackgroundColor3 = C.ok
	statusDot.BorderSizePixel = 0
	statusDot.Visible = false
	statusDot.Parent = iconSlot
	corner(statusDot)

	wordLabel = label(content, 2, WORD_FONT, WORD_SIZE, C.text)
	wordShimmer = Instance.new("UIGradient")
	wordShimmer.Color = ColorSequence.new({
		ColorSequenceKeypoint.new(0, C.soft),
		ColorSequenceKeypoint.new(0.4, C.soft),
		ColorSequenceKeypoint.new(0.5, C.text),
		ColorSequenceKeypoint.new(0.6, C.soft),
		ColorSequenceKeypoint.new(1, C.soft),
	})
	wordShimmer.Enabled = false
	wordShimmer.Parent = wordLabel

	targetLabel = label(content, 3, META_FONT, META_SIZE, C.dim)
	timerLabel = label(content, 4, META_FONT, META_SIZE, C.faint)
	timerLabel.TextXAlignment = Enum.TextXAlignment.Right
end

-- ---- state -------------------------------------------------------------------

local enabled = false -- the user's toggle
local glowOn = false -- pulsing; false while fading out or hidden
local glowStart = 0
local glowFade = nil
local shown = false -- island currently on screen
local state = "idle" -- idle | working | done | failed | thinking
local current = nil -- { id, word, target, startedAt }
local taskCounter = 0
local gen = 0 -- bumps on every state change; delayed state jobs check it
local hideGen = 0 -- separate, so hiding the island never cancels the state timers

-- Island width for what is on screen right now. Everything is measured, so
-- the pill hugs its content exactly.
local function contentWidth()
	local w = PAD_LEFT + ICON + GAP + textWidth(wordLabel.Text, WORD_FONT, WORD_SIZE)
	if targetLabel.Visible then
		w += GAP + targetLabel.Size.X.Offset
	end
	if timerLabel.Visible then
		w += GAP + timerLabel.Size.X.Offset
	end
	return w + PAD_RIGHT
end

local function fit(instant)
	wordLabel.Size = UDim2.fromOffset(textWidth(wordLabel.Text, WORD_FONT, WORD_SIZE), 20)
	local goal = UDim2.fromOffset(contentWidth(), HEIGHT)
	if instant then
		island.Size = goal
	else
		TweenService:Create(island, RESIZE, { Size = goal }):Play()
	end
end

local function setTarget(text)
	local has = type(text) == "string" and text ~= ""
	targetLabel.Visible = has
	targetLabel.Text = has and text or ""
	targetLabel.Size = UDim2.fromOffset(has and math.min(textWidth(text, META_FONT, META_SIZE), TARGET_MAX) or 0, 20)
end

local function setTimer(seconds)
	if seconds == nil then
		timerLabel.Visible = false
		timerLabel.Text = ""
		return
	end
	timerLabel.Visible = true
	timerLabel.Text = string.format("%ds", seconds)
	-- Fixed to the widest two-digit value so the pill does not twitch each second.
	timerLabel.Size = UDim2.fromOffset(textWidth(seconds >= 100 and "888s" or "88s", META_FONT, META_SIZE), 20)
end

local function showIcon(which, color)
	spinner.Visible = which == "spinner"
	dots.Visible = which == "dots"
	statusDot.Visible = which == "dot"
	if which == "dot" then
		statusDot.BackgroundColor3 = color
		statusDot.Size = UDim2.fromOffset(4, 4)
		TweenService:Create(statusDot, POP, { Size = UDim2.fromOffset(8, 8) }):Play()
	end
end

-- Text changes land with a short fade so a new word never snaps in.
local function fadeTextIn()
	for _, t in ipairs({ wordLabel, targetLabel, timerLabel }) do
		t.TextTransparency = 1
		TweenService:Create(t, FADE_IN, { TextTransparency = 0 }):Play()
	end
end

local function animate()
	local now = os.clock()
	if glowOn then
		-- Starts at the bright end (cos 0 = 1) and eases to the dim end and back.
		local wave = (math.cos((now - glowStart) * math.pi * 2 / GLOW_PERIOD) + 1) / 2
		glow.ImageTransparency = GLOW_DIM + (GLOW_BRIGHT - GLOW_DIM) * wave
	end
	if state == "working" then
		spinnerGradient.Rotation = (now * 400) % 360
		local elapsed = current and (now - current.startedAt) or 0
		if elapsed >= TIMER_AFTER then
			local secs = math.floor(elapsed)
			if timerLabel.Text ~= string.format("%ds", secs) then
				local wasVisible = timerLabel.Visible
				local oldWidth = timerLabel.Size.X.Offset
				setTimer(secs)
				if not wasVisible or timerLabel.Size.X.Offset ~= oldWidth then
					fit(false)
				end
			end
		end
	elseif state == "thinking" then
		for i = 1, 3 do
			local phase = math.sin((now * 5) - (i - 1) * 0.9)
			local d = dots:FindFirstChild("Dot" .. i)
			if d then
				-- Never fully invisible, or three dots read as two.
				d.BackgroundTransparency = 0.45 - phase * 0.3
			end
		end
		wordShimmer.Offset = Vector2.new(((now * 0.55) % 1) * 2.4 - 1.2, 0)
	end
end

local function startHeartbeat()
	if heartbeat then return end
	heartbeat = RunService.Heartbeat:Connect(animate)
end

local function stopHeartbeat()
	if heartbeat then
		heartbeat:Disconnect()
		heartbeat = nil
	end
end

local function appear()
	if shown then return end
	shown = true
	hideGen += 1
	screen.Enabled = true
	island.Size = UDim2.fromOffset(HEIGHT, HEIGHT)
	island.GroupTransparency = 1
	islandScale.Scale = 0.86
	TweenService:Create(island, FADE_IN, { GroupTransparency = 0 }):Play()
	TweenService:Create(islandScale, POP, { Scale = 1 }):Play()
	startHeartbeat()
end

local function disappear()
	if not shown then return end
	shown = false
	hideGen += 1
	local myHide = hideGen
	TweenService:Create(island, RESIZE, { Size = UDim2.fromOffset(HEIGHT, HEIGHT) }):Play()
	TweenService:Create(island, FADE_OUT, { GroupTransparency = 1 }):Play()
	TweenService:Create(islandScale, FADE_OUT, { Scale = 0.9 }):Play()
	task.delay(0.42, function()
		if myHide ~= hideGen or shown then return end
		stopHeartbeat()
		if screen then screen.Enabled = false end
	end)
end

-- On: straight to full strength, no fade in. Off: a slow fade from wherever
-- the pulse happens to be.
local function setGlow(on)
	if on == glowOn then return end
	glowOn = on
	if glowFade then
		glowFade:Cancel()
		glowFade = nil
	end
	if on then
		glowStart = os.clock()
		glow.ImageTransparency = GLOW_BRIGHT
	else
		glowFade = TweenService:Create(glow, GLOW_FADE, { ImageTransparency = 1 })
		glowFade:Play()
	end
end

-- Paint `state` onto the tree. Called on every transition.
local function render()
	if not enabled or not screen then return end
	appear()
	setGlow(state ~= "idle")

	wordShimmer.Enabled = state == "thinking"
	setTimer(nil)

	if state == "working" then
		showIcon("spinner")
		wordLabel.Text = current.word
		wordLabel.TextColor3 = C.text
		setTarget(current.target)
		targetLabel.TextColor3 = C.dim
	elseif state == "done" then
		showIcon("dot", C.ok)
		wordLabel.TextColor3 = C.text
	elseif state == "failed" then
		showIcon("dot", C.err)
		wordLabel.TextColor3 = C.err
		targetLabel.TextColor3 = C.err
	elseif state == "thinking" then
		showIcon("dots")
		wordLabel.Text = "Thinking"
		wordLabel.TextColor3 = C.text
		setTarget(nil)
	elseif state == "idle" then
		showIcon("dot", C.faint)
		wordLabel.Text = "Idle"
		wordLabel.TextColor3 = C.dim
		setTarget(nil)
	end

	if state == "working" or state == "thinking" or state == "idle" then
		fadeTextIn()
	end
	fit(false)
end

local function goThinkingAfter(delay)
	local myGen = gen
	task.delay(delay, function()
		if myGen ~= gen then return end
		gen += 1
		state = "thinking"
		current = nil
		render()
		local thinkGen = gen
		task.delay(THINKING_TIMEOUT, function()
			if thinkGen ~= gen then return end
			gen += 1
			state = "idle"
			render()
		end)
	end)
end

-- ---- public API --------------------------------------------------------------

function HudOverlay.setVisible(on)
	build()
	enabled = on and true or false
	if enabled then
		render()
	else
		glowOn = false
		if glowFade then glowFade:Cancel() glowFade = nil end
		glow.ImageTransparency = 1
		disappear()
	end
end

function HudOverlay.isVisible()
	return enabled
end

-- word: the one-word activity. target: what it acts on, already shortened.
function HudOverlay.startTask(word, target)
	build()
	gen += 1
	taskCounter += 1
	current = { id = taskCounter, word = tostring(word or "Working"), target = target, startedAt = os.clock() }
	state = "working"
	render()
	return taskCounter
end

function HudOverlay.finishTask(id)
	if not current or current.id ~= id then return end
	gen += 1
	state = "done"
	render()
	goThinkingAfter(HOLD_AFTER_FINISH)
end

function HudOverlay.failTask(id, errCode)
	if not current or current.id ~= id then return end
	gen += 1
	state = "failed"
	if screen then
		setTarget((tostring(errCode or "error"):gsub("_", " ")))
	end
	render()
	goThinkingAfter(HOLD_AFTER_FAIL)
end

function HudOverlay.destroy()
	gen += 1
	hideGen += 1
	stopHeartbeat()
	if screen then
		screen:Destroy()
	end
	glowOn = false
	glowFade = nil
	screen, island, islandScale, glow = nil, nil, nil, nil
	spinner, spinnerGradient, dots, statusDot = nil, nil, nil, nil
	wordLabel, wordShimmer, targetLabel, timerLabel = nil, nil, nil, nil
	shown = false
end

return HudOverlay
