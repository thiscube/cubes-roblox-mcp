import { type ToolEntry, evalTool, localTool, luaJson } from "../registry.js";
import { getApiDocs, type ApiMember, type ResolvedMember } from "../docs.js";
import { objectResult } from "../output-schema.js";

/**
 * Engine API reference (PLAN.md #4).
 *
 * The agent used to guess property names, value types and enum members, get them
 * wrong, and spend a Studio round trip plus a model turn discovering it. These
 * four lookups are server-local and answer instantly from the cached dump; the
 * fifth (`docs_defaults`) is the one question the dump cannot answer and has to
 * be asked of Studio itself.
 *
 * One file per Category value — the registry's own taxonomy names the file,
 * so there is never a question of where a new tool goes (A6).
 */

/** Results per response. The whole point is to be cheaper than a failed call. */
const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 200;

function clampLimit(value: unknown, fallback = DEFAULT_LIMIT): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(MAX_LIMIT, Math.max(1, n));
}

/** How the dump's Security field reads, flattened to one string. */
function security(member: ApiMember): string | undefined {
  const s = member.Security;
  if (!s) return undefined;
  // Older dumps carried a bare string here. Current ones always use the pair,
  // but the shape is cheap to keep supporting and the fixture exercises it.
  if (typeof s === "string") return s === "None" ? undefined : s;
  if (s.Read === "None" && s.Write === "None") return undefined;
  return `read:${s.Read} write:${s.Write}`;
}

/** The security level required to WRITE a member, or "None". */
function writeSecurity(member: ApiMember): string {
  const s = member.Security;
  if (!s) return "None";
  return typeof s === "string" ? s : s.Write;
}

/**
 * Can this server set this property?
 *
 * Three-valued on purpose, because the honest answer is three-valued.
 *
 *   true     plain, unsecured, scriptable. Set it.
 *   "plugin" writing needs PluginSecurity — which this server HAS, because the
 *            other half of it is a Studio plugin. 94 properties across the dump
 *            sit here, including Instance.RobloxLocked. Reporting them as
 *            unwritable was a false negative.
 *   false    everything else: RobloxScriptSecurity and friends, ReadOnly, and
 *            NotScriptable.
 *
 * `NotScriptable` is the one that actually hurt. 36 properties carry it —
 * `Lighting.Technology` among them, which an agent reaches for in the first ten
 * turns of any lighting task. The dump gives them `Security: None`, so a
 * security-only rule called them writable and sent the agent into a confident
 * failed mutate. That is worse than having no docs tool at all.
 */
function writability(member: ApiMember): true | false | "plugin" {
  if (member.MemberType !== "Property") return false;
  const tags = member.Tags ?? [];
  if (tags.includes("ReadOnly") || tags.includes("NotScriptable")) return false;
  const write = writeSecurity(member);
  if (write === "None") return true;
  if (write === "PluginSecurity") return "plugin";
  return false;
}

/** Compact one member down to what actually helps a caller decide. */
function summarize({ member, declaredOn, inherited }: ResolvedMember) {
  const out: Record<string, unknown> = { name: member.Name, kind: member.MemberType };
  if (member.ValueType) out.type = member.ValueType.Name;
  if (member.MemberType === "Function" || member.MemberType === "Event" || member.MemberType === "Callback") {
    out.params = (member.Parameters ?? []).map((p) =>
      p.Default === undefined ? `${p.Name}: ${p.Type.Name}` : `${p.Name}: ${p.Type.Name} = ${p.Default}`,
    );
    if (member.ReturnType) out.returns = member.ReturnType.Name;
  }
  const sec = security(member);
  if (sec) out.security = sec;
  if (member.Tags?.length) out.tags = member.Tags;
  // Only say where it came from when that is not obvious.
  if (inherited) out.from = declaredOn;
  // Whether this can be set is the single most useful fact for a mutate call.
  if (member.MemberType === "Property") out.writable = writability(member);
  return out;
}

