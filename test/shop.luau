-- Builds a "looks-good" placeholder Shop UI in StarterGui, and also drops a
-- live preview in CoreGui so the user sees it in Studio without play-testing.
-- Returns a small summary the caller prints.

local StarterGui = game:GetService("StarterGui")
local CoreGui = game:GetService("CoreGui")
local Selection = game:GetService("Selection")

-- ---- helpers ----
local function new(class, parent, props)
	local inst = Instance.new(class)
	if props then
		for k, v in pairs(props) do
			inst[k] = v
		end
	end
	if parent then
		inst.Parent = parent
	end
	return inst
end

local function rgb(r, g, b)
	return Color3.fromRGB(r, g, b)
end
local function ud2(xs, xo, ys, yo)
	return UDim2.new(xs, xo, ys, yo)
end
local function ud(s, o)
	return UDim.new(s, o)
end

-- ---- design tokens ----
local C = {
	bgDim = rgb(0, 0, 0),
	bgPanelTop = rgb(28, 30, 44),
	bgPanelBot = rgb(16, 18, 28),
	bgCard = rgb(28, 31, 44),
	bgInset = rgb(18, 20, 30),
	border = rgb(60, 65, 85),
	borderSubtle = rgb(38, 42, 58),
	textPrimary = rgb(238, 240, 250),
	textSecondary = rgb(150, 156, 174),
	textMuted = rgb(100, 105, 122),
	accent = rgb(95, 205, 255),
	accentDark = rgb(18, 90, 130),
	coin = rgb(255, 200, 70),
	coinDark = rgb(220, 150, 30),
	gem = rgb(180, 110, 255),
	rar = {
		Common = rgb(170, 175, 188),
		Rare = rgb(85, 175, 255),
		Epic = rgb(190, 110, 255),
		Legendary = rgb(255, 175, 50),
	},
}

local ITEMS = {
	{ name = "Phantom Cloak",   price = 250,  rarity = "Rare" },
	{ name = "Solar Blade",     price = 500,  rarity = "Epic" },
	{ name = "Stardust Wings",  price = 1500, rarity = "Legendary" },
	{ name = "Aurora Aura",     price = 750,  rarity = "Epic" },
	{ name = "Quick Boots",     price = 100,  rarity = "Common" },
	{ name = "Mystery Box",     price = 300,  rarity = "Rare" },
	{ name = "Void Walker",     price = 2000, rarity = "Legendary" },
	{ name = "Plasma Shield",   price = 600,  rarity = "Epic" },
}

