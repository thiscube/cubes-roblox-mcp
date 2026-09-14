--!nonstrict
-- The connection status panel.
--
-- Dark, card-based layout inspired by the Rojo plugin: rounded corners,
-- generous padding, a status pill in the header, action buttons at the
-- bottom. Surfaces connection state, toggles, recent activity, and the
-- connect/disconnect lifecycle.

local Config = require(script.Parent.Config)
local HudOverlay = require(script.Parent.HudOverlay)
local TweenService = game:GetService("TweenService")
local TextService = game:GetService("TextService")

local StatusUi = {}

-- ---- palette ----------------------------------------------------------
-- Layered palette: card (sections) < bg (root) < input ≈ field < cardAlt.
local C = {
	bg = Color3.fromRGB(25, 26, 31), -- root panel background
	input = Color3.fromRGB(30, 30, 33), -- slightly below card (Host / Port fills)
	card = Color3.fromRGB(21, 22, 27), -- card surfaces, recessed below bg
	cardAlt = Color3.fromRGB(46, 46, 50), -- toggle rest state
	field = Color3.fromRGB(31, 31, 35),
	stroke = Color3.fromRGB(58, 58, 64),
	text = Color3.fromRGB(240, 240, 244),
	dim = Color3.fromRGB(140, 140, 150),
	offline = Color3.fromRGB(85, 85, 95), -- "not connected" dark grey for check rows
	mono = Color3.fromRGB(210, 210, 220),
	accent = Color3.fromRGB(86, 134, 235),
	green = Color3.fromRGB(76, 196, 124),
	yellow = Color3.fromRGB(235, 184, 64),
	red = Color3.fromRGB(220, 56, 56),
	orange = Color3.fromRGB(228, 138, 64),
}

local CHECK_ICON = "rbxassetid://122306339859716"
-- Collapse-toggle icons — minimize shows while a card is expanded, expand
-- shows while it is collapsed.
local COLLAPSE_ICON = "rbxassetid://138820528332641"
local EXPAND_ICON = "rbxassetid://137109726803181"

local MODE_INFO = {
	off = { label = "Disconnected", color = C.dim },
	connecting = { label = "Connecting", color = C.yellow },
	online = { label = "Connected", color = C.green },
	server_unreachable = { label = "Server unreachable", color = C.red },
	version_mismatch = { label = "Out of date", color = C.orange },
	unauthorized = { label = "Token needed", color = C.orange },
}

-- Per-state labels for each check row. The render() picks the state from
-- Transport.mode and writes the corresponding label + color + pulse.
local CHECK_INFO = {
	http = {
		offline = "HTTP Offline",
		connecting = "HTTP Connecting",
		online = "HTTP Online",
		error = "HTTP Unreachable",
	},
	bridge = {
		offline = "MCP Disconnected",
		connecting = "MCP Connecting",
		online = "MCP Connected",
		error = "MCP Disconnected",
	},
	commands = {
		offline = "Commands Idle",
		connecting = "Commands Registering",
		online = "Commands Registered",
		error = "Commands Idle",
	},
}

-- For each Transport.mode, what state should each check row be in?
local MODE_TO_STATES = {
	off = { http = "offline", bridge = "offline", commands = "offline" },
	connecting = { http = "connecting", bridge = "offline", commands = "offline" },
	online = { http = "online", bridge = "online", commands = "online" },
	server_unreachable = { http = "error", bridge = "offline", commands = "offline" },
	version_mismatch = { http = "online", bridge = "error", commands = "offline" },
	unauthorized = { http = "online", bridge = "error", commands = "offline" },
}

local TOGGLE_TWEEN = TweenInfo.new(0.22, Enum.EasingStyle.Quint, Enum.EasingDirection.Out)
-- Collapse/expand: Cubic/Out — a clear ease-out without Quint's extremely flat
-- tail. Roblox UI has no subpixel precision (AbsoluteSize rounds to whole
-- pixels), so a very flat tail freezes on the same integer pixel for several
-- frames near the end. Cubic's tail is gentle enough to avoid that, and the
-- CanvasGroup GroupTransparency fade in the same tween masks any residual
-- stepping. (Sine read as too linear; Cubic keeps the eased feel.)
local COLLAPSE_TWEEN = TweenInfo.new(0.26, Enum.EasingStyle.Cubic, Enum.EasingDirection.Out)
-- Toggle press feedback (iOS button-tap feel): a quick scale-down on press,
-- then a springy settle back. Back/Out gives the subtle overshoot of a spring.
local PRESS_IN = TweenInfo.new(0.1, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)
local PRESS_OUT = TweenInfo.new(0.5, Enum.EasingStyle.Back, Enum.EasingDirection.Out)

local function ago(t)
	if not t or t == 0 then return "never" end
	local d = os.clock() - t
	if d < 1.5 then return "just now"
	elseif d < 60 then return string.format("%ds ago", math.floor(d))
	else return string.format("%dm ago", math.floor(d / 60)) end
end

local function duration(s)
	if not s or s <= 0 then return "—" end
	s = math.floor(s)
	if s < 60 then return string.format("%ds", s) end
	if s < 3600 then return string.format("%dm %ds", math.floor(s / 60), s % 60) end
	if s < 86400 then return string.format("%dh %dm", math.floor(s / 3600), math.floor((s % 3600) / 60)) end
	return string.format("%dd %dh", math.floor(s / 86400), math.floor((s % 86400) / 3600))
end


-- ---- helpers ----------------------------------------------------------
local function rounded(inst, radius)
	local c = Instance.new("UICorner")
	c.CornerRadius = UDim.new(0, radius or 8)
	c.Parent = inst
	return c
end

local function stroke(inst, color, transparency)
	local s = Instance.new("UIStroke")
	s.Color = color or C.stroke
	s.Transparency = transparency or 0.5
	s.Thickness = 1
	s.ApplyStrokeMode = Enum.ApplyStrokeMode.Border
	s.Parent = inst
	return s
end

local function padding(inst, all, options)
	local p = Instance.new("UIPadding")
	local t, r, b, l
	if options then
		t = options.top or all
		r = options.right or all
		b = options.bottom or all
		l = options.left or all
	else
		t, r, b, l = all, all, all, all
	end
	p.PaddingTop = UDim.new(0, t)
	p.PaddingRight = UDim.new(0, r)
	p.PaddingBottom = UDim.new(0, b)
	p.PaddingLeft = UDim.new(0, l)
	p.Parent = inst
	return p
end

local function vlist(inst, gap)
	local l = Instance.new("UIListLayout")
	l.FillDirection = Enum.FillDirection.Vertical
	l.SortOrder = Enum.SortOrder.LayoutOrder
	l.Padding = UDim.new(0, gap or 6)
	l.Parent = inst
	return l
end

local function text(parent, opts)
	local t = Instance.new("TextLabel")
	t.BackgroundTransparency = 1
	t.Font = Enum.Font.GothamMedium
	t.TextSize = 13
	t.TextXAlignment = Enum.TextXAlignment.Left
	t.TextYAlignment = Enum.TextYAlignment.Center
	t.TextColor3 = C.text
	t.TextTruncate = Enum.TextTruncate.AtEnd
	t.Size = UDim2.new(1, 0, 0, 18)
	for k, v in pairs(opts or {}) do t[k] = v end
	t.Parent = parent
	return t
end

local function card(parent, layoutOrder)
	local f = Instance.new("Frame")
	f.BackgroundColor3 = C.card
	f.BorderSizePixel = 0
	f.Size = UDim2.new(1, 0, 0, 0)
	f.AutomaticSize = Enum.AutomaticSize.Y
	f.LayoutOrder = layoutOrder or 0
	f.Parent = parent
	rounded(f, 10)
	stroke(f, C.stroke, 0.55)
	padding(f, 14)
	return f
end

local function button(parent, opts)
	local b = Instance.new("TextButton")
	b.Font = Enum.Font.GothamMedium
	b.TextSize = 13
	b.AutoButtonColor = true
	b.BorderSizePixel = 0
	b.TextColor3 = C.text
	b.BackgroundColor3 = C.cardAlt
	b.Size = UDim2.fromOffset(80, 28)
	for k, v in pairs(opts or {}) do b[k] = v end
	b.Parent = parent
	rounded(b, 6)
	return b
end

-- A row inside a card: label on the left (1fr), value/control on the right.
local function row(parent, layoutOrder, height)
	local r = Instance.new("Frame")
	r.BackgroundTransparency = 1
	r.Size = UDim2.new(1, 0, 0, height or 20)
	r.LayoutOrder = layoutOrder
	r.Parent = parent
	return r
end

