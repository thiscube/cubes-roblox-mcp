--!nonstrict
--[[
	Cubes MCP — Roblox Studio bridge plugin (entry point)
	=====================================================
	Studio plugins cannot open sockets, but they CAN make outbound HTTP requests to
	localhost. So this plugin is a long-polling client of the MCP server: it asks
	for a command, runs it in Studio, posts the result back, and repeats.

	This file just wires the modules together; the real work lives in:
	  Config       - connection constants (edit HOST here)
	  Refs         - ref tokens + path resolution
	  Serialize    - value serialization, hashing
	  Query        - selector engine
	  Read         - the read path
	  Mutate       - the write path (atomic undo waypoints)
	  Diagnostics  - structured error / playtest stream
	  Viewport     - vision-grounded scene capture
	  EventWatch   - RBXScriptSignal observer (event_watch / drain / unwatch)
	  Transport    - the HTTP long-poll loop + connection status
	  StatusUi     - the dockable connection status panel

	Install: `npm run setup` in the repo root copies plugin/CubesMCP.rbxmx into
	Studio with the bridge token baked in. After editing these
	sources, rebuild that file: rojo build plugin/plugin.project.json -o plugin/CubesMCP.rbxmx
--]]

-- During Play Solo, Studio clones this plugin's scripts into the running
-- DataModel's Server AND Client contexts. The clones run init alongside the
-- original plugin-context instance. To avoid 3 instances polling the bridge,
-- we use RunService:IsRunning() — the canonical pattern (Roblox's official MCP
-- uses the same check in plugin/src/Main.server.luau). In play DM clones,
-- IsRunning() is true; in plugin context, it's false even during play.
-- (We tried IsEdit() previously and it didn't reliably distinguish — IsRunning
-- is the documented mechanism per StudioTestService release notes.)
local _RS = game:GetService("RunService")
if _RS:IsRunning() then
	if _RS:IsServer() then
		-- Server-side play DM clone: start the cross-DM bus loop instead of bailing.
		-- Studio shares the `plugin` global across these clones, so plugin:SetSetting /
		-- :GetSetting work as the bidirectional command channel with the edit-DM plugin.
		local PlaytestBus = require(script.PlaytestBus)
		PlaytestBus.bind(plugin)
		task.spawn(function() PlaytestBus.startServerBus() end)
		print("[Cubes MCP] play-DM Server clone; cross-DM bus active")
	else
		print("[Cubes MCP] play-DM Client clone; idle")
	end
	return
end

local HttpService = game:GetService("HttpService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")

local Refs = require(script.Refs)
local Serialize = require(script.Serialize)
local Query = require(script.Query)
local Read = require(script.Read)
local Mutate = require(script.Mutate)
local Diagnostics = require(script.Diagnostics)
local Viewport = require(script.Viewport)
local Transport = require(script.Transport)
local StatusUi = require(script.StatusUi)
local EventWatch = require(script.EventWatch)
local PlaytestBus = require(script.PlaytestBus)
local HudOverlay = require(script.HudOverlay)

-- Assemble the __MCP helper table exposed to run_code (eval) chunks via _G.
-- Intentional global: eval'd chunks run in the global env, so the helper must
-- be reachable as a global (the eval preamble does `local __MCP = _G.__CUBES_MCP`).
-- selene: allow(global_usage)
_G.__CUBES_MCP = {
	refs = Refs.refs,
	refFor = Refs.refFor,
	resolve = Refs.resolve,
	query = Query.run,
	read = Read.read,
	mutate = Mutate.mutate,
	serialize = Serialize.value,
	diagnostics = Diagnostics.recent,
	viewport = Viewport.capture,
	decode = function(jsonStr)
		return HttpService:JSONDecode(jsonStr)
	end,
	-- Wrap a function in a single ChangeHistoryService undo waypoint.
	waypoint = function(name, fn)
		local recording = ChangeHistoryService:TryBeginRecording(tostring(name or "Cubes MCP run_code"))
		local results = table.pack(pcall(fn))
		local ok = results[1]
		if recording then
			local op = ok and Enum.FinishRecordingOperation.Commit or Enum.FinishRecordingOperation.Cancel
			ChangeHistoryService:FinishRecording(recording, op)
		end
		if not ok then
			error(results[2], 2)
		end
		return table.unpack(results, 2, results.n)
	end,
}

-- A camera left stuck by an earlier session (see ViewGuard) is fixed on load.
local ViewGuard = require(script.ViewGuard)
local okHeal, healed = pcall(ViewGuard.heal)
if okHeal and healed then
	warn("[Cubes MCP] the edit camera was stuck; fixed " .. table.concat(healed, ", "))
end

-- Bind the Plugin instance to Transport so it can persist user settings
-- (custom port) across plugin reloads and edit↔play transitions.
Transport.bindPlugin(plugin)
-- Bind to PlaytestBus too: it uses plugin:SetSetting / GetSetting as the
-- cross-DM signal channel for character_* tools during Play Solo.
PlaytestBus.bind(plugin)

-- Toolbar button shows / hides the status panel.
local toolbar = plugin:CreateToolbar("Cubes MCP")
local button = toolbar:CreateButton("Status", "Show the Cubes MCP bridge status panel", "")
button.ClickableWhenViewportHidden = true

local widget, statusUiCleanup = StatusUi.create(plugin, Transport)

-- Restore the user's last-known panel visibility across plugin reloads and
-- edit↔play DataModel transitions. Studio's own enabled-state restore is
-- unreliable when the DataModel swaps (e.g. entering Play Solo), so we
-- persist the preference ourselves.
local persistedVisible = nil
pcall(function()
	persistedVisible = plugin:GetSetting("statusPanelVisible")
end)
if type(persistedVisible) == "boolean" then
	widget.Enabled = persistedVisible
end

button.Click:Connect(function()
	widget.Enabled = not widget.Enabled
end)
widget:GetPropertyChangedSignal("Enabled"):Connect(function()
	button:SetActive(widget.Enabled)
	pcall(function() plugin:SetSetting("statusPanelVisible", widget.Enabled) end)
end)
button:SetActive(widget.Enabled)

-- Keyboard-shortcut actions. Users can bind these in File → Advanced →
-- Customize Shortcuts → Cubes MCP. Default keybinds aren't a parameter of
-- CreatePluginAction; Studio's shortcut editor is the standard surface.
local togglePauseAction = plugin:CreatePluginAction(
	"CubesMCP_TogglePause",
	"Toggle MCP pause",
	"Pause/unpause the Cubes MCP bridge — paused = polling continues, commands are rejected.",
	"",
	true
)
togglePauseAction.Triggered:Connect(function()
	Transport.setPaused(not Transport.status.paused)
end)

local togglePanelAction = plugin:CreatePluginAction(
	"CubesMCP_TogglePanel",
	"Toggle MCP status panel",
	"Show or hide the Cubes MCP status panel.",
	"",
	true
)
togglePanelAction.Triggered:Connect(function()
	widget.Enabled = not widget.Enabled
end)

plugin.Unloading:Connect(function()
	Transport.stop()
	Diagnostics.stop()
	EventWatch.stopAll()
	HudOverlay.destroy()
	if statusUiCleanup then
		pcall(statusUiCleanup)
	end
end)

-- Auto-connect on load.
Transport.setPolling(true)
print("[Cubes MCP] plugin loaded — bridge auto-connecting to " .. Transport.status.host)
