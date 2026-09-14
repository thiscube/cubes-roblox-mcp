--!nonstrict
-- Connection + transport constants.
--
-- The port can be customized at runtime via the panel. It must match the MCP
-- server's CUBES_MCP_PORT env var (default 44820). When the plugin binds itself,
-- it loads the persisted port; until then the default holds.

local Config = {}

-- Human-facing version string (shown in the status panel). Bump when shipping
-- a noticeable plugin change. Independent from PROTOCOL_VERSION below.
Config.VERSION = "0.3.0"

Config.DEFAULT_PORT = 44820
Config.HOST_NAME = "localhost"
Config.port = Config.DEFAULT_PORT

local function rebuild()
	Config.HOST = string.format("http://%s:%d", Config.HOST_NAME, Config.port)
	Config.POLL_URL = Config.HOST .. "/poll"
	Config.RESULT_URL = Config.HOST .. "/result"
end
rebuild()

function Config.setPort(port)
	port = tonumber(port)
	if not port or port < 1 or port > 65535 then return false end
	port = math.floor(port)
	if port == Config.port then return false end
	Config.port = port
	rebuild()
	return true
end

-- Seconds without a command before Claude counts as done: the activity bar
-- says Idle and the view (camera, selection, camera settings) is put back.
Config.IDLE_AFTER = 20

-- Back-off (seconds) after a failed poll — the MCP server is probably not running.
Config.RETRY_WAIT = 2
-- Back-off (seconds) after a non-fatal poll error (bad status / decode failure).
Config.ERROR_WAIT = 1
-- Back-off (seconds) after a protocol mismatch — re-polling won't help, the user
-- has to rebuild the plugin or update the server, so we slow down hard.
Config.VERSION_MISMATCH_WAIT = 10

-- Wire-protocol version. Sent in every /poll body; the MCP server accepts a
-- range (MIN..MAX in src/protocol.ts) and answers anything outside it with 426.
-- 2 = bearer token on every request. 3-5 (capture, WebSocket, multi-window) are
-- additive and not implemented here.
-- Bump only when the wire format of /poll, /result, or any tool's args/results
-- change in a way the other side can't safely ignore.
Config.PROTOCOL_VERSION = 2

-- The bridge token, written in by `npm run setup` when it installs this file, so
-- nobody has to paste it. The placeholder means "not baked": the token then comes
-- from the Controls panel instead. Keep the placeholder text exactly as it is;
-- the installer replaces it by name.
Config.BAKED_TOKEN = "__CUBES_MCP_BAKED_TOKEN__"

return Config
