/**
 * The Roblox engine API reference (PLAN.md #4).
 *
 * WHY THIS EXISTS
 * ---------------
 * Without it the agent guesses property names, value types and enum members,
 * gets them wrong, and burns a turn on a failed `mutate`. Every one of those
 * round trips costs a Studio call and a model turn. A local copy of the API dump
 * turns most of them into a zero-cost lookup.
 *
 * WHERE THE DATA COMES FROM
 * -------------------------
 * Roblox publishes the dump for the current Studio build:
 *
 *   https://setup.rbxcdn.com/versionQTStudio          -> version hash
 *   https://setup.rbxcdn.com/{hash}-API-Dump.json     -> ~4 MB of JSON
 *
 * That is the official first-party source, not a community mirror, and it is the
 * *Studio* dump, so it describes the surface the plugin actually has.
 *
 * WHAT THE DUMP DOES NOT CONTAIN
 * ------------------------------
 * Default property values. A member record carries Name, MemberType, ValueType,
 * Category, Security, Tags, ThreadSafety, Parameters, ReturnType and
 * Serialization, and nothing else. So `docs_class` can tell you `Part.Anchored`
 * is a bool you are allowed to write, but not that it starts false. Defaults
 * come from `docs_defaults`, which reads them off a real `Instance.new(Class)`
 * inside Studio. Two sources, labelled, rather than one source that quietly
 * makes things up.
 *
 * OFFLINE AND STALE BEHAVIOUR
 * ---------------------------
 * The dump is cached at `$CUBES_MCP_HOME/api-dump.json` (default `~/.cubesmcp`)
 * with a 24h TTL. A failed
 * refresh falls back to the cached copy however old it is, and says so in the
 * response, because a day-old property list is worth far more than an error.
 */

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";

import { apiDumpFile } from "./paths.js";

const VERSION_URL = "https://setup.rbxcdn.com/versionQTStudio";
const DUMP_URL = (version: string) => `https://setup.rbxcdn.com/${version}-API-Dump.json`;
const TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 60_000;
/** A dump under this is truncated or an error page, not a dump. */
const MIN_PLAUSIBLE_BYTES = 500_000;

export interface ApiValueType {
  Category: string;
  Name: string;
}

export interface ApiParameter {
  Name: string;
  Type: ApiValueType;
  Default?: string;
}

export interface ApiMember {
  Name: string;
  MemberType: "Property" | "Function" | "Event" | "Callback" | string;
  Category?: string;
  Security?: string | { Read: string; Write: string };
  Tags?: string[];
  ThreadSafety?: string;
  ValueType?: ApiValueType;
  Parameters?: ApiParameter[];
  ReturnType?: ApiValueType;
  Serialization?: { CanLoad: boolean; CanSave: boolean };
}

export interface ApiClass {
  Name: string;
  Superclass: string;
  MemoryCategory?: string;
  Tags?: string[];
  Members: ApiMember[];
}

export interface ApiEnum {
  Name: string;
  Items: { Name: string; Value: number }[];
}

export interface ApiDump {
  Version: number;
  Classes: ApiClass[];
  Enums: ApiEnum[];
}

interface CacheFile {
  fetchedAt: number;
  studioVersion: string;
  dump: ApiDump;
}

/** Where a member was declared, when it was found by walking the superclass chain. */
export interface ResolvedMember {
  member: ApiMember;
  declaredOn: string;
  inherited: boolean;
}

export interface DocsStatus {
  studioVersion: string;
  fetchedAt: number;
  ageHours: number;
  stale: boolean;
  classes: number;
  enums: number;
  /** Set when a refresh was attempted and failed, so the caller can say so. */
  refreshError?: string;
}

function isDump(value: unknown): value is ApiDump {
  const d = value as ApiDump;
  return Boolean(d && Array.isArray(d.Classes) && Array.isArray(d.Enums) && d.Classes.length > 0);
}

/**
 * The API dump, indexed for lookup.
 *
 * One instance per process, built lazily on first use so a session that never
 * asks a documentation question never pays for the download.
 */
export class ApiDocs {
  private readonly byClass = new Map<string, ApiClass>();
  private readonly byEnum = new Map<string, ApiEnum>();
  /** Lowercased class name -> real name, so lookups are case-insensitive. */
  private readonly classAlias = new Map<string, string>();
  private readonly enumAlias = new Map<string, string>();
  /** Lazily built in descendantCount(). */
  private descendants: Map<string, number> | null = null;