/** Every response says how fresh the dump is, so a stale answer is never silent. */
async function docs() {
  const api = await getApiDocs();
  const provenance: Record<string, unknown> = {
    studio_version: api.status.studioVersion,
    dump_age_hours: api.status.ageHours,
    // The number that would have caught the frozen-resolver bug. A thin dump
    // answers "no such class" rather than failing, so the size has to be visible.
    // Named `dump_classes`, not `classes`: provenance is spread into every docs
    // response and `docs_search` already returns a `classes` array of its own.
    dump_classes: api.status.classes,
  };
  if (api.status.versionSource === "legacy") {
    provenance.version_source = "legacy";
    provenance.hint =
      "Resolved through the frozen versionQTStudio endpoint, which serves an old " +
      "build with far fewer classes. A missing class here may still exist in Studio.";
  }
  if (api.status.stale) {
    provenance.stale = true;
    provenance.refresh_error = api.status.refreshError;
  }
  return { api, provenance };
}

/**
 * Order name matches so the obvious answer is first.
 *
 * Substring order alone buries the answer: searching "transparency" over the
 * real dump returns PlayerGui.GetTopbarTransparency and three of its neighbours
 * before BasePart.Transparency, which is the one anybody actually meant. Exact
 * beats prefix beats contains; shorter names break ties, since a longer name
 * containing the query is by definition a more specific thing.
 */
function matchRank(name: string, query: string): number {
  const n = name.toLowerCase();
  if (n === query) return 0;
  if (n.startsWith(query)) return 1;
  if (n.endsWith(query)) return 2;
  return 3;
}

/**
 * Extra ordering for member hits, applied after the name rank.
 *
 * Name rank alone is not enough, and the first version of this said it was. An
 * exact-match query like "size" or "anchored" makes every hit rank 0, and the
 * tiebreak then fell through to the dump's own order — so `BasePart.Anchored`
 * came fourth behind three import-data classes, and `BasePart.Size` came
 * twelfth. Two signals fix it:
 *
 *   Deprecated members go last. `Fire.size`, `BodyGyro.cframe` and
 *   `BodyVelocity.velocity` are lowercase aliases nobody wants, and they were
 *   outranking the real answer.
 *
 *   Then more descendants first. A property on `BasePart` is a property on
 *   hundreds of classes; the same name on `Fire` is a property on one.
 */
interface MemberHit {
  class: string;
  member: string;
  kind: string;
  type?: string;
  deprecated?: boolean;
  reach?: number;
}

function byRelevance<T>(
  items: T[],
  query: string,
  nameOf: (item: T) => string,
  extra?: (a: T, b: T) => number,
): T[] {
  return items
    .map((item, i) => ({ item, name: nameOf(item), i }))
    .sort((a, b) => {
      const ra = matchRank(a.name, query);
      const rb = matchRank(b.name, query);
      if (ra !== rb) return ra - rb;
      if (extra) {
        const e = extra(a.item, b.item);
        if (e !== 0) return e;
      }
      if (a.name.length !== b.name.length) return a.name.length - b.name.length;
      return a.i - b.i;
    })
    .map((e) => e.item);
}

const MEMBER_KINDS = ["all", "properties", "functions", "events"] as const;

function kindFilter(kind: unknown): (m: ResolvedMember) => boolean {
  switch (kind) {
    case "properties":
      return (m) => m.member.MemberType === "Property";
    case "functions":
      return (m) => m.member.MemberType === "Function";
    case "events":
      return (m) => m.member.MemberType === "Event" || m.member.MemberType === "Callback";
    default:
      return () => true;
  }
}