-- attachCollapse(cardFrame, titleText, bodyItems, expanded, onToggle)
--   onToggle (optional): called with the new expanded state at the END of
--   every collapse / expand transition (after isExpanded has flipped). Lets a
--   caller react to the direction of a toggle — the Connection card uses it to
--   close its status dropdown only when the card is being collapsed.
local function attachCollapse(cardFrame, titleText, bodyItems, expanded, onToggle)
	local header = row(cardFrame, 0, 24)
	local titleLabel = text(header, {
		Font = Enum.Font.GothamBold,
		TextSize = 17,
		Text = titleText,
		Size = UDim2.new(1, -38, 1, 0),
	})

	-- Collapse toggle: a circular icon button. The minimize / expand glyph
	-- sits in a centred ImageLabel (ScaleType.Fit) so it keeps its aspect
	-- ratio; the button itself is just the circular hover / press plate,
	-- transparent at rest so it blends into the card.
	local toggle = Instance.new("ImageButton")
	toggle.AnchorPoint = Vector2.new(1, 0.5)
	toggle.Position = UDim2.new(1, 0, 0.5, 0)
	toggle.Size = UDim2.fromOffset(36, 36)
	toggle.AutoButtonColor = false
	toggle.BackgroundColor3 = C.field
	toggle.BackgroundTransparency = 1
	toggle.BorderSizePixel = 0
	toggle.Image = ""
	toggle.Parent = header

	local toggleCorner = Instance.new("UICorner")
	toggleCorner.CornerRadius = UDim.new(0.5, 0)
	toggleCorner.Parent = toggle

	local toggleIcon = Instance.new("ImageLabel")
	toggleIcon.AnchorPoint = Vector2.new(0.5, 0.5)
	toggleIcon.Position = UDim2.fromScale(0.5, 0.5)
	toggleIcon.Size = UDim2.fromScale(1.3, 1.3)
	toggleIcon.BackgroundTransparency = 1
	toggleIcon.ImageColor3 = Color3.new(1, 1, 1)
	toggleIcon.ScaleType = Enum.ScaleType.Fit
	toggleIcon.Image = expanded and COLLAPSE_ICON or EXPAND_ICON
	toggleIcon.Parent = toggle

	-- Lock the icon box to a 1:1 square so layout can never squish it; the
	-- image inside still keeps its own aspect ratio via ScaleType.Fit.
	local toggleIconRatio = Instance.new("UIAspectRatioConstraint")
	toggleIconRatio.AspectRatio = 1
	toggleIconRatio.Parent = toggleIcon

	-- Driven by refreshToggle for the iOS-style press dip.
	local toggleIconScale = Instance.new("UIScale")
	toggleIconScale.Scale = 1
	toggleIconScale.Parent = toggleIcon

	-- Circular feedback: invisible at rest, a C.field plate on hover, a
	-- brighter C.cardAlt plate while pressed.
	local toggleHovered, togglePressed = false, false
	local function refreshToggle()
		TweenService:Create(toggle, TOGGLE_TWEEN, {
			BackgroundColor3 = togglePressed and C.cardAlt or C.field,
			BackgroundTransparency = (toggleHovered or togglePressed) and 0 or 1,
		}):Play()
		-- iOS-style press: a quick dip in, a springy settle back out.
		TweenService:Create(toggleIconScale, togglePressed and PRESS_IN or PRESS_OUT, {
			Scale = togglePressed and 0.85 or 1,
		}):Play()
	end
	toggle.MouseEnter:Connect(function()
		toggleHovered = true
		refreshToggle()
	end)
	toggle.MouseLeave:Connect(function()
		toggleHovered = false
		togglePressed = false
		refreshToggle()
	end)
	toggle.MouseButton1Down:Connect(function()
		togglePressed = true
		refreshToggle()
	end)
	toggle.MouseButton1Up:Connect(function()
		togglePressed = false
		refreshToggle()
	end)

	local bodyGap = 6

	-- ---- collapse state model -----------------------------------------
	-- `itemVisibility[item]` is the SINGLE source of truth for whether a body
	-- item should be shown. attachCollapse owns every write to item.Visible —
	-- callers never poke item.Visible directly; they go through setItemVisible.
	-- Decoupling intent (this table) from the live .Visible is what makes the
	-- card robust: .Visible is a derived value, reconciled from the table by
	-- applyFinalState, so a collapse / expand / dropdown-toggle in ANY order
	-- can never leave intent and layout disagreeing.
	local isExpanded = expanded
	local itemVisibility = {}

	-- Body height = sum of the heights of items whose intended visibility is
	-- on, plus one bodyGap between each. Reads `itemVisibility`, never the live
	-- item.Visible, so a height computed mid-transition still reflects intent.
	-- An item that auto-sizes on Y reports its live AbsoluteSize; a fixed item
	-- reports its Size.Y.Offset.
	local function computeBodyHeight()
		local h = 0
		local visibleCount = 0
		for _, item in ipairs(bodyItems) do
			if itemVisibility[item] ~= false then
				if item.AutomaticSize == Enum.AutomaticSize.Y
					or item.AutomaticSize == Enum.AutomaticSize.XY then
					h += item.AbsoluteSize.Y
				else
					h += item.Size.Y.Offset
				end
				visibleCount += 1
			end
		end
		if visibleCount > 1 then
			h += bodyGap * (visibleCount - 1)
		end
		return h
	end

	-- CanvasGroup (not a plain Frame): it renders its whole subtree to a
	-- texture and exposes GroupTransparency, a continuous 0-1 float. The
	-- collapse tween fades GroupTransparency alongside the integer-pixel Size
	-- tween — transparency has no pixel rounding, so the fade is perfectly
	-- smooth and the eye reads the whole motion as seamless even where the
	-- Size is stepping. It is still a GuiObject, so Size / ClipsDescendants /
	-- BackgroundTransparency / children / layouts all behave as before.
	local body = Instance.new("CanvasGroup")
	body.BackgroundTransparency = 1
	body.ClipsDescendants = true
	-- CanvasResolutionFidelity is left at its default (Automatic): the render
	-- texture is sized to the canvas's own pixel footprint, so for a group
	-- sized 1:1 with the screen the text is rasterised at native resolution
	-- and stays crisp through the texture pass.
	body.GroupTransparency = expanded and 0 or 1
	body.LayoutOrder = 1
	body.Visible = expanded
	body.Parent = cardFrame
	vlist(body, bodyGap)

	for _, item in ipairs(bodyItems) do
		itemVisibility[item] = item.Visible
		item.Parent = body
		item.Visible = expanded and item.Visible or false
	end
	body.Size = UDim2.new(1, 0, 0, expanded and computeBodyHeight() or 0)

	-- Active size-tween + flag. While `sizeTween` is live, enforce() must NOT
	-- touch body.Size / .Visible / item visibility — otherwise a render tick
	-- snaps the body and the running tween crawls back over it (the stutter).
	local sizeTween = nil
	local isTweening = false
	-- Set when an intent change (setItemVisible / requestResize) lands while a
	-- body tween is already running and so could not be acted on. The running
	-- tween's completion handler re-fits with a fresh ANIMATED tween instead of
	-- snapping — this is what keeps rapid toggling smooth: a click during the
	-- tween redirects the animation rather than corrupting the end state.
	local pendingResize = false

	-- The exact end-state set, run once on tween completion (or when idle, by
	-- enforce()). Reconciles every item's live .Visible to `itemVisibility`
	-- (the source of truth) in BOTH branches, then sizes the body to match —
	-- so .Visible and body.Size can never drift apart once a tween settles.
	local function applyFinalState()
		if isExpanded then
			for _, item in ipairs(bodyItems) do
				item.Visible = itemVisibility[item] ~= false
			end
			body.Visible = true
			body.Size = UDim2.new(1, 0, 0, computeBodyHeight())
			body.GroupTransparency = 0
		else
			body.Visible = false
			body.Size = UDim2.new(1, 0, 0, 0)
			body.GroupTransparency = 1
			for _, item in ipairs(bodyItems) do
				item.Visible = false
			end
		end
	end

	-- The ONE place body.Size / body.GroupTransparency are tweened. setExpanded,
	-- requestResize and setItemVisible all route through here, so there is only
	-- ever a single live body tween — no two state machines can race on
	-- body.Size. `targetHeight` is the body height to animate to; `targetOpacity`
	-- the GroupTransparency end-state (0 opaque, 1 faded).
	local function startBodyTween(targetHeight, targetOpacity)
		-- Cancel a stale size-tween so a rapid re-toggle (or a dropdown resize
		-- landing mid-collapse) never stacks two tweens fighting over body.Size.
		if sizeTween then
			sizeTween:Cancel()
			sizeTween = nil
		end
		isTweening = true
		-- Size + GroupTransparency tween together: expanding drives the group
		-- opaque (0) as it grows, collapsing fades it out (1) as it shrinks.
		-- The continuous transparency masks the integer-pixel Size stepping.
		sizeTween = TweenService:Create(body, COLLAPSE_TWEEN, {
			Size = UDim2.new(1, 0, 0, targetHeight),
			GroupTransparency = targetOpacity,
		})
		sizeTween.Completed:Connect(function(playbackState)
			-- A Cancelled completion means a newer tween already took over —
			-- let that one own the final state.
			if playbackState ~= Enum.PlaybackState.Completed then
				return
			end
			sizeTween = nil
			isTweening = false
			if pendingResize and isExpanded then
				-- An intent change arrived mid-tween. Re-fit with a fresh
				-- ANIMATED tween from where we are now, so a click during the
				-- tween redirects the motion smoothly instead of snapping.
				-- Reveal newly-intended items up front; items being hidden stay
				-- on-screen and are clipped away as this corrective tween runs.
				pendingResize = false
				for _, item in ipairs(bodyItems) do
					if itemVisibility[item] ~= false then
						item.Visible = true
					end
				end
				startBodyTween(computeBodyHeight(), 0)
			else
				-- One exact set: snap to the computed height + correct visibility.
				pendingResize = false
				applyFinalState()
			end
		end)
		sizeTween:Play()
	end

	local function setExpanded(nextExpanded)
		if isExpanded == nextExpanded then
			return
		end
		isExpanded = nextExpanded
		toggleIcon.Image = isExpanded and COLLAPSE_ICON or EXPAND_ICON

		-- Opening: body must be visible for the whole tween, and every item
		-- whose intent is "on" is shown up front so it fades in with the body.
		-- Collapsing: items stay on-screen (Visible untouched) so they fade out
		-- with the body — applyFinalState hides them when the tween completes.
		-- itemVisibility is NOT snapshotted here: it is already authoritative,
		-- so a collapse never has to "remember" anything.
		if isExpanded then
			body.Visible = true
			for _, item in ipairs(bodyItems) do
				item.Visible = itemVisibility[item] ~= false
			end
		end

		startBodyTween(isExpanded and computeBodyHeight() or 0, isExpanded and 0 or 1)

		-- Fired AFTER startBodyTween, so a callback that touches body items
		-- (setItemVisible) sees isTweening = true and only records intent —
		-- the tween just started owns body.Size. The body tween already
		-- captured its target height from computeBodyHeight() above.
		if onToggle then
			onToggle(isExpanded)
		end
	end

	toggle.Activated:Connect(function()
		setExpanded(not isExpanded)
	end)

	-- requestResize() re-runs the body size-tween to the current
	-- computeBodyHeight() WITHOUT changing any intent — used when a body item's
	-- own content changes height (e.g. the status dropdown's rows). A no-op
	-- while collapsed (a resize must never expand a collapsed card). While a
	-- tween is already running it just latches pendingResize, so the running
	-- tween's completion re-fits with a fresh animated tween — never a snap.
	local function requestResize()
		if not isExpanded then
			return
		end
		if isTweening then
			pendingResize = true
			return
		end
		startBodyTween(computeBodyHeight(), 0)
	end

	-- setItemVisible(item, visible): the ONLY supported way to show / hide a
	-- body item. Updates the intent table, then:
	--   * shows the item up front when revealing, so the body tween grows over
	--     a fully-laid-out item (kept hidden by body.ClipsDescendants until the
	--     body reaches it);
	--   * leaves the item on-screen when hiding, so it is clipped away as the
	--     body shrinks — applyFinalState hides it on tween completion;
	--   * re-fits the card via the single body tween when expanded + idle.
	-- While collapsed it just records intent: setExpanded picks it up on the
	-- next expand. While a tween runs it latches pendingResize so the running
	-- tween's completion re-fits to the new intent with a fresh animated tween.
	-- Unchanged value => no-op (so a per-frame render() call that re-asserts the
	-- same visibility never restarts the tween).
	local function setItemVisible(item, visible)
		visible = visible ~= false
		if (itemVisibility[item] ~= false) == visible then
			return
		end
		itemVisibility[item] = visible
		if not isExpanded then
			return
		end
		if isTweening then
			-- A tween owns body.Size right now. Latch the re-fit: its completion
			-- handler reads the updated itemVisibility and animates the
			-- correction. (A revealed item will be shown there too.)
			pendingResize = true
			return
		end
		if visible then
			item.Visible = true
		end
		startBodyTween(computeBodyHeight(), 0)
	end

	-- enforce() is called every render — when expanded, keep body sized to the
	-- current set of visible items so dynamic show/hide doesn't leave gaps.
	-- It MUST early-return while a body tween is in progress, or it would snap
	-- body.Size out from under the running tween every render tick.
	local function enforce()
		if isTweening then
			return
		end
		applyFinalState()
	end

	return setExpanded, titleLabel, enforce, requestResize, setItemVisible
end

-- A network-signal icon: a clickable button holding 4 thin bars of rising
-- height. Bars below the lit count tint to a "lit" color; the rest sit at a
-- recessed rest color. Returns the button plus a setter `(litCount, color)`.
local function signalIcon(parent, layoutOrder)
	local btn = Instance.new("ImageButton")
	btn.AutoButtonColor = false
	-- Rest: fully transparent so it blends into the card. Hover fades this
	-- plate in (see refreshIconTint) using C.field — the endpoint card's color.
	btn.BackgroundColor3 = C.field
	btn.BackgroundTransparency = 1
	btn.BorderSizePixel = 0
	btn.Size = UDim2.fromOffset(24, 24)
	btn.LayoutOrder = layoutOrder or 0
	btn.Parent = parent
	-- Circle hover plate (corner radius 50%). Padding centres the 14px bar
	-- group inside the larger button so the icon sits in the middle.
	local btnCorner = Instance.new("UICorner")
	btnCorner.CornerRadius = UDim.new(0.5, 0)
	btnCorner.Parent = btn
	padding(btn, 5)

	-- Bars laid out left-to-right, bottom-aligned, rising in height.
	local barLayout = Instance.new("UIListLayout")
	barLayout.FillDirection = Enum.FillDirection.Horizontal
	barLayout.VerticalAlignment = Enum.VerticalAlignment.Bottom
	barLayout.HorizontalAlignment = Enum.HorizontalAlignment.Center
	barLayout.SortOrder = Enum.SortOrder.LayoutOrder
	barLayout.Padding = UDim.new(0, 2)
	barLayout.Parent = btn

	local barHeights = { 5, 8, 11, 14 }
	local bars = {}
	for i, h in ipairs(barHeights) do
		local bar = Instance.new("Frame")
		bar.BackgroundColor3 = C.offline
		bar.BorderSizePixel = 0
		bar.Size = UDim2.fromOffset(2, h)
		bar.LayoutOrder = i
		bar.Parent = btn
		rounded(bar, 1)
		bars[i] = bar
	end

	-- setBars(litCount, color): bars 1..litCount take `color`, rest are dim.
	-- A second call with the same args is cheap (Tween no-ops on equal goals).
	local function setBars(litCount, color)
		for i, bar in ipairs(bars) do
			local lit = i <= litCount
			TweenService:Create(bar, TOGGLE_TWEEN, {
				BackgroundColor3 = lit and color or C.offline,
				BackgroundTransparency = lit and 0 or 0.45,
			}):Play()
		end
	end

	return btn, setBars
end

-- ---- public -----------------------------------------------------------
function StatusUi.create(plugin, Transport)
	local widgetInfo = DockWidgetPluginGuiInfo.new(
		Enum.InitialDockState.Float, false, false,
		380, 580, 320, 380
	)
	local widget = plugin:CreateDockWidgetPluginGui("CubesMCP_Status", widgetInfo)
	widget.Title = "Cubes MCP"
	widget.Name = "CubesMCP_Status"

	-- root: dark background, padding, vertical list, fixed header/footer + scroll body
	local root = Instance.new("Frame")
	root.BackgroundColor3 = C.bg
	root.BorderSizePixel = 0
	root.Size = UDim2.fromScale(1, 1)
	root.Parent = widget
	padding(root, 16)
	vlist(root, 12)

	-- ---- HEADER: title + status inline + version subtitle ---------------
	local header = Instance.new("Frame")
	header.BackgroundTransparency = 1
	header.Size = UDim2.new(1, 0, 0, 42)
	header.LayoutOrder = 1
	header.Parent = root

	-- Title row: horizontal flex layout so "Connected" hugs "Cubes MCP" no
	-- matter how wide the title text turns out to be on the user's font.
	local titleRow = Instance.new("Frame")
	titleRow.BackgroundTransparency = 1
	titleRow.Position = UDim2.fromOffset(0, 0)
	titleRow.Size = UDim2.new(1, 0, 0, 22)
	titleRow.Parent = header

	local titleLayout = Instance.new("UIListLayout")
	titleLayout.FillDirection = Enum.FillDirection.Horizontal
	titleLayout.VerticalAlignment = Enum.VerticalAlignment.Center
	titleLayout.SortOrder = Enum.SortOrder.LayoutOrder
	titleLayout.Padding = UDim.new(0, 10)
	titleLayout.Parent = titleRow

	local title = text(titleRow, {
		Font = Enum.Font.GothamBold,
		TextSize = 17,
		Text = "Cubes MCP",
		TextColor3 = C.text,
		AutomaticSize = Enum.AutomaticSize.X,
		Size = UDim2.new(0, 0, 1, 0),
		LayoutOrder = 1,
	})

	local statusText = text(titleRow, {
		Font = Enum.Font.GothamMedium,
		TextSize = 13,
		AutomaticSize = Enum.AutomaticSize.X,
		Size = UDim2.new(0, 0, 1, 0),
		LayoutOrder = 2,
		Visible = false,
	})

	local versionLabel = text(header, {
		Font = Enum.Font.Gotham,
		TextSize = 11,
		TextColor3 = C.dim,
		Text = "v" .. Config.VERSION,
		Position = UDim2.fromOffset(0, 24),
		Size = UDim2.new(1, 0, 0, 14),
	})

	-- ---- SCROLL BODY ---------------------------------------------------
	local scroll = Instance.new("ScrollingFrame")
	scroll.BackgroundTransparency = 1
	scroll.BorderSizePixel = 0
	scroll.ScrollBarThickness = 4
	scroll.ScrollBarImageColor3 = C.stroke
	scroll.ScrollBarImageTransparency = 0.3
	scroll.CanvasSize = UDim2.new(0, 0, 0, 0)
	scroll.AutomaticCanvasSize = Enum.AutomaticSize.Y
	-- Frame size grows to fit content (so the footer button hugs the bottom of
	-- the actual content, not the widget edge). A UISizeConstraint caps the
	-- height at the available space; beyond that, the scrollbar takes over.
	scroll.Size = UDim2.new(1, 0, 0, 0)
	scroll.AutomaticSize = Enum.AutomaticSize.Y
	scroll.LayoutOrder = 2
	scroll.Parent = root
	vlist(scroll, 10)
	-- Inset the cards a few px so each section's Border-mode UIStroke has room
	-- to draw — full-width cards had their outline clipped at the scroll edges.
	padding(scroll, 4)

	local scrollMaxConstraint = Instance.new("UISizeConstraint")
	scrollMaxConstraint.MaxSize = Vector2.new(math.huge, 9999)
	scrollMaxConstraint.Parent = scroll

	-- Recompute max height whenever the widget resizes. The slack is:
	-- root padding (16+16) + header (42) + 2 gaps (12+12) + footer (36) = 134.
	-- The footer is the two-button pause/connect row (FOOTER_HEIGHT, 36px).
	local function updateScrollMax()
		local h = widget.AbsoluteSize.Y - 134
		scrollMaxConstraint.MaxSize = Vector2.new(math.huge, math.max(80, h))
	end
	widget:GetPropertyChangedSignal("AbsoluteSize"):Connect(updateScrollMax)
	task.defer(updateScrollMax)

	-- The 3 status rows. No longer a card body item — they live inside the
	-- signal-icon dropdown (built below). Auto-sized on Y so the dropdown can
	-- measure them; 3 rows × 16 + 2 gaps × 4 = 56 when all are present.
	local connectionDetails = Instance.new("Frame")
	connectionDetails.BackgroundTransparency = 1
	connectionDetails.LayoutOrder = 1
	connectionDetails.Size = UDim2.new(1, 0, 0, 0)
	connectionDetails.AutomaticSize = Enum.AutomaticSize.Y
	vlist(connectionDetails, 4)

	-- A check row: bar-icon + label. Both share a state-derived color, and
	-- the connecting state runs a smooth pulse on icon + text in lockstep.
	local checkRows = {}
	local function checkRow(layoutOrder, key)
		local r = row(connectionDetails, layoutOrder, 16)

		local icon = Instance.new("ImageLabel")
		icon.BackgroundTransparency = 1
		icon.BorderSizePixel = 0
		icon.Image = CHECK_ICON
		icon.ImageColor3 = C.offline
		icon.Size = UDim2.fromOffset(12, 12)
		icon.Position = UDim2.new(0, 0, 0.5, -6)
		icon.ScaleType = Enum.ScaleType.Fit
		icon.Parent = r

		local label = text(r, {
			Font = Enum.Font.GothamBold,
			TextSize = 11,
			Text = CHECK_INFO[key].offline,
			TextColor3 = C.offline,
			Position = UDim2.fromOffset(18, 0),
			Size = UDim2.new(1, -18, 0, 16),
		})

		checkRows[key] = {
			label = label,
			icon = icon,
			-- Active tweens are stashed here so we can :Cancel() before
			-- switching state (otherwise an infinite pulse would keep
			-- fighting the new color tween).
			pulseLabel = nil,
			pulseIcon = nil,
			currentState = "offline",
		}
	end

	checkRow(1, "http")
	checkRow(2, "bridge")
	checkRow(3, "commands")

	-- ===== CARD: connection ============================================
	-- A pair of labeled fields (Host, Port). Captions in dim small-caps; values
	-- in a recessed pill matching the rest of the panel's palette. No section
	-- header — the field labels speak for themselves.
	local connCard = card(scroll, 1)
	vlist(connCard, 6)

	-- Tabs row: each tab is a saved port shortcut + a "+" at the end to add more.
	-- The active tab matches Transport.status.port. Removing alt/custom presets;
	-- the list starts with the default port and grows as the user adds.
	local endpointTabs = row(connCard, 1, 22)
	local tabsLayout = Instance.new("UIListLayout")
	tabsLayout.FillDirection = Enum.FillDirection.Horizontal
	tabsLayout.SortOrder = Enum.SortOrder.LayoutOrder
	tabsLayout.VerticalAlignment = Enum.VerticalAlignment.Center
	tabsLayout.Padding = UDim.new(0, 4)
	tabsLayout.Parent = endpointTabs

	-- Saved port list, persisted as plugin setting "endpointPorts". Default is
	-- a single tab matching the default port.
	local savedPorts = { Config.DEFAULT_PORT }
	pcall(function()
		local stored = plugin:GetSetting("endpointPorts")
		if type(stored) == "table" and #stored > 0 then
			local seen, list = {}, {}
			for _, p in ipairs(stored) do
				local n = tonumber(p)
				if n and n >= 1 and n <= 65535 and not seen[n] then
					seen[n] = true
					list[#list + 1] = n
				end
			end
			if #list > 0 then savedPorts = list end
		end
	end)
	local function saveSavedPorts()
		pcall(function() plugin:SetSetting("endpointPorts", savedPorts) end)
	end

	-- Build / rebuild the tab buttons from `savedPorts`. Each tab shows its
	-- port as label, an "×" delete button (only if >1 tab exists), and
	-- toggles the active style based on Transport.status.port. A "+" button
	-- at the end appends a new port (currentMax + 1).
	local rebuildTabs
	rebuildTabs = function()
		for _, child in ipairs(endpointTabs:GetChildren()) do
			if not child:IsA("UIListLayout") then child:Destroy() end
		end

		for i, port in ipairs(savedPorts) do
			local active = Transport.status.port == port
			local tabFrame = Instance.new("Frame")
			tabFrame.BackgroundTransparency = 1
			tabFrame.Size = UDim2.fromOffset(54, 22)
			tabFrame.LayoutOrder = i
			tabFrame.Parent = endpointTabs

			local tab = button(tabFrame, {
				Size = UDim2.new(1, 0, 1, 0),
				Text = tostring(port),
				Font = Enum.Font.Code,
				TextSize = 12,
				TextColor3 = active and C.text or C.dim,
				BackgroundColor3 = active and C.input or C.bg,
				BackgroundTransparency = active and 0 or 0.4,
			})
			rounded(tab, 6)
			stroke(tab, C.stroke, 0.5)
			tab.Activated:Connect(function()
				if Transport.status.port ~= port then
					Transport.setPort(port)
				end
			end)

			-- × delete: only shown when there's more than one tab. Hovering
			-- the tab fades it in; mouse-leave fades it out.
			if #savedPorts > 1 then
				local del = Instance.new("TextButton")
				del.AnchorPoint = Vector2.new(1, 0)
				del.Position = UDim2.new(1, -2, 0, 1)
				del.Size = UDim2.fromOffset(14, 14)
				del.BackgroundTransparency = 1
				del.Font = Enum.Font.GothamBold
				del.TextSize = 12
				del.TextColor3 = C.dim
				del.Text = "×"
				del.TextTransparency = 1
				del.Parent = tabFrame
				tabFrame.MouseEnter:Connect(function()
					TweenService:Create(del, TOGGLE_TWEEN, { TextTransparency = 0 }):Play()
				end)
				tabFrame.MouseLeave:Connect(function()
					TweenService:Create(del, TOGGLE_TWEEN, { TextTransparency = 1 }):Play()
				end)
				del.Activated:Connect(function()
					local newList = {}
					for _, p in ipairs(savedPorts) do
						if p ~= port then newList[#newList + 1] = p end
					end
					if #newList == 0 then return end -- never go to zero tabs
					savedPorts = newList
					saveSavedPorts()
					-- If we deleted the active port, switch to the first remaining one.
					if Transport.status.port == port then
						Transport.setPort(savedPorts[1])
					end
					rebuildTabs()
				end)
			end
		end

		-- "+" button to add a new tab. Adds maxPort+1, wraps if it would overflow.
		local addBtn = button(endpointTabs, {
			Size = UDim2.fromOffset(22, 22),
			LayoutOrder = #savedPorts + 1,
			Text = "+",
			Font = Enum.Font.GothamBold,
			TextSize = 14,
			TextColor3 = C.dim,
			BackgroundColor3 = C.bg,
			BackgroundTransparency = 0.4,
		})
		rounded(addBtn, 6)
		addBtn.Activated:Connect(function()
			local maxPort = 0
			for _, p in ipairs(savedPorts) do
				if p > maxPort then maxPort = p end
			end
			local nextPort = maxPort + 1
			if nextPort > 65535 then nextPort = Config.DEFAULT_PORT end
			savedPorts[#savedPorts + 1] = nextPort
			saveSavedPorts()
			rebuildTabs()
		end)
	end

	-- Endpoint card holds 2 lines (place name, localhost:port). Inner:
	-- 24 + 20 + 1×4 gap = 48. Plus 14+14 vertical padding wouldn't fit, so
	-- the field padding below is trimmed to 10 top/bottom: 48 + 20 = 68.
	local endpointRow = row(connCard, 2, 68)

	-- Endpoint card: a 2-line composite styled after Rojo's project card.
	--   Top line:    the place / project name (bold, the dominant element)
	--   Bottom line: "localhost:<port>" — port is its own dark pill (clearly editable)
	-- The host is locked because the bridge binds 127.0.0.1 only (see bridge.ts)
	-- — exposing it beyond loopback would let anything on the LAN run arbitrary
	-- Luau in Studio.
	local endpointField = Instance.new("Frame")
	endpointField.BackgroundColor3 = C.bg
	endpointField.BorderSizePixel = 0
	-- Slight 1px inset so the focus stroke isn't clipped by the body's
	-- ClipsDescendants (see attachCollapse).
	endpointField.Position = UDim2.fromOffset(1, 0)
	endpointField.Size = UDim2.new(1, -2, 1, 0)
	endpointField.Parent = endpointRow
	rounded(endpointField, 8)
	-- 10 top/bottom (was 14) so the two now-larger lines fill the ~68px card
	-- without dead space: 10 + 24 + 4 gap + 20 + 10 = 68.
	padding(endpointField, 0, { top = 10, bottom = 10, left = 14, right = 14 })
	-- Matches the status dropdown's surface: a C.stroke border at rest.
	-- Contextual mode draws inside the bounds so it won't get clipped; the
	-- focus handler brightens it while the port field is focused.
	local endpointStroke = Instance.new("UIStroke")
	endpointStroke.Color = C.stroke
	endpointStroke.Thickness = 1
	endpointStroke.Transparency = 0.5
	endpointStroke.ApplyStrokeMode = Enum.ApplyStrokeMode.Contextual
	endpointStroke.Parent = endpointField

	-- Vertical stack: top line (place name) → bottom line (localhost: + port
	-- pill). The horizontal UIListLayout inside the bottom line auto-packs the
	-- prefix and pill flush instead of pinning the pill to the field's edge.
	local fieldLayout = Instance.new("UIListLayout")
	fieldLayout.FillDirection = Enum.FillDirection.Vertical
	fieldLayout.VerticalAlignment = Enum.VerticalAlignment.Center
	fieldLayout.SortOrder = Enum.SortOrder.LayoutOrder
	fieldLayout.Padding = UDim.new(0, 2)
	fieldLayout.Parent = endpointField

	-- Top line: the place name (bold), the card's dominant element. The
	-- activity badge that used to sit here now lives in the Status card.
	local topLine = Instance.new("Frame")
	topLine.BackgroundTransparency = 1
	topLine.Size = UDim2.new(1, 0, 0, 24)
	topLine.LayoutOrder = 1
	topLine.Parent = endpointField

	local topLayout = Instance.new("UIListLayout")
	topLayout.FillDirection = Enum.FillDirection.Horizontal
	topLayout.SortOrder = Enum.SortOrder.LayoutOrder
	topLayout.VerticalAlignment = Enum.VerticalAlignment.Center
	topLayout.Padding = UDim.new(0, 6)
	topLayout.Parent = topLine

	local placeLabel = text(topLine, {
		Font = Enum.Font.GothamBold,
		TextSize = 15,
		TextColor3 = C.text,
		Text = "—",
		Size = UDim2.new(1, 0, 1, 0),
		LayoutOrder = 1,
	})

	-- Bottom line: locked "localhost:" prefix + editable port pill.
	local bottomLine = Instance.new("Frame")
	bottomLine.BackgroundTransparency = 1
	bottomLine.Size = UDim2.new(1, 0, 0, 20)
	bottomLine.LayoutOrder = 2
	bottomLine.Parent = endpointField

	local bottomLayout = Instance.new("UIListLayout")
	bottomLayout.FillDirection = Enum.FillDirection.Horizontal
	bottomLayout.SortOrder = Enum.SortOrder.LayoutOrder
	bottomLayout.VerticalAlignment = Enum.VerticalAlignment.Center
	bottomLayout.Padding = UDim.new(0, 0)
	bottomLayout.Parent = bottomLine

	local hostPrefix = text(bottomLine, {
		Font = Enum.Font.Code,
		TextSize = 15,
		TextColor3 = C.dim,
		Text = Config.HOST_NAME .. ":",
		AutomaticSize = Enum.AutomaticSize.X,
		Size = UDim2.new(0, 0, 1, 0),
		LayoutOrder = 1,
	})

	-- Port pill: monospace Code font, sized just enough for the 5-digit cap
	-- of a TCP port (16-bit max = 65535). 52px = ~9px/glyph × 5 + small pad.
	-- Background is darker than the C.bg card so it reads as a recessed well.
	local portInput = Instance.new("TextBox")
	portInput.BackgroundColor3 = Color3.fromRGB(14, 15, 19)
	portInput.BorderSizePixel = 0
	portInput.ClearTextOnFocus = false
	portInput.Font = Enum.Font.Code
	portInput.PlaceholderColor3 = C.dim
	portInput.PlaceholderText = "44820"
	portInput.Size = UDim2.fromOffset(52, 20)
	portInput.TextColor3 = C.text
	portInput.TextSize = 15
	portInput.TextXAlignment = Enum.TextXAlignment.Center
	portInput.LayoutOrder = 2
	portInput.Parent = bottomLine
	rounded(portInput, 4)

	-- port warning (only visible when port != default)
	local portWarning = text(connCard, {
		LayoutOrder = 3,
		Size = UDim2.new(1, 0, 0, 18),
		TextWrapped = true,
		TextTruncate = Enum.TextTruncate.None,
		TextColor3 = C.yellow,
		TextSize = 11,
		Font = Enum.Font.Gotham,
		Visible = false,
	})

	-- ---- status dropdown -----------------------------------------------
	-- The 3 status rows (HTTP / MCP / Commands) live in a click-triggered
	-- dropdown behind the signal icon. It is built BEFORE attachCollapse so it
	-- can be passed in as the last card body item: that makes the dropdown a
	-- child of the collapse `body`, not a loose sibling of it.
	--
	-- Why this matters — the whole point of the restructure:
	--   * One owner of the collapse region. Collapsing the card collapses the
	--     dropdown for free (it is inside `body`), so there is never a dropdown
	--     dangling under a collapsed card and no second hand-rolled state
	--     machine racing attachCollapse's tween on the card's layout.
	--   * The dropdown's own open/close is animated by attachCollapse's single
	--     body size-tween (driven via setConnItemVisible) — the card grows /
	--     shrinks and its ClipsDescendants reveals / hides the dropdown. The
	--     dropdown never runs a competing size-tween; the only thing it tweens
	--     itself is GroupTransparency, which does not touch layout, so it
	--     cannot race anything.
	--
	-- CanvasGroup, same reasoning as attachCollapse's body: GroupTransparency
	-- is a continuous 0-1 float, so the content fade has no pixel rounding.
	local statusDropdown = Instance.new("CanvasGroup")
	statusDropdown.BackgroundColor3 = C.bg
	-- Opaque fill: the CanvasGroup's GroupTransparency does the open/close fade,
	-- so the C.bg surface must be solid here (matches the endpoint container).
	statusDropdown.BackgroundTransparency = 0
	statusDropdown.BorderSizePixel = 0
	statusDropdown.ClipsDescendants = true
	-- CanvasResolutionFidelity left at default (Automatic) — native-resolution
	-- texture for a group sized 1:1 with the screen, so the rows stay crisp.
	statusDropdown.GroupTransparency = 1
	statusDropdown.LayoutOrder = 4
	-- 1px horizontal inset so the Border-mode UIStroke draws inside `body` and
	-- isn't clipped by body.ClipsDescendants (same trick as endpointField).
	statusDropdown.Position = UDim2.fromOffset(1, 0)
	statusDropdown.Size = UDim2.new(1, -2, 0, 0)
	statusDropdown.Visible = false
	rounded(statusDropdown, 8)
	local statusDropdownStroke = stroke(statusDropdown, C.stroke, 1)
	local dropdownPad = padding(statusDropdown, 0, { top = 6, bottom = 6, left = 12, right = 12 })

	connectionDetails.Parent = statusDropdown

	-- Open height = the check rows' deterministic height + the dropdown's
	-- padding. Measured from the rows' own fixed Size.Y.Offset (+ the 4px
	-- connectionDetails gaps), NOT AbsoluteSize: the dropdown spends its whole
	-- life Visible=false until first opened, so a Visible=false subtree never
	-- gets a layout pass and AbsoluteSize would still read (0,0) on the frame
	-- the dropdown first opens. The deterministic sum is correct synchronously.
	local detailsGap = 4
	local function dropdownOpenHeight()
		local rowsH, visibleRows = 0, 0
		for _, child in ipairs(connectionDetails:GetChildren()) do
			if child:IsA("GuiObject") and child.Visible then
				rowsH += child.AbsoluteSize.Y > 0 and child.AbsoluteSize.Y
					or child.Size.Y.Offset
				visibleRows += 1
			end
		end
		if visibleRows > 1 then
			rowsH += detailsGap * (visibleRows - 1)
		end
		return rowsH + dropdownPad.PaddingTop.Offset + dropdownPad.PaddingBottom.Offset
	end

	-- setDropdownOpen is defined further down (it needs setConnItemVisible,
	-- which attachCollapse returns) — forward-declared here so the onToggle
	-- closure passed into attachCollapse can reference it. The closure only
	-- runs on a user click, long after the assignment, so the forward ref is
	-- safe.
	local dropdownOpen = false
	local setDropdownOpen

	-- The status rows live INSIDE the collapse body as the last body item, so
	-- attachCollapse owns the only size-tween that touches connCard's layout.
	-- setConnItemVisible is the one supported way to show / hide the dropdown:
	-- it updates attachCollapse's intent table and re-fits the card through
	-- that same single body tween.
	--
	-- onToggle closes the dropdown only when the card is COLLAPSING. It must
	-- not close on expand: if the dropdown was opened while the card was
	-- collapsed, expanding should bring the card back WITH the dropdown open,
	-- in one body tween — closing it on expand would shrink-snap the card at
	-- the end of the maximize animation.
	local _, connectionTitle, enforceConnectionCollapse, resizeConnectionCard, setConnItemVisible =
		attachCollapse(connCard, "Connection", {
			endpointTabs,
			endpointRow,
			portWarning,
			statusDropdown,
		}, true, function(expanded)
			if not expanded then
				setDropdownOpen(false)
			end
		end)
	connectionTitle.TextSize = 17

	-- setDropdownOpen(open): flip the dropdown's open state.
	--   * Opening: give the dropdown its full laid-out height up front, then
	--     ask attachCollapse (setConnItemVisible) to grow the card body — the
	--     body's ClipsDescendants reveals the dropdown as the body reaches it.
	--   * Closing: leave the dropdown at full size and let the shrinking body
	--     clip it away from the bottom (it reads as the rows sliding up out of
	--     view); attachCollapse hides it once the body tween lands.
	--   * GroupTransparency + the stroke are faded over COLLAPSE_TWEEN. Those
	--     are layout-free tweens, so they cannot race the body size-tween.
	-- There is exactly ONE size-tweening machine (attachCollapse's). The
	-- dropdown never runs a competing size-tween, so no open/collapse/expand
	-- ordering can corrupt the layout.
	function setDropdownOpen(open)
		if dropdownOpen == open then
			return
		end
		dropdownOpen = open

		-- Opening: lay the dropdown out at full height before the body grows
		-- so the reveal slides over fully-formed rows. Closing leaves the size
		-- untouched so the body's shrink clips the rows away cleanly.
		if open then
			statusDropdown.Size = UDim2.new(1, -2, 0, dropdownOpenHeight())
		end

		-- Layout-free fades, riding COLLAPSE_TWEEN alongside the body tween.
		TweenService:Create(statusDropdown, COLLAPSE_TWEEN, {
			GroupTransparency = open and 0 or 1,
		}):Play()
		TweenService:Create(statusDropdownStroke, COLLAPSE_TWEEN, {
			Transparency = open and 0.5 or 1,
		}):Play()

		-- The single source of truth for the card layout. While the card is
		-- collapsed or mid-collapse this just records intent; the next expand
		-- picks it up. While the card is expanded + idle it grows / shrinks the
		-- body through attachCollapse's one body tween.
		setConnItemVisible(statusDropdown, open)
	end

	-- Keep the dropdown sized to its content while open (rows could hide/show
	-- in future). Re-snaps statusDropdown's height and asks attachCollapse to
	-- re-fit the card body. resizeConnectionCard() is itself a no-op while the
	-- collapse tween runs, so this can never snap a size mid-collapse.
	connectionDetails:GetPropertyChangedSignal("AbsoluteSize"):Connect(function()
		if dropdownOpen then
			statusDropdown.Size = UDim2.new(1, -2, 0, dropdownOpenHeight())
			resizeConnectionCard()
		end
	end)

	-- ---- signal icon ---------------------------------------------------
	-- The icon sits immediately right of the "Connection" title; clicking it
	-- toggles the dropdown. It is a separate button parented to the title's
	-- header row, so its click does NOT bubble to the card-collapse toggle.
	local connectionHeader = connectionTitle.Parent

	-- Shrink the title's claimed width to leave room for the icon, then place
	-- the icon flush after the measured text so it hugs the word "Connection".
	connectionTitle.Size = UDim2.new(1, -64, 1, 0)
	local sigIcon, setSignalBars = signalIcon(connectionHeader)
	sigIcon.AnchorPoint = Vector2.new(0, 0.5)
	sigIcon.Position = UDim2.new(0, 0, 0.5, 0)
	local function placeSignalIcon()
		local titleSize = TextService:GetTextSize(
			connectionTitle.Text,
			connectionTitle.TextSize,
			connectionTitle.Font,
			Vector2.new(connectionTitle.AbsoluteSize.X, math.huge)
		)
		-- 4px gap after the text; clamp so it never overlaps the +/- toggle.
		local x = math.min(titleSize.X + 4, connectionTitle.AbsoluteSize.X)
		sigIcon.Position = UDim2.new(0, x, 0.5, 0)
	end
	connectionTitle:GetPropertyChangedSignal("AbsoluteSize"):Connect(placeSignalIcon)
	task.defer(placeSignalIcon)

	-- Icon rest/hover state: subtle at rest, brightens on hover.
	local iconHovered = false
	local function refreshIconTint()
		-- Rest: transparent, blends into the card. Hover: a solid C.field plate
		-- (the endpoint card's color) fades in behind the bars as a highlight.
		TweenService:Create(sigIcon, TOGGLE_TWEEN, {
			BackgroundTransparency = iconHovered and 0 or 1,
		}):Play()
	end
	sigIcon.MouseEnter:Connect(function()
		iconHovered = true
		refreshIconTint()
	end)
	sigIcon.MouseLeave:Connect(function()
		iconHovered = false
		refreshIconTint()
	end)
	-- Click toggles ONLY the dropdown. Activated does not propagate to the
	-- card-collapse toggle (a different button). Collapsing the whole card
	-- closes the dropdown via attachCollapse's onToggle callback (above), so
	-- there is no separate wiring on the collapse toggle here.
	sigIcon.Activated:Connect(function()
		setDropdownOpen(not dropdownOpen)
	end)

	-- Drive the signal bars from the same state the check rows use: count how
	-- many of http/bridge/commands are "online", tint by the connection mode.
	local function updateSignalIcon()
		local mode = Transport.status.mode
		local states = MODE_TO_STATES[mode] or MODE_TO_STATES.off
		local lit = 0
		for _, state in pairs(states) do
			if state == "online" then lit += 1 end
		end
		local modeInfo = MODE_INFO[mode] or MODE_INFO.off
		local color = modeInfo.color
		if mode == "connecting" then
			-- Mid-connect: show one probing bar so the icon isn't dead-empty.
			setSignalBars(1, color)
		else
			-- 3 states map onto 4 bars: 0→0, 1→2, 2→3, 3→4 so a healthy
			-- connection lights the icon fully.
			local barsLit = lit == 0 and 0 or (lit + 1)
			setSignalBars(barsLit, color)
		end
	end

	-- ===== CARD: stats =================================================
	-- (sectionHeader call removed — the attachCollapse below renders its own
	-- title row, the redundant header was always immediately hidden.)
	-- The body is a 2-column grid of stat tiles — a small dashboard rather
	-- than a label/value list. Each tile is a recessed rounded card holding a
	-- color-coded accent mark, the value (big + bold), and a dim label.
	local statsCard = card(scroll, 2)
	vlist(statsCard, 7)

	-- statGrid: the tile container. A UIGridLayout with a 0.5-scale cell width
	-- (minus half the inter-tile gap) keeps two even, responsive columns as the
	-- panel resizes; CellSize.Y is fixed so a fixed-height tile is enough.
	-- AutomaticSize.Y lets the grid report its real laid-out height, which is
	-- exactly what attachCollapse's computeBodyHeight() reads via AbsoluteSize.
	local STAT_TILE_GAP = 8
	local STAT_TILE_HEIGHT = 78
	local statGrid = Instance.new("Frame")
	statGrid.BackgroundTransparency = 1
	statGrid.BorderSizePixel = 0
	statGrid.Size = UDim2.fromScale(1, 0)
	statGrid.AutomaticSize = Enum.AutomaticSize.Y
	statGrid.LayoutOrder = 1
	statGrid.Parent = statsCard

	local statGridLayout = Instance.new("UIGridLayout")
	statGridLayout.FillDirection = Enum.FillDirection.Horizontal
	statGridLayout.SortOrder = Enum.SortOrder.LayoutOrder
	statGridLayout.HorizontalAlignment = Enum.HorizontalAlignment.Left
	statGridLayout.CellPadding = UDim2.fromOffset(STAT_TILE_GAP, STAT_TILE_GAP)
	-- Half the gap is subtracted from each cell so two cells + one gap == 100%.
	statGridLayout.CellSize = UDim2.new(0.5, -STAT_TILE_GAP / 2, 0, STAT_TILE_HEIGHT)
	statGridLayout.Parent = statGrid

	-- statTile(layoutOrder, labelText): a recessed rounded tile — a big bold
	-- value (the focal point) over a small dim caption. Returns the value label.
	local function statTile(layoutOrder, labelText)
		local tile = Instance.new("Frame")
		tile.BackgroundColor3 = C.bg
		tile.BorderSizePixel = 0
		tile.Size = UDim2.fromOffset(0, STAT_TILE_HEIGHT)
		tile.LayoutOrder = layoutOrder
		tile.Parent = statGrid
		rounded(tile, 9)
		stroke(tile, C.stroke, 0.5)
		padding(tile, 9)

		-- Value + caption, centred as a group.
		local stack = Instance.new("UIListLayout")
		stack.FillDirection = Enum.FillDirection.Vertical
		stack.SortOrder = Enum.SortOrder.LayoutOrder
		stack.HorizontalAlignment = Enum.HorizontalAlignment.Center
		stack.VerticalAlignment = Enum.VerticalAlignment.Center
		stack.Padding = UDim.new(0, 3)
		stack.Parent = tile

		-- Value: the focal point — big, bold, centred.
		local val = text(tile, {
			LayoutOrder = 1,
			Size = UDim2.new(1, 0, 0, 24),
			AutomaticSize = Enum.AutomaticSize.None,
			Font = Enum.Font.GothamBold,
			TextSize = 20,
			TextColor3 = C.text,
			TextXAlignment = Enum.TextXAlignment.Center,
			Text = "—",
		})

		-- Caption: small + dim, supports the value.
		text(tile, {
			LayoutOrder = 2,
			Size = UDim2.new(1, 0, 0, 13),
			Font = Enum.Font.Gotham,
			TextSize = 11,
			TextColor3 = C.dim,
			TextXAlignment = Enum.TextXAlignment.Center,
			Text = labelText,
		})

		return val
	end

	-- Activity tile: the studio-activity indicator (Idle / Building / Playtest /
	-- etc.) — the value text and its color/pulse are driven by setModeBadge.
	local activityVal = statTile(1, "Activity")
	activityVal.Text = "Idle"

	local uptimeVal = statTile(2, "Uptime")
	local handledVal = statTile(3, "Commands")
	local errorsVal = statTile(4, "Errors")
	local lastCmdVal = statTile(5, "Last command")
	local lastContactVal = statTile(6, "Last contact")

	local errorBanner = text(statsCard, {
		LayoutOrder = 7,
		Size = UDim2.new(1, 0, 0, 30),
		TextWrapped = true,
		TextTruncate = Enum.TextTruncate.None,
		TextSize = 11,
		Font = Enum.Font.Gotham,
		Visible = false,
	})
	-- attachCollapse body items: the tile grid (one auto-sizing item) followed
	-- by the conditional errorBanner. computeBodyHeight() reads statGrid's live
	-- AbsoluteSize, so collapse/expand always matches the real grid height.
	-- setStatsItemVisible: errorBanner is conditionally shown by render(); its
	-- visibility goes through this so attachCollapse keeps the card height (and
	-- the intent table) correct — same model as the Connection card's items.
	local _, statusTitle, enforceStatsCollapse, _, setStatsItemVisible = attachCollapse(statsCard, "Status", {
		statGrid,
		errorBanner,
	}, true)

	-- ---- status header icon --------------------------------------------
	-- A white glyph sitting just right of the "Status" title. Sized to fit the
	-- 24px header exactly so there's no overflow onto the tile grid below.
	statusTitle.Size = UDim2.new(1, -64, 1, 0)
	local statusIcon = Instance.new("ImageLabel")
	statusIcon.AnchorPoint = Vector2.new(0, 0.5)
	statusIcon.Position = UDim2.new(0, 0, 0.5, 0)
	statusIcon.Size = UDim2.fromOffset(24, 24)
	statusIcon.BackgroundTransparency = 1
	statusIcon.Image = "rbxassetid://70539759120919"
	statusIcon.ImageColor3 = Color3.new(1, 1, 1)
	statusIcon.ScaleType = Enum.ScaleType.Fit
	statusIcon.Parent = statusTitle.Parent
	local function placeStatusIcon()
		local titleSize = TextService:GetTextSize(
			statusTitle.Text,
			statusTitle.TextSize,
			statusTitle.Font,
			Vector2.new(statusTitle.AbsoluteSize.X, math.huge)
		)
		-- 4px gap after the measured text; clamp inside the title's width.
		local x = math.min(titleSize.X + 4, statusTitle.AbsoluteSize.X)
		statusIcon.Position = UDim2.new(0, x, 0.5, 0)
	end
	statusTitle:GetPropertyChangedSignal("AbsoluteSize"):Connect(placeStatusIcon)
	task.defer(placeStatusIcon)

	-- ===== CARD: toggles ===============================================
	-- (sectionHeader call removed — attachCollapse renders its own title.)
	local togglesCard = card(scroll, 3)
	vlist(togglesCard, 8)

	local function toggleRow(layoutOrder, labelText)
		local r = row(togglesCard, layoutOrder, 28)
		text(r, {
			Size = UDim2.new(1, -78, 1, 0),
			Font = Enum.Font.GothamMedium,
			TextColor3 = C.text,
			Text = labelText,
		})
		local btn = button(r, {
			Position = UDim2.new(1, -72, 0, 0),
			Size = UDim2.new(0, 72, 1, 0),
			Font = Enum.Font.GothamBold,
			TextSize = 12,
		})
		return btn
	end

	-- Activity bar: the island at the top centre of the viewport that shows what
	-- Claude is doing (HudOverlay). On by default; the choice is persisted.
	local visualDebugToggle = toggleRow(2, "Activity bar")

	local visualDebugOn = true
	pcall(function()
		local saved = plugin:GetSetting("activityBar")
		if type(saved) == "boolean" then visualDebugOn = saved end
	end)

	local function paintVisualDebug()
		visualDebugToggle.Text = visualDebugOn and "ON" or "OFF"
		visualDebugToggle.BackgroundColor3 = visualDebugOn and C.green or C.cardAlt
		visualDebugToggle.TextColor3 = visualDebugOn and C.text or C.dim
	end

	local function setVisualDebug(on)
		visualDebugOn = on and true or false
		HudOverlay.setVisible(visualDebugOn)
		pcall(function() plugin:SetSetting("activityBar", visualDebugOn) end)
		paintVisualDebug()
	end

	-- Sync the HUD + button visuals to the restored state.
	HudOverlay.setVisible(visualDebugOn)
	paintVisualDebug()

	-- Allow writes: the server refuses every write-class command while this is
	-- OFF. State lives in Transport (persisted there).
	local writesToggle = toggleRow(1, "Allow writes")
	local function paintWrites()
		local on = Transport.status.writeEnabled
		writesToggle.Text = on and "ON" or "OFF"
		writesToggle.BackgroundColor3 = on and C.green or C.cardAlt
		writesToggle.TextColor3 = on and C.text or C.dim
	end
	paintWrites()

	-- Bridge token: the server's ~/.cubesmcp/token. Shown masked; focusing the
	-- box clears it so a paste replaces the whole value.
	local tokenRow = row(togglesCard, 3, 28)
	text(tokenRow, {
		Size = UDim2.new(1, -156, 1, 0),
		Font = Enum.Font.GothamMedium,
		TextColor3 = C.text,
		Text = "Bridge token",
	})
	local tokenInput = Instance.new("TextBox")
	tokenInput.BackgroundColor3 = Color3.fromRGB(14, 15, 19)
	tokenInput.BorderSizePixel = 0
	tokenInput.ClearTextOnFocus = true
	tokenInput.Font = Enum.Font.Code
	tokenInput.PlaceholderColor3 = C.dim
	tokenInput.PlaceholderText = "paste token"
	tokenInput.Position = UDim2.new(1, -150, 0, 0)
	tokenInput.Size = UDim2.new(0, 150, 1, 0)
	tokenInput.TextColor3 = C.text
	tokenInput.TextSize = 12
	tokenInput.TextTruncate = Enum.TextTruncate.AtEnd
	tokenInput.Parent = tokenRow
	rounded(tokenInput, 6)
	local tokenFocused = false
	local function paintToken()
		if tokenFocused then return end
		local tok = Transport.status.token
		tokenInput.Text = tok ~= "" and ("••••" .. tok:sub(-4)) or ""
	end
	paintToken()
	tokenInput.Focused:Connect(function()
		tokenFocused = true
	end)
	tokenInput.FocusLost:Connect(function()
		tokenFocused = false
		local entered = tokenInput.Text
		if entered ~= "" and not entered:find("••••", 1, true) then
			Transport.setToken(entered)
		end
		paintToken()
	end)

	local _, _, enforceTogglesCollapse = attachCollapse(togglesCard, "Controls", {
		writesToggle.Parent,
		visualDebugToggle.Parent,
		tokenRow,
	}, true)

	-- ---- FOOTER: pause + connect/disconnect ----------------------------
	-- A clean two-button row, Rojo-plugin style: a dark secondary button
	-- (Pause / Resume) on the left, the red/accent primary button
	-- (Connect / Disconnect) on the right, with a small gap between.
	local FOOTER_HEIGHT = 36
	local footer = Instance.new("Frame")
	footer.BackgroundTransparency = 1
	footer.Size = UDim2.new(1, 0, 0, FOOTER_HEIGHT)
	footer.LayoutOrder = 99
	footer.Parent = root

	-- Horizontal flex: the two buttons each take an equal share of the row,
	-- separated by an 8px gap. UIFlexItem (Fill) on each gives the even split
	-- without hard-coding widths against the panel's variable width.
	local footerLayout = Instance.new("UIListLayout")
	footerLayout.FillDirection = Enum.FillDirection.Horizontal
	footerLayout.SortOrder = Enum.SortOrder.LayoutOrder
	footerLayout.VerticalAlignment = Enum.VerticalAlignment.Center
	footerLayout.Padding = UDim.new(0, 8)
	footerLayout.Parent = footer

	-- footerButton: the shared polished style for both footer buttons —
	-- GothamBold, full footer height, crisp 8px corners, snug padding. The
	-- caller supplies LayoutOrder and the color/text via render().
	local function footerButton(layoutOrder)
		local b = Instance.new("TextButton")
		b.Font = Enum.Font.GothamBold
		b.TextSize = 14
		b.AutoButtonColor = true
		b.BorderSizePixel = 0
		b.TextColor3 = C.text
		b.BackgroundColor3 = C.cardAlt
		b.Size = UDim2.new(0, 0, 1, 0)
		b.LayoutOrder = layoutOrder
		b.Parent = footer
		rounded(b, 8)
		local pad = Instance.new("UIPadding")
		pad.PaddingLeft = UDim.new(0, 12)
		pad.PaddingRight = UDim.new(0, 12)
		pad.Parent = b
		-- Even split: each button fills an equal share of the footer row.
		local flex = Instance.new("UIFlexItem")
		flex.FlexMode = Enum.UIFlexMode.Fill
		flex.Parent = b
		return b
	end

	-- Pause (left): dark secondary button. Toggles Transport.setPaused;
	-- render() swaps the label (Pause / Paused) and color per status.paused.
	local pauseButton = footerButton(1)
	pauseButton.Text = "Pause"

	-- Connect / Disconnect (right): the primary action, accent or red.
	local connectButton = footerButton(2)

	-- ---- render --------------------------------------------------------
	local lastEndpointText = nil
	local endpointFocused = false
	portInput.Focused:Connect(function()
		endpointFocused = true
		-- Brighten the C.stroke border while the port field is focused.
		TweenService:Create(endpointStroke, TOGGLE_TWEEN, { Transparency = 0.2 }):Play()
	end)
	portInput.FocusLost:Connect(function()
		endpointFocused = false
		TweenService:Create(endpointStroke, TOGGLE_TWEEN, { Transparency = 0.5 }):Play()
	end)

	-- Initial tab render. The render() loop will keep these in sync after this.
	rebuildTabs()

	-- ---- check-row state machine ---------------------------------------
	-- Pulse only on "connecting": label + icon ease between full and ~30%
	-- intensity, looping forever (Reverses=true, RepeatCount=-1) until we
	-- :Cancel() and tween to a static color for the next state.
	local STATE_COLOR = {
		offline = C.offline,
		connecting = C.yellow,
		online = C.green,
		error = C.red,
	}
	local PULSE_INFO = TweenInfo.new(
		0.9,
		Enum.EasingStyle.Sine,
		Enum.EasingDirection.InOut,
		-1, -- infinite
		true -- reverses
	)
	local function dim(color, scale)
		return Color3.new(color.R * scale, color.G * scale, color.B * scale)
	end

	local function cancelPulse(row)
		if row.pulseLabel then row.pulseLabel:Cancel() ; row.pulseLabel = nil end
		if row.pulseIcon then row.pulseIcon:Cancel() ; row.pulseIcon = nil end
	end

	local function setRowState(row, key, state)
		if row.currentState == state then return end
		row.currentState = state
		cancelPulse(row)
		local color = STATE_COLOR[state] or C.offline
		row.label.Text = CHECK_INFO[key][state] or CHECK_INFO[key].offline
		if state == "connecting" then
			-- Start bright; tween toward a dimmed version, infinite reverse.
			-- Icon + label color-code together and pulse in lockstep.
			row.label.TextColor3 = color
			row.icon.ImageColor3 = color
			local dark = dim(color, 0.35)
			row.pulseLabel = TweenService:Create(row.label, PULSE_INFO, { TextColor3 = dark })
			row.pulseIcon = TweenService:Create(row.icon, PULSE_INFO, { ImageColor3 = dark })
			row.pulseLabel:Play()
			row.pulseIcon:Play()
		else
			-- Smooth transition to the static color.
			TweenService:Create(row.label, TOGGLE_TWEEN, { TextColor3 = color }):Play()
			TweenService:Create(row.icon, TOGGLE_TWEEN, { ImageColor3 = color }):Play()
		end
	end

	local function applyCheckRowStates(mode)
		local states = MODE_TO_STATES[mode] or MODE_TO_STATES.off
		setRowState(checkRows.http, "http", states.http)
		setRowState(checkRows.bridge, "bridge", states.bridge)
		setRowState(checkRows.commands, "commands", states.commands)
	end

	-- ---- activity detection ---------------------------------------------
	-- The label itself comes from Transport (status.lastActivity), which sees
	-- the MCP tool the agent called rather than the low-level command. This
	-- only decides colour, pulse and when to fall back to Idle / Playtest.

	-- Activity badge color story (matching the user's mental model):
	--   Inactive (not polling)        → grey, static
	--   Idle (no recent activity)     → yellow, static
	--   Active (recent settled)       → green, static — brief afterglow
	--   Doing X (running / just ran)  → green, pulsing
	--   Playtest (Studio in playmode) → yellow, pulsing, whenever the agent is
	--                                    not in the middle of something else
	-- Times tuned to read crisp: the badge pulses while a command burst is
	-- ongoing, settles for a second, then returns to Idle quickly so a
	-- one-off action doesn't leave it permanently stuck on "Building".
	local DOING_WINDOW = 2 -- pulse for N seconds after the last command
	local IDLE_AFTER_LOCAL = 4 -- total seconds of "doing X" display, then Idle

	local function detectActivity(status)
		local RunService = game:GetService("RunService")
		if not status.polling or status.mode == "off" then
			return "Inactive", C.dim, false
		end
		-- Transient connection states mirror the check-row pulse styling so
		-- they feel like one coherent state, not two unrelated indicators.
		if status.mode == "connecting" then
			return "Connecting", C.yellow, true
		end
		local label = status.lastActivity or "Active"
		if status.busy then
			return label, C.green, true
		end
		local age = (status.lastCommandAt and status.lastCommandAt > 0) and (os.clock() - status.lastCommandAt) or math.huge
		if age <= IDLE_AFTER_LOCAL then
			-- Pulse only during the DOING_WINDOW immediately after the call; settle
			-- to a static green afterward so the eye isn't constantly drawn there.
			return label, C.green, age < DOING_WINDOW
		end
		if RunService:IsRunning() then
			return "Playtest", C.yellow, true
		end
		return "Idle", C.yellow, false
	end

	-- Activity-tile state machine: cancels the previous tween before starting
	-- the next one so the infinite pulse can't fight a static color
	-- transition. Drives the "Activity" tile in the Status card (the badge
	-- that used to live on the endpoint card's top line). The value text stays
	-- C.text for legibility; the color coding / pulse lives on the tile accent.
	local modePulseTween = nil
	local modeLastKey = nil
	local function setModeBadge(label, color, pulse)
		local key = label .. (pulse and "!" or "")
		if key == modeLastKey then return end
		modeLastKey = key
		if modePulseTween then modePulseTween:Cancel() ; modePulseTween = nil end
		activityVal.Text = label
		if pulse then
			-- Pulse the value text between full color and a dimmed version.
			TweenService:Create(activityVal, TOGGLE_TWEEN, { TextColor3 = color }):Play()
			local dark = Color3.new(color.R * 0.35, color.G * 0.35, color.B * 0.35)
			modePulseTween = TweenService:Create(activityVal, PULSE_INFO, { TextColor3 = dark })
			modePulseTween:Play()
		else
			TweenService:Create(activityVal, TOGGLE_TWEEN, { TextColor3 = color }):Play()
		end
	end

	local function render()
		local status = Transport.status
		local info = MODE_INFO[status.mode] or MODE_INFO.off

		if status.mode == "connecting" and not widget.Enabled then
			widget.Enabled = true
		end
		-- header status text (no dot — color carries the state)
		statusText.Text = info.label
		statusText.TextColor3 = info.color

		applyCheckRowStates(status.mode)
		updateSignalIcon()

		local portText = tostring(status.port)
		if not endpointFocused and portText ~= lastEndpointText then
			portInput.Text = portText
			lastEndpointText = portText
		end
		-- Place name (the .rbxl filename) fills the endpoint card's top line.
		local placeName = game.Name
		if placeName == nil or placeName == "" then placeName = "Untitled Place" end
		placeLabel.Text = placeName

		-- Activity is derived from RunService state + the most recent tool
		-- call: playtest takes priority, otherwise we map the last tool name
		-- to a category, falling back to "Idle" when nothing recent and
		-- "Active" for unknown tools. setModeBadge writes the Activity row in
		-- the Status card.
		local activity, activityColor, shouldPulse = detectActivity(status)
		setModeBadge(activity, activityColor, shouldPulse)

		-- Ensure the active port is represented as a tab (auto-create on
		-- port changes so the row always shows where we are), then refresh
		-- highlights without rebuilding if the set is unchanged.
		local present = false
		for _, p in ipairs(savedPorts) do
			if p == status.port then present = true break end
		end
		if not present then
			savedPorts[#savedPorts + 1] = status.port
			saveSavedPorts()
			rebuildTabs()
		else
			-- Just re-tween active styles.
			for _, tabFrame in ipairs(endpointTabs:GetChildren()) do
				if tabFrame:IsA("Frame") then
					local btn = tabFrame:FindFirstChildOfClass("TextButton")
					if btn then
						local port = tonumber(btn.Text)
						local active = port == status.port
						TweenService:Create(btn, TOGGLE_TWEEN, {
							BackgroundColor3 = active and C.input or C.bg,
							BackgroundTransparency = active and 0 or 0.4,
							TextColor3 = active and C.text or C.dim,
						}):Play()
					end
				end
			end
		end
		-- portWarning visibility goes through setConnItemVisible, not a raw
		-- .Visible write: attachCollapse owns body-item visibility, and routing
		-- it here keeps the card height correct (and re-fits it through the one
		-- body tween). setConnItemVisible is a no-op when the value is
		-- unchanged, so calling it every render tick is cheap.
		local portIsCustom = status.port ~= 44820
		if portIsCustom then
			portWarning.Text = "Server must use CUBES_MCP_PORT=" .. status.port
		end
		setConnItemVisible(portWarning, portIsCustom)

		-- stats
		if status.connectedAt > 0 then
			uptimeVal.Text = duration(os.clock() - status.connectedAt)
		else
			uptimeVal.Text = "N/A"
		end
		handledVal.Text = tostring(status.commandsHandled)
		errorsVal.Text = tostring(status.errorCount)
		-- The tile is narrow + the value is large, so show just the tool name
		-- as the focal value — recency is covered by the Last contact tile.
		lastCmdVal.Text = status.lastCommandTool or "N/A"
		lastContactVal.Text = (status.lastPollAt and status.lastPollAt > 0)
			and ago(status.lastPollAt) or "N/A"

		-- errorBanner visibility goes through setStatsItemVisible (not a raw
		-- .Visible write) so the Status card height stays correct; the call is
		-- a no-op when the value is unchanged.
		if status.lastError then
			errorBanner.Text = status.lastError
			errorBanner.TextColor3 = info.color
		end
		setStatsItemVisible(errorBanner, status.lastError ~= nil)

		-- footer buttons
		-- Pause (secondary): dark at rest, a yellow-ish tint while paused.
		if status.paused then
			pauseButton.Text = "Resume"
			pauseButton.BackgroundColor3 = C.yellow
			pauseButton.TextColor3 = C.bg
		else
			pauseButton.Text = "Pause"
			pauseButton.BackgroundColor3 = C.cardAlt
			pauseButton.TextColor3 = C.text
		end
		-- Connect / Disconnect (primary): accent when idle, red while polling.
		if status.polling then
			connectButton.Text = "Disconnect"
			connectButton.BackgroundColor3 = C.red
			connectButton.TextColor3 = C.text
		else
			connectButton.Text = "Connect"
			connectButton.BackgroundColor3 = C.accent
			connectButton.TextColor3 = C.text
		end

		enforceConnectionCollapse()
		enforceStatsCollapse()
		enforceTogglesCollapse()
	end

	-- ---- wire handlers -------------------------------------------------
	connectButton.Activated:Connect(function() Transport.toggle() end)
	pauseButton.Activated:Connect(function() Transport.setPaused(not Transport.status.paused) end)
	visualDebugToggle.Activated:Connect(function() setVisualDebug(not visualDebugOn) end)
	writesToggle.Activated:Connect(function()
		Transport.setWriteEnabled(not Transport.status.writeEnabled)
	end)
	Transport.changed.Event:Connect(function()
		paintWrites()
		paintToken()
	end)

	local function applyEndpoint()
		local raw = portInput.Text or ""
		-- Tolerate the user pasting "localhost:44820" — strip everything before the
		-- last colon, then keep digits only.
		local trimmed = raw:match(":(%d+)%s*$") or raw:match("^%s*(%d+)%s*$")
		local port = tonumber(trimmed)
		if not port or port < 1 or port > 65535 then
			portInput.Text = tostring(Transport.status.port)
			return
		end
		if Transport.setPort(port) then
			lastEndpointText = nil
		end
	end
	portInput.FocusLost:Connect(function()
		applyEndpoint()
	end)

	Transport.changed.Event:Connect(render)

	-- keep relative times fresh
	local stopped = false
	task.spawn(function()
		while not stopped do
			if widget.Enabled then render() end
			task.wait(1)
		end
	end)

	render()

	local function cleanup() stopped = true end
	return widget, cleanup
end

return StatusUi