  private constructor(
    readonly dump: ApiDump,
    readonly status: DocsStatus,
  ) {
    for (const c of dump.Classes) {
      this.byClass.set(c.Name, c);
      this.classAlias.set(c.Name.toLowerCase(), c.Name);
    }
    for (const e of dump.Enums) {
      this.byEnum.set(e.Name, e);
      this.enumAlias.set(e.Name.toLowerCase(), e.Name);
    }
  }

  static fromDump(dump: ApiDump, status?: Partial<DocsStatus>): ApiDocs {
    return new ApiDocs(dump, {
      studioVersion: "test",
      fetchedAt: Date.now(),
      ageHours: 0,
      stale: false,
      classes: dump.Classes.length,
      enums: dump.Enums.length,
      ...status,
    });
  }

  getClass(name: string): ApiClass | undefined {
    const real = this.classAlias.get(String(name ?? "").toLowerCase());
    return real ? this.byClass.get(real) : undefined;
  }

  getEnum(name: string): ApiEnum | undefined {
    const real = this.enumAlias.get(String(name ?? "").toLowerCase());
    return real ? this.byEnum.get(real) : undefined;
  }

  /** The class and every superclass, most-derived first, stopping at the root. */
  ancestry(name: string): ApiClass[] {
    const chain: ApiClass[] = [];
    let current = this.getClass(name);
    const seen = new Set<string>();
    while (current && !seen.has(current.Name)) {
      seen.add(current.Name);
      chain.push(current);
      if (!current.Superclass || current.Superclass === "<<<ROOT>>>") break;
      current = this.byClass.get(current.Superclass);
    }
    return chain;
  }

  /**
   * Members of a class, optionally including everything it inherits.
   *
   * A derived class may redeclare a member; the most-derived declaration wins,
   * which is what Studio does.
   */
  members(name: string, opts: { inherited?: boolean } = {}): ResolvedMember[] {
    const chain = opts.inherited ? this.ancestry(name) : this.ancestry(name).slice(0, 1);
    const out = new Map<string, ResolvedMember>();
    chain.forEach((cls, depth) => {
      for (const member of cls.Members) {
        if (out.has(member.Name)) continue; // most-derived wins
        out.set(member.Name, { member, declaredOn: cls.Name, inherited: depth > 0 });
      }
    });
    return [...out.values()];
  }

  /** One member by name, searched up the superclass chain. Case-insensitive. */
  findMember(className: string, memberName: string): ResolvedMember | undefined {
    const wanted = String(memberName ?? "").toLowerCase();
    return this.members(className, { inherited: true }).find(
      (m) => m.member.Name.toLowerCase() === wanted,
    );
  }

  classNames(): string[] {
    return [...this.byClass.keys()];
  }

  /**
   * How many classes descend from this one, transitively.
   *
   * The cheapest signal for "this is the class everybody means". Searching
   * "size" matches a property on fifty classes; `BasePart` has hundreds of
   * descendants and `Fire` has none, and that difference is what puts the right
   * answer first. Computed once, on demand, from the Superclass edges.
   */
  descendantCount(name: string): number {
    if (!this.descendants) {
      const direct = new Map<string, string[]>();
      for (const c of this.dump.Classes) {
        const list = direct.get(c.Superclass);
        if (list) list.push(c.Name);
        else direct.set(c.Superclass, [c.Name]);
      }
      this.descendants = new Map();
      for (const c of this.dump.Classes) {
        let total = 0;
        const stack = [...(direct.get(c.Name) ?? [])];
        const seen = new Set<string>([c.Name]);
        while (stack.length > 0) {
          const next = stack.pop() as string;
          if (seen.has(next)) continue;
          seen.add(next);
          total += 1;
          stack.push(...(direct.get(next) ?? []));
        }
        this.descendants.set(c.Name, total);
      }
    }
    return this.descendants.get(name) ?? 0;
  }

  enumNames(): string[] {
    return [...this.byEnum.keys()];
  }
}

// --------------------------------------------------------------------------
// Loading
// --------------------------------------------------------------------------