export const DOCS_TOOLS: ToolEntry[] = [
  localTool(
    {
      name: "docs_class",
      // Fetches the API dump on a cold cache AND writes it under the state dir.
      // Both, declared as both: saying only "network" while writing 1.4 MB makes
      // the field a lie to the next reader. `state: "cache"` is the server's own
      // copy of a public file, which is why it stays inspector-safe.
      effects: { state: "cache", network: "read" },
      category: "docs",
      subcategories: ["reference", "api", "lookup"],
      keywords: ["docs", "api", "class", "property", "properties", "method", "event", "reference", "schema", "what"],
      description:
        "List a class's real properties, methods and events from the Roblox API dump, with value types and whether each property is writable. Use before a mutate that sets an unfamiliar property, instead of guessing the name.",
      inputSchema: {
        type: "object",
        properties: {
          class: { type: "string", description: "Class name, e.g. 'PointLight'. Case-insensitive." },
          members: { type: "string", enum: [...MEMBER_KINDS], description: "Which members. Default 'properties'." },
          inherited: { type: "boolean", description: "Include inherited members. Default false." },
          filter: { type: "string", description: "Only members whose name contains this." },
          limit: { type: "number", description: "Max members returned (default 40, max 200)." },
        },
        required: ["class"],
      },
      outputSchema: objectResult({
        class: { type: "string" },
        superclasses: { type: "array", items: { type: "string" } },
        members: { type: "array" },
        total: { type: "number" },
        truncated: { type: "boolean" },
      }),
    },
    async (args) => {
      const { api, provenance } = await docs();
      const cls = api.getClass(args.class);
      if (!cls) {
        // A near-miss list beats "not found" — the usual cause is a typo or a
        // guess at a class that is named something else.
        const wanted = String(args.class ?? "").toLowerCase();
        const near = api.classNames().filter((n) => n.toLowerCase().includes(wanted)).slice(0, 10);
        return {
          error: "unknown_class",
          class: args.class,
          ...(near.length > 0 ? { did_you_mean: near } : {}),
          hint: "Use docs_search to find a class by partial name.",
          ...provenance,
        };
      }

      const inherited = args.inherited === true;
      const wantFilter = String(args.filter ?? "").toLowerCase();
      const all = api
        .members(cls.Name, { inherited })
        .filter(kindFilter(args.members ?? "properties"))
        .filter((m) => !wantFilter || m.member.Name.toLowerCase().includes(wantFilter));

      const limit = clampLimit(args.limit);
      const page = all.slice(0, limit);
      const chain = api.ancestry(cls.Name).slice(1).map((c) => c.Name);

      return {
        class: cls.Name,
        superclasses: chain,
        ...(cls.Tags?.length ? { tags: cls.Tags } : {}),
        members: page.map(summarize),
        total: all.length,
        ...(all.length > page.length ? { truncated: true } : {}),
        ...(!inherited && chain.length > 0
          ? { note: `Own members only. Pass inherited: true to include ${chain.join(" -> ")}.` }
          : {}),
        ...provenance,
      };
    },
  ),

  localTool(
    {
      name: "docs_member",
      // Fetches the API dump on a cold cache AND writes it under the state dir.
      // Both, declared as both: saying only "network" while writing 1.4 MB makes
      // the field a lie to the next reader. `state: "cache"` is the server's own
      // copy of a public file, which is why it stays inspector-safe.
      effects: { state: "cache", network: "read" },
      category: "docs",
      subcategories: ["reference", "api", "lookup"],
      keywords: ["docs", "api", "member", "property", "method", "signature", "parameters", "returns", "security"],
      description:
        "Look up one property, method or event in detail: value type, parameter list, return type, security level and which class in the inheritance chain declares it. Searches up the superclass chain.",
      inputSchema: {
        type: "object",
        properties: {
          class: { type: "string", description: "Class to search from, e.g. 'Part'." },
          member: { type: "string", description: "Member name, e.g. 'CFrame'. Case-insensitive." },
        },
        required: ["class", "member"],
      },
      outputSchema: objectResult({
        class: { type: "string" },
        member: { type: "object" },
        declared_on: { type: "string" },
        inherited: { type: "boolean" },
      }),
    },
    async (args) => {
      const { api, provenance } = await docs();
      const cls = api.getClass(args.class);
      if (!cls) return { error: "unknown_class", class: args.class, ...provenance };

      const found = api.findMember(cls.Name, args.member);
      if (!found) {
        const wanted = String(args.member ?? "").toLowerCase();
        const near = api
          .members(cls.Name, { inherited: true })
          .filter((m) => m.member.Name.toLowerCase().includes(wanted))
          .slice(0, 10)
          .map((m) => m.member.Name);
        return {
          error: "unknown_member",
          class: cls.Name,
          member: args.member,
          ...(near.length > 0 ? { did_you_mean: near } : {}),
          ...provenance,
        };
      }

      return {
        class: cls.Name,
        member: summarize(found),
        declared_on: found.declaredOn,
        inherited: found.inherited,
        ...(found.member.Serialization ? { serialization: found.member.Serialization } : {}),
        ...(found.member.ThreadSafety ? { thread_safety: found.member.ThreadSafety } : {}),
        ...provenance,
      };
    },
  ),

  localTool(
    {
      name: "docs_enum",
      // Fetches the API dump on a cold cache AND writes it under the state dir.
      // Both, declared as both: saying only "network" while writing 1.4 MB makes
      // the field a lie to the next reader. `state: "cache"` is the server's own
      // copy of a public file, which is why it stays inspector-safe.
      effects: { state: "cache", network: "read" },
      category: "docs",
      subcategories: ["reference", "api", "lookup"],
      keywords: ["docs", "enum", "material", "easing", "keycode", "values", "items", "options", "allowed"],
      description:
        "List the items of an Enum, or list the Enums whose name matches a filter. Use before setting any Enum-typed property so the value is a real member rather than a plausible-looking guess.",
      inputSchema: {
        type: "object",
        properties: {
          enum: { type: "string", description: "Enum name, e.g. 'Material'. Omit to list enum names." },
          filter: { type: "string", description: "Substring filter on names." },
          limit: { type: "number", description: "Max items returned (default 40, max 200)." },
        },
      },
      outputSchema: objectResult({
        enum: { type: "string" },
        items: { type: "array" },
        enums: { type: "array", items: { type: "string" } },
        total: { type: "number" },
        truncated: { type: "boolean" },
      }),
    },
    async (args) => {
      const { api, provenance } = await docs();
      const limit = clampLimit(args.limit);
      const filter = String(args.filter ?? "").toLowerCase();

      if (!args.enum) {
        const all = api.enumNames().filter((n) => !filter || n.toLowerCase().includes(filter));
        return {
          enums: all.slice(0, limit),
          total: all.length,
          ...(all.length > limit ? { truncated: true } : {}),
          ...provenance,
        };
      }

      const found = api.getEnum(args.enum);
      if (!found) {
        const wanted = String(args.enum).toLowerCase();
        const near = api.enumNames().filter((n) => n.toLowerCase().includes(wanted)).slice(0, 10);
        return {
          error: "unknown_enum",
          enum: args.enum,
          ...(near.length > 0 ? { did_you_mean: near } : {}),
          ...provenance,
        };
      }

      const items = found.Items.filter((i) => !filter || i.Name.toLowerCase().includes(filter));
      return {
        enum: found.Name,
        items: items.slice(0, limit),
        total: items.length,
        ...(items.length > limit ? { truncated: true } : {}),
        ...provenance,
      };
    },
  ),

  localTool(
    {
      name: "docs_search",
      // Fetches the API dump on a cold cache AND writes it under the state dir.
      // Both, declared as both: saying only "network" while writing 1.4 MB makes
      // the field a lie to the next reader. `state: "cache"` is the server's own
      // copy of a public file, which is why it stays inspector-safe.
      effects: { state: "cache", network: "read" },
      category: "docs",
      subcategories: ["reference", "api", "lookup"],
      keywords: ["docs", "search", "find", "api", "which", "class", "property", "enum", "lookup", "name"],
      description:
        "Find classes, members and enums by partial name across the whole API. Answers 'which class has a Transparency property' and 'what is the enum for easing' without knowing where to look first.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Substring to look for. Case-insensitive." },
          kind: { type: "string", enum: ["all", "classes", "members", "enums"], description: "Default 'all'." },
          limit: { type: "number", description: "Max hits per kind (default 40, max 200)." },
        },
        required: ["query"],
      },
      outputSchema: objectResult({
        classes: { type: "array", items: { type: "string" } },
        members: { type: "array" },
        enums: { type: "array", items: { type: "string" } },
        truncated: { type: "boolean" },
      }),
    },
    async (args) => {
      const { api, provenance } = await docs();
      const q = String(args.query ?? "").trim().toLowerCase();
      if (!q) return { error: "bad_args", hint: "docs_search needs a non-empty 'query'.", ...provenance };

      const limit = clampLimit(args.limit);
      const kind = args.kind ?? "all";
      const out: Record<string, unknown> = {};
      let truncated = false;

      if (kind === "all" || kind === "classes") {
        const hits = byRelevance(
          api.classNames().filter((n) => n.toLowerCase().includes(q)),
          q,
          (n) => n,
        );
        out.classes = hits.slice(0, limit);
        truncated ||= hits.length > limit;
      }
      if (kind === "all" || kind === "enums") {
        const hits = byRelevance(
          api.enumNames().filter((n) => n.toLowerCase().includes(q)),
          q,
          (n) => n,
        );
        out.enums = hits.slice(0, limit);
        truncated ||= hits.length > limit;
      }
      if (kind === "all" || kind === "members") {
        // Own members only. Searching the inherited closure would report
        // Transparency on several hundred classes and bury the useful answer.
        // The scan is over every class because ranking needs the whole set —
        // stopping at the limit would return the first matches, not the best.
        const hits: MemberHit[] = [];
        for (const cls of api.dump.Classes) {
          for (const m of cls.Members) {
            if (!m.Name.toLowerCase().includes(q)) continue;
            const deprecated = (m.Tags ?? []).includes("Deprecated");
            hits.push({
              class: cls.Name,
              member: m.Name,
              kind: m.MemberType,
              ...(m.ValueType ? { type: m.ValueType.Name } : {}),
              ...(deprecated ? { deprecated: true } : {}),
              reach: api.descendantCount(cls.Name),
            });
          }
        }
        const ranked = byRelevance(
          hits,
          q,
          (h) => h.member,
          (a, b) => {
            if (Boolean(a.deprecated) !== Boolean(b.deprecated)) return a.deprecated ? 1 : -1;
            return (b.reach ?? 0) - (a.reach ?? 0);
          },
        );
        // `reach` is a ranking input, not an answer. Don't spend response budget on it.
        out.members = ranked.slice(0, limit).map(({ reach, ...rest }) => rest);
        truncated ||= ranked.length > limit;
      }

      return { ...out, ...(truncated ? { truncated: true } : {}), ...provenance };
    },
  ),

  evalTool(
    {
      name: "docs_defaults",
      effects: { state: "cache", network: "read" },
      category: "docs",
      subcategories: ["reference", "api", "lookup"],
      keywords: ["docs", "default", "defaults", "initial", "value", "starting", "api", "property"],
      readOnly: "transient",
      description:
        "Read a class's default property values off a fresh Instance.new in Studio. The API dump carries types but no defaults, so this is the only honest source. The instance is never parented and is destroyed straight away.",
      inputSchema: {
        type: "object",
        properties: {
          class: { type: "string", description: "Class to instantiate, e.g. 'PointLight'." },
          properties: {
            type: "array",
            items: { type: "string" },
            description: "Property names. Omit for the class's own writable properties.",
          },
        },
        required: ["class"],
      },
      outputSchema: objectResult({ result: {} }),
    },
    async (args) => {
      // The dump has no defaults, but it DOES know which properties exist and
      // which are writable — so when the caller omits the list, fill it from
      // there rather than making Studio enumerate a class it may not recognise.
      let properties: string[] = Array.isArray(args?.properties)
        ? args.properties.filter((p: unknown) => typeof p === "string")
        : [];
      if (properties.length === 0) {
        const api = await getApiDocs();
        properties = api
          .members(String(args?.class ?? ""), { inherited: false })
          // Readable is what matters here, not writable — a default is worth
          // reporting even for a property you cannot set. But NotScriptable ones
          // throw on access, so they stay out.
          .filter((m) => m.member.MemberType === "Property")
          .filter((m) => !(m.member.Tags ?? []).includes("NotScriptable"))
          .filter((m) => {
            const read = m.member.Security;
            const level = !read ? "None" : typeof read === "string" ? read : read.Read;
            return level === "None" || level === "PluginSecurity";
          })
          .map((m) => m.member.Name);
      }
      return `
local a = __MCP.decode(${luaJson({ ...args, properties })})
local ok, inst = pcall(Instance.new, a.class)
if not ok or not inst then
  return { error = "not_creatable", class = a.class, message = tostring(inst), hint = "Services and abstract classes cannot be constructed. Read an existing instance instead." }
end
local names = a.properties
if type(names) ~= "table" or #names == 0 then
  inst:Destroy()
  return { error = "bad_args", hint = "Pass 'properties'; the server fills it from the API dump when you omit it." }
end
local defaults, unreadable = {}, {}
for _, name in ipairs(names) do
  local okRead, value = pcall(function() return inst[name] end)
  if okRead then defaults[name] = __MCP.serialize(value) else table.insert(unreadable, name) end
end
inst:Destroy()
return { class = a.class, defaults = defaults, unreadable = unreadable }
`;
    },
  ),
];
