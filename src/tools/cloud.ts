import { execFile } from "node:child_process";
import { type ToolEntry, localTool } from "../registry.js";
import { openCloudKey } from "../assets.js";

/**
 * Read-only Open Cloud lookups about the live game: analytics and who has a save.
 *
 * Neither touches Studio or creates anything remotely, so both are `localTool`s
 * with `network: "read"` and never wait on the write toggle. They do declare
 * `process: true`: when the MCP client started before the user set
 * CUBES_MCP_OPEN_CLOUD_KEY, the key is only in the registry, and reading it
 * there spawns `reg.exe`. That keeps them out of the inspector build, honestly.
 *
 * The key is sent only to apis.roblox.com and never returned or logged.
 * users.roblox.com is public and gets no key.
 */

const CLIMB_STAIRS_UNIVERSE = "10767733133";
const ANALYTICS = "https://apis.roblox.com/analytics-query-api/";
const DATASTORES = "https://apis.roblox.com/datastores/v1/universes";
const USERS = "https://users.roblox.com/v1/users";
const TIMEOUT_MS = 20_000;
const POLL_CAP_MS = 60_000;
const MAX_PAGES = 50;
const DOCS = "https://create.roblox.com/docs/en-us/cloud/guides/analytics/metrics.md";

const COMMON_METRICS = [
  "DailyActiveUsers", "MonthlyActiveUsers", "Visits", "AverageSessionLengthMinutes",
  "AveragePlayTimeMinutesPerDAU", "ForwardD1Retention", "ForwardD7Retention", "ForwardD30Retention",
  "UniqueUsersWithImpressions", "ImpressionCVR", "ClickCVR", "QualifiedEndToEndCVR", "RFYPlayThroughRate",
  "DailyRevenue", "PayingUsers", "PayingUsersCVR", "AverageRevenuePerUser", "ThumbnailImpressions",
  "ThumbnailQualifiedPTR", "ThumbnailAverageSessionLengthMinutes", "ThumbnailWinningSegments",
  "FunnelUserStepCompletionRate", "FunnelUserChurnRate", "EconomyTransactionAmount",
  "CustomEventAvgPerUserValue", "ClientCrashRate15m", "ServerFrameRateAvg",
];

const GRANULARITIES = ["OneMinute", "HalfHour", "OneHour", "OneDay", "OneWeek", "OneMonth", "None"];

/** The env var first; on Windows, the user's registry value when the env predates it. */
async function cloudKey(): Promise<string | undefined> {
  const env = openCloudKey();
  if (env || process.platform !== "win32") return env;
  return new Promise((resolve) => {
    execFile(
      "reg",
      ["query", "HKCU\\Environment", "/v", "CUBES_MCP_OPEN_CLOUD_KEY"],
      { windowsHide: true, timeout: 5_000 },
      (err, stdout) => {
        const value = err ? undefined : /REG_(?:EXPAND_)?SZ[ \t]+(.+)$/m.exec(stdout)?.[1]?.trim();
        resolve(value || undefined);
      },
    );
  });
}