async function readCache(): Promise<CacheFile | null> {
  try {
    const parsed = JSON.parse(await readFile(apiDumpFile(), "utf8")) as CacheFile;
    return isDump(parsed?.dump) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeCache(entry: CacheFile): Promise<void> {
  const file = apiDumpFile();
  await mkdir(dirname(file), { recursive: true });
  // Write-then-rename: a crash mid-write must not leave a truncated dump behind
  // that then fails to parse on every subsequent start.
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(entry), "utf8");
  await rename(tmp, file);
}

async function getText(url: string, timeoutMs: number): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Download the dump for the current Studio build. */
export async function fetchDump(
  fetchTimeoutMs = FETCH_TIMEOUT_MS,
): Promise<{ dump: ApiDump; studioVersion: string }> {
  const studioVersion = (await getText(VERSION_URL, 15_000)).trim();
  if (!/^version-[0-9a-f]+$/i.test(studioVersion)) {
    throw new Error(`unexpected Studio version string: ${studioVersion.slice(0, 40)}`);
  }
  const body = await getText(DUMP_URL(studioVersion), fetchTimeoutMs);
  if (body.length < MIN_PLAUSIBLE_BYTES) {
    throw new Error(`API dump was only ${body.length} bytes — refusing to cache it`);
  }
  const dump = JSON.parse(body) as ApiDump;
  if (!isDump(dump)) throw new Error("API dump did not parse into Classes/Enums");
  return { dump, studioVersion };
}

let inFlight: Promise<ApiDocs> | null = null;
let loaded: ApiDocs | null = null;

/**
 * The process-wide docs instance.
 *
 * Cache first, network only when the cache is missing or older than the TTL, and
 * a failed refresh still serves the stale copy rather than failing the call.
 */
export async function getApiDocs(opts: { forceRefresh?: boolean } = {}): Promise<ApiDocs> {
  if (loaded && !opts.forceRefresh) return loaded;
  if (inFlight && !opts.forceRefresh) return inFlight;

  inFlight = (async () => {
    const cached = await readCache();
    // CI and unit tests must never reach the network. With no cache to fall back
    // on this is a hard error rather than a silent empty dump, so a missing
    // fixture shows up as a failure instead of as "this class has no members".
    if (process.env.CUBES_MCP_OFFLINE === "1") {
      if (!cached) throw new Error("CUBES_MCP_OFFLINE=1 and no cached API dump at " + apiDumpFile());
      const age = Date.now() - cached.fetchedAt;
      return ApiDocs.fromDump(cached.dump, {
        studioVersion: cached.studioVersion,
        fetchedAt: cached.fetchedAt,
        ageHours: Math.round(age / 3_600_000),
        stale: age >= TTL_MS,
        classes: cached.dump.Classes.length,
        enums: cached.dump.Enums.length,
      });
    }
    const ageMs = cached ? Date.now() - cached.fetchedAt : Infinity;
    if (cached && ageMs < TTL_MS && !opts.forceRefresh) {
      return ApiDocs.fromDump(cached.dump, {
        studioVersion: cached.studioVersion,
        fetchedAt: cached.fetchedAt,
        ageHours: Math.round(ageMs / 3_600_000),
        stale: false,
        classes: cached.dump.Classes.length,
        enums: cached.dump.Enums.length,
      });
    }

    try {
      const { dump, studioVersion } = await fetchDump();
      const entry: CacheFile = { fetchedAt: Date.now(), studioVersion, dump };
      await writeCache(entry).catch(() => {
        // A read-only home directory is not a reason to fail the lookup.
      });
      return ApiDocs.fromDump(dump, {
        studioVersion,
        fetchedAt: entry.fetchedAt,
        ageHours: 0,
        stale: false,
        classes: dump.Classes.length,
        enums: dump.Enums.length,
      });
    } catch (err) {
      if (!cached) throw err;
      // Stale beats nothing. A property list from yesterday is still right about
      // almost everything, and the response says how old it is.
      return ApiDocs.fromDump(cached.dump, {
        studioVersion: cached.studioVersion,
        fetchedAt: cached.fetchedAt,
        ageHours: Math.round(ageMs / 3_600_000),
        stale: true,
        classes: cached.dump.Classes.length,
        enums: cached.dump.Enums.length,
        refreshError: err instanceof Error ? err.message : String(err),
      });
    }
  })()
    .then((docs) => {
      loaded = docs;
      return docs;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/** Test seam: install a dump without touching the network or the disk. */
export function __setApiDocsForTest(docs: ApiDocs | null): void {
  loaded = docs;
  inFlight = null;
}