local function buildShop(parent, name)
	-- destroy any previous build under the same name
	local existing = parent:FindFirstChild(name)
	if existing then existing:Destroy() end

	local gui = new("ScreenGui", parent, {
		Name = name,
		ZIndexBehavior = Enum.ZIndexBehavior.Sibling,
		ResetOnSpawn = false,
		IgnoreGuiInset = true,
	})

	-- backdrop
	local backdrop = new("Frame", gui, {
		Name = "Backdrop",
		Size = ud2(1, 0, 1, 0),
		BackgroundColor3 = C.bgDim,
		BackgroundTransparency = 0.4,
		BorderSizePixel = 0,
		ZIndex = 1,
	})

	-- main panel
	local panel = new("Frame", backdrop, {
		Name = "Panel",
		AnchorPoint = Vector2.new(0.5, 0.5),
		Position = ud2(0.5, 0, 0.5, 0),
		Size = ud2(0, 760, 0, 580),
		BackgroundColor3 = C.bgPanelBot,
		BorderSizePixel = 0,
		ZIndex = 2,
	})
	new("UICorner", panel, { CornerRadius = ud(0, 16) })
	new("UIStroke", panel, {
		Color = C.border,
		Thickness = 1,
		Transparency = 0.4,
		ApplyStrokeMode = Enum.ApplyStrokeMode.Border,
	})
	new("UIGradient", panel, {
		Color = ColorSequence.new({
			ColorSequenceKeypoint.new(0, C.bgPanelTop),
			ColorSequenceKeypoint.new(1, C.bgPanelBot),
		}),
		Rotation = 110,
	})
	new("UIPadding", panel, {
		PaddingTop = ud(0, 22),
		PaddingBottom = ud(0, 20),
		PaddingLeft = ud(0, 24),
		PaddingRight = ud(0, 24),
	})

	-- ---- HEADER ----
	local header = new("Frame", panel, {
		Name = "Header",
		Size = ud2(1, 0, 0, 54),
		BackgroundTransparency = 1,
	})

	new("TextLabel", header, {
		Name = "Title",
		Size = ud2(0, 400, 0, 32),
		BackgroundTransparency = 1,
		Font = Enum.Font.GothamBold,
		Text = "SHOP",
		TextColor3 = C.textPrimary,
		TextSize = 28,
		TextXAlignment = Enum.TextXAlignment.Left,
		TextYAlignment = Enum.TextYAlignment.Top,
	})
	new("TextLabel", header, {
		Name = "Subtitle",
		Position = ud2(0, 0, 0, 34),
		Size = ud2(0, 400, 0, 18),
		BackgroundTransparency = 1,
		Font = Enum.Font.Gotham,
		Text = "Featured drops · refreshes daily",
		TextColor3 = C.textMuted,
		TextSize = 13,
		TextXAlignment = Enum.TextXAlignment.Left,
	})

	-- currency chip on the right
	local function currencyChip(parentFrame, x, value, dotColor, dotStroke)
		local chip = new("Frame", parentFrame, {
			AnchorPoint = Vector2.new(1, 0.5),
			Position = ud2(1, x, 0.5, 0),
			Size = ud2(0, 96, 0, 32),
			BackgroundColor3 = C.bgInset,
			BorderSizePixel = 0,
		})
		new("UICorner", chip, { CornerRadius = ud(0, 10) })
		new("UIStroke", chip, { Color = C.borderSubtle, Thickness = 1, Transparency = 0.2 })

		local dot = new("Frame", chip, {
			AnchorPoint = Vector2.new(0, 0.5),
			Position = ud2(0, 8, 0.5, 0),
			Size = ud2(0, 14, 0, 14),
			BackgroundColor3 = dotColor,
			BorderSizePixel = 0,
		})
		new("UICorner", dot, { CornerRadius = ud(1, 0) })
		new("UIStroke", dot, { Color = dotStroke, Thickness = 1 })

		new("TextLabel", chip, {
			Position = ud2(0, 26, 0, 0),
			Size = ud2(1, -34, 1, 0),
			BackgroundTransparency = 1,
			Font = Enum.Font.GothamBold,
			Text = value,
			TextColor3 = C.textPrimary,
			TextSize = 14,
			TextXAlignment = Enum.TextXAlignment.Left,
		})
	end

	-- right side of header: currency, close
	local headerRight = new("Frame", header, {
		Name = "Right",
		AnchorPoint = Vector2.new(1, 0),
		Position = ud2(1, 0, 0, 0),
		Size = ud2(0, 260, 1, 0),
		BackgroundTransparency = 1,
	})

	currencyChip(headerRight, -116, "12,450", C.coin, C.coinDark)
	currencyChip(headerRight, -10, "286", C.gem, rgb(120, 60, 200))

	local closeBtn = new("TextButton", header, {
		Name = "Close",
		AnchorPoint = Vector2.new(1, 1),
		Position = ud2(1, 0, 1, 0),
		Size = ud2(0, 32, 0, 32),
		BackgroundColor3 = C.bgInset,
		BorderSizePixel = 0,
		Font = Enum.Font.GothamBold,
		Text = "×",
		TextColor3 = C.textSecondary,
		TextSize = 22,
		AutoButtonColor = false,
	})
	new("UICorner", closeBtn, { CornerRadius = ud(0, 8) })
	new("UIStroke", closeBtn, { Color = C.borderSubtle, Thickness = 1, Transparency = 0.2 })

	-- ---- TABS ----
	local tabsRow = new("Frame", panel, {
		Name = "Tabs",
		Position = ud2(0, 0, 0, 74),
		Size = ud2(1, 0, 0, 38),
		BackgroundTransparency = 1,
	})
	new("UIListLayout", tabsRow, {
		FillDirection = Enum.FillDirection.Horizontal,
		Padding = ud(0, 6),
		SortOrder = Enum.SortOrder.LayoutOrder,
		VerticalAlignment = Enum.VerticalAlignment.Center,
	})

	local TABS = { "Featured", "Skins", "Bundles", "Limited", "Events" }
	for i, label in ipairs(TABS) do
		local active = (i == 1)
		local tab = new("TextButton", tabsRow, {
			Name = label,
			Size = ud2(0, 96, 0, 32),
			BackgroundColor3 = active and C.bgCard or C.bgInset,
			BorderSizePixel = 0,
			Font = active and Enum.Font.GothamBold or Enum.Font.GothamMedium,
			Text = label,
			TextColor3 = active and C.textPrimary or C.textSecondary,
			TextSize = 13,
			AutoButtonColor = false,
			LayoutOrder = i,
		})
		new("UICorner", tab, { CornerRadius = ud(0, 9) })
		if active then
			new("UIStroke", tab, { Color = C.accent, Thickness = 1, Transparency = 0.35 })
			-- subtle accent dot under the label
			local dot = new("Frame", tab, {
				AnchorPoint = Vector2.new(0.5, 1),
				Position = ud2(0.5, 0, 1, -4),
				Size = ud2(0, 14, 0, 2),
				BackgroundColor3 = C.accent,
				BorderSizePixel = 0,
			})
			new("UICorner", dot, { CornerRadius = ud(1, 0) })
		else
			new("UIStroke", tab, { Color = C.borderSubtle, Thickness = 1, Transparency = 0.2 })
		end
	end

	-- ---- ITEM GRID ----
	local grid = new("ScrollingFrame", panel, {
		Name = "Items",
		Position = ud2(0, 0, 0, 124),
		Size = ud2(1, 0, 1, -124),
		BackgroundTransparency = 1,
		BorderSizePixel = 0,
		ScrollBarThickness = 4,
		ScrollBarImageColor3 = C.border,
		CanvasSize = ud2(0, 0, 0, 0),
		AutomaticCanvasSize = Enum.AutomaticSize.Y,
		ScrollingDirection = Enum.ScrollingDirection.Y,
	})
	new("UIGridLayout", grid, {
		CellSize = ud2(0, 162, 0, 218),
		CellPadding = ud2(0, 12, 0, 12),
		SortOrder = Enum.SortOrder.LayoutOrder,
		HorizontalAlignment = Enum.HorizontalAlignment.Left,
	})
	new("UIPadding", grid, {
		PaddingRight = ud(0, 10),
		PaddingTop = ud(0, 2),
		PaddingBottom = ud(0, 8),
	})

	for i, item in ipairs(ITEMS) do
		local rarityColor = C.rar[item.rarity] or C.rar.Common

		local card = new("Frame", grid, {
			Name = item.name,
			BackgroundColor3 = C.bgCard,
			BorderSizePixel = 0,
			LayoutOrder = i,
		})
		new("UICorner", card, { CornerRadius = ud(0, 12) })
		new("UIStroke", card, { Color = C.borderSubtle, Thickness = 1, Transparency = 0.1 })

		-- subtle inner gradient for depth
		new("UIGradient", card, {
			Color = ColorSequence.new({
				ColorSequenceKeypoint.new(0, rgb(34, 38, 54)),
				ColorSequenceKeypoint.new(1, rgb(22, 25, 36)),
			}),
			Rotation = 135,
		})

		-- icon box (rarity-tinted gradient)
		local iconBox = new("Frame", card, {
			Name = "Icon",
			Position = ud2(0, 12, 0, 12),
			Size = ud2(1, -24, 0, 118),
			BackgroundColor3 = C.bgInset,
			BorderSizePixel = 0,
		})
		new("UICorner", iconBox, { CornerRadius = ud(0, 10) })
		new("UIGradient", iconBox, {
			Color = ColorSequence.new({
				ColorSequenceKeypoint.new(0, rarityColor),
				ColorSequenceKeypoint.new(1, C.bgInset),
			}),
			Transparency = NumberSequence.new({
				NumberSequenceKeypoint.new(0, 0.55),
				NumberSequenceKeypoint.new(0.6, 0.92),
				NumberSequenceKeypoint.new(1, 1),
			}),
			Rotation = 135,
		})

		-- placeholder glyph: first letter, large, in the rarity color
		new("TextLabel", iconBox, {
			Name = "Glyph",
			Size = ud2(1, 0, 1, 0),
			BackgroundTransparency = 1,
			Font = Enum.Font.GothamBold,
			Text = string.sub(item.name, 1, 1),
			TextColor3 = rarityColor,
			TextSize = 56,
			TextTransparency = 0.05,
		})

		-- rarity badge top-left
		local badge = new("Frame", iconBox, {
			Name = "Rarity",
			Position = ud2(0, 8, 0, 8),
			Size = ud2(0, 52, 0, 18),
			BackgroundColor3 = rarityColor,
			BorderSizePixel = 0,
		})
		new("UICorner", badge, { CornerRadius = ud(0, 6) })
		new("TextLabel", badge, {
			Size = ud2(1, 0, 1, 0),
			BackgroundTransparency = 1,
			Font = Enum.Font.GothamBold,
			Text = string.upper(item.rarity),
			TextColor3 = rgb(18, 20, 28),
			TextSize = 10,
		})

		-- item name
		new("TextLabel", card, {
			Name = "ItemName",
			Position = ud2(0, 12, 0, 138),
			Size = ud2(1, -24, 0, 18),
			BackgroundTransparency = 1,
			Font = Enum.Font.GothamBold,
			Text = item.name,
			TextColor3 = C.textPrimary,
			TextSize = 14,
			TextXAlignment = Enum.TextXAlignment.Left,
			TextTruncate = Enum.TextTruncate.AtEnd,
		})

		-- buy button
		local buy = new("TextButton", card, {
			Name = "Buy",
			Position = ud2(0, 12, 1, -42),
			Size = ud2(1, -24, 0, 32),
			BackgroundColor3 = C.accent,
			BorderSizePixel = 0,
			Font = Enum.Font.GothamBold,
			Text = "",
			AutoButtonColor = true,
		})
		new("UICorner", buy, { CornerRadius = ud(0, 9) })
		new("UIGradient", buy, {
			Color = ColorSequence.new({
				ColorSequenceKeypoint.new(0, rgb(120, 220, 255)),
				ColorSequenceKeypoint.new(1, rgb(70, 165, 230)),
			}),
			Rotation = 110,
		})
		-- price text inside the button (left)
		new("TextLabel", buy, {
			Name = "Price",
			Position = ud2(0, 12, 0, 0),
			Size = ud2(1, -34, 1, 0),
			BackgroundTransparency = 1,
			Font = Enum.Font.GothamBold,
			Text = string.format("Buy  %d", item.price),
			TextColor3 = rgb(8, 24, 36),
			TextSize = 13,
			TextXAlignment = Enum.TextXAlignment.Left,
		})
		-- coin icon inside the button (right)
		local pcoin = new("Frame", buy, {
			Name = "Coin",
			AnchorPoint = Vector2.new(1, 0.5),
			Position = ud2(1, -10, 0.5, 0),
			Size = ud2(0, 14, 0, 14),
			BackgroundColor3 = C.coin,
			BorderSizePixel = 0,
		})
		new("UICorner", pcoin, { CornerRadius = ud(1, 0) })
		new("UIStroke", pcoin, { Color = C.coinDark, Thickness = 1 })
	end

	return gui
end

-- Build the real one (StarterGui) — proper place for player UIs.
local real = buildShop(StarterGui, "ShopGui")
-- Build a live preview in CoreGui so the user can see it in edit mode
-- without play-testing. Caller can delete this anytime.
local preview = buildShop(CoreGui, "ShopGui_Preview")

-- Select the real one so it shows up in the Properties panel.
pcall(function()
	Selection:Set({ real })
end)

return {
	created = real:GetFullName(),
	preview = preview:GetFullName(),
	itemCount = #ITEMS,
}