/** fetch with a timeout and the repo's offline guard. Returns the status and parsed body. */
async function request(url: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  if (process.env.CUBES_MCP_OFFLINE === "1") {
    throw new Error("CUBES_MCP_OFFLINE=1: refusing to reach Roblox.");
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let body: any = text;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      // Not JSON; keep the text for the error message.
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function failure(status: number, body: any): string {
  const msg = body?.error?.message ?? body?.message ?? body?.errors?.[0]?.message;
  return `HTTP ${status}${msg ? `: ${msg}` : typeof body === "string" && body ? `: ${body.slice(0, 200)}` : ""}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** POST an analytics query and poll its operation until done, up to ~60 s. */
async function analytics(key: string, url: string, body: unknown): Promise<any> {
  const headers = { "x-api-key": key, "Content-Type": "application/json" };
  let { status, body: op } = await request(url, { method: "POST", headers, body: JSON.stringify(body) });
  const started = Date.now();
  let wait = 500;
  while (op?.done === false && op.path) {
    if (Date.now() - started > POLL_CAP_MS) throw new Error(`Still running after 60 s. Poll path: ${op.path}`);
    await sleep(wait);
    wait = Math.min(wait * 2, 5_000);
    ({ status, body: op } = await request(ANALYTICS + op.path, { headers: { "x-api-key": key } }));
  }
  if (op?.error) throw new Error(`${op.error.message ?? "Analytics error"} (code ${op.error.code}, HTTP ${status})`);
  if (status >= 400 || !op?.response) throw new Error(failure(status, op));
  return op;
}

function dayRange(args: any): { startTime: string; endTime: string } {
  if (args.startTime && args.endTime) return { startTime: String(args.startTime), endTime: String(args.endTime) };
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const days = Math.max(1, Math.floor(Number(args.days) || 30));
  return { startTime: new Date(end.getTime() - days * 86_400_000).toISOString(), endTime: end.toISOString() };
}

function point(p: any): string {
  const t = String(p.time ?? "").replace(/T00:00:00(\.0+)?(Z|\+00:00)$/, "").replace(/:00(\.0+)?(Z|\+00:00)$/, "Z");
  const v = Array.isArray(p.stringValues)
    ? p.stringValues.join("|")
    : typeof p.value === "number"
      ? String(Number(p.value.toPrecision(6)))
      : String(p.value);
  return `${t}=${v}${p.status && p.status !== "Valid" ? ` (${p.status})` : ""}`;
}

async function runAnalytics(args: any): Promise<unknown> {
  if (!args.metric) {
    return { metrics: COMMON_METRICS, docs: DOCS, hint: "Pass one as metric. The docs list the rest and their breakdowns." };
  }
  const key = await cloudKey();
  if (!key) return { error: "no_open_cloud_key", hint: "Set CUBES_MCP_OPEN_CLOUD_KEY (universe.analytics:read)." };
  const universeId = String(args.universeId ?? CLIMB_STAIRS_UNIVERSE);
  const range = dayRange(args);
  const base = `${ANALYTICS}v1/universes/${encodeURIComponent(universeId)}`;
  const optional = {
    ...(Array.isArray(args.filter) && args.filter.length ? { filter: args.filter } : {}),
    ...(args.limit !== undefined ? { limit: Number(args.limit) } : {}),
  };
  try {
    if (args.mode === "dimensions") {
      const dims = Array.isArray(args.breakdown) ? args.breakdown : [];
      if (!dims.length) return { error: "bad_args", hint: "mode 'dimensions' needs breakdown: the dimension names." };
      const op = await analytics(key, `${base}/dimension-values`, {
        metric: args.metric, dimensions: dims, ...range, ...optional,
      });
      return {
        metric: args.metric,
        range: `${range.startTime}..${range.endTime}`,
        dimensions: (op.response.values ?? []).map(
          (d: any) =>
            `${d.dimension}: ${(d.values ?? [])
              .map((v: any) => (v.displayValue && v.displayValue !== v.value ? `${v.value} (${v.displayValue})` : v.value))
              .join(", ")}`,
        ),
        ...(args.raw ? { raw: op } : {}),
      };
    }
    const granularity = GRANULARITIES.includes(args.granularity) ? args.granularity : "OneDay";
    const op = await analytics(key, `${base}/metrics`, {
      metric: args.metric,
      granularity,
      ...range,
      ...(Array.isArray(args.breakdown) && args.breakdown.length ? { breakdown: args.breakdown } : {}),
      ...optional,
    });
    const values: any[] = op.response.values ?? [];
    return {
      metric: args.metric,
      universeId,
      granularity,
      range: `${range.startTime}..${range.endTime}`,
      series: values.map((s) => {
        const label = (s.breakdowns ?? []).map((b: any) => b.displayValue ?? b.value).join("/") || "all";
        return `${label}: ${(s.dataPoints ?? []).map(point).join(", ") || "(no data)"}`;
      }),
      ...(values.length ? {} : { hint: "No series returned. Check the range, or that the metric supports this granularity." }),
      ...(args.raw ? { raw: op } : {}),
    };
  } catch (err) {
    return { error: "analytics_failed", message: err instanceof Error ? err.message : String(err), docs: DOCS };
  }
}

async function runListSaves(args: any): Promise<unknown> {
  const key = await cloudKey();
  if (!key) return { error: "no_open_cloud_key", hint: "Set CUBES_MCP_OPEN_CLOUD_KEY (DataStore list access)." };
  const universeId = String(args.universeId ?? CLIMB_STAIRS_UNIVERSE);
  const datastoreName = String(args.datastoreName ?? "PlayerData");
  const prefix = String(args.prefix ?? "Player_");
  try {
    const keys: string[] = [];
    let cursor = "";
    for (let page = 0; page < MAX_PAGES; page++) {
      const q = new URLSearchParams({ datastoreName, prefix, limit: "100" });
      if (cursor) q.set("cursor", cursor);
      const url = `${DATASTORES}/${encodeURIComponent(universeId)}/standard-datastores/datastore/entries?${q}`;
      const { status, body } = await request(url, { headers: { "x-api-key": key } });
      if (status >= 400) throw new Error(failure(status, body));
      for (const k of body?.keys ?? []) keys.push(String(k.key));
      cursor = body?.nextPageCursor ?? "";
      if (!cursor) break;
    }

    const ids = keys.map((k) => k.slice(prefix.length)).filter((id) => /^\d+$/.test(id));
    const users = new Map<string, any>();
    for (let i = 0; i < ids.length; i += 100) {
      // Public endpoint: deliberately no key.
      const { status, body } = await request(USERS, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userIds: ids.slice(i, i + 100).map(Number), excludeBannedUsers: false }),
      });
      if (status >= 400) throw new Error(`users.roblox.com ${failure(status, body)}`);
      for (const u of body?.data ?? []) users.set(String(u.id), u);
    }

    const other = keys.length - ids.length;
    return {
      datastoreName,
      count: ids.length,
      players: ids.map((id) => {
        const u = users.get(id);
        return u ? `${u.displayName} (@${u.name}, ${id})` : `? (unresolved, ${id})`;
      }),
      ...(other ? { otherKeys: other } : {}),
      ...(cursor ? { hint: `Stopped after ${MAX_PAGES} pages; there are more keys.` } : {}),
    };
  } catch (err) {
    return { error: "datastore_list_failed", message: err instanceof Error ? err.message : String(err) };
  }
}

export const CLOUD_TOOLS: ToolEntry[] = [
  localTool(
    {
      name: "analytics_query",
      effects: { network: "read", process: true },
      category: "cloud",
      subcategories: ["analytics", "metrics", "live"],
      keywords: ["analytics", "metrics", "dau", "players", "retention", "revenue", "visits", "stats", "opencloud", "dashboard"],
      description:
        "Live game analytics via Open Cloud: DAU, visits, retention, session length, revenue, conversion. Omit metric to list common names. One line per series. Default universe is Climb Stairs.",
      inputSchema: {
        type: "object",
        properties: {
          metric: { type: "string", description: "e.g. DailyActiveUsers, DailyRevenue. Omit to list names." },
          days: { type: "number", description: "Last N full UTC days (default 30)." },
          startTime: { type: "string", description: "RFC 3339, inclusive. Overrides days." },
          endTime: { type: "string", description: "Exclusive." },
          granularity: { type: "string", enum: GRANULARITIES, description: "Default OneDay." },
          breakdown: { type: "array", items: { type: "string" }, description: "e.g. ['Platform']." },
          filter: { type: "array", description: "[{dimension, values, operation}]" },
          limit: { type: "number", description: "Max series (granularity None)." },
          mode: { type: "string", enum: ["dimensions"], description: "List valid breakdown values." },
          universeId: { type: "string" },
          raw: { type: "boolean" },
        },
      },
    },
    async (args) => runAnalytics(args ?? {}),
  ),

  localTool(
    {
      name: "list_player_saves",
      effects: { network: "read", process: true },
      category: "cloud",
      subcategories: ["datastore", "players", "live"],
      keywords: ["datastore", "saves", "players", "playerdata", "who", "played", "users", "opencloud", "live"],
      description:
        "List the players who have a save in the live game's DataStore (keys Player_<userId>), with display and user names. Read-only, via Open Cloud. Default universe is Climb Stairs.",
      inputSchema: {
        type: "object",
        properties: {
          datastoreName: { type: "string", description: "Default PlayerData." },
          prefix: { type: "string", description: "Key prefix before the user id. Default Player_." },
          universeId: { type: "string" },
        },
      },
    },
    async (args) => runListSaves(args ?? {}),
  ),
];
