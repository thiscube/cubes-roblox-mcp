/**
 * The `__MCP` contract.
 *
 * Every generated Luau template calls into a `__MCP` helper table that the Studio
 * plugin injects into the eval sandbox. That table was used 83 times across this
 * repo and declared in exactly zero places (ARCHITECTURE-REVIEW.md A1) — so
 * renaming a helper meant grepping 33 template literals with nothing to catch a
 * miss, and the drift was already real: `run_code`'s description advertised ten
 * helpers while the templates exercised six.
 *
 * This file is the single declaration. It does not execute anything; it exists so
 * that (a) there is one place to read the contract, and (b) a test can assert that
 * no template calls a helper that isn't declared, and that the surface advertised
 * to the model matches the surface that actually exists.
 *
 * Keep this in lockstep with the plugin's `__MCP` builder. When the plugin gains
 * or renames a helper, change it here in the same commit and bump the protocol.
 */

export interface McpHelper {
  /** Helper name as called: `__MCP.<name>`. */
  name: string;
  /** Signature, in the form used in the run_code tool description. */
  signature: string;
  /** What it does, one line. */
  summary: string;
  /**
   * True when the server's own generated templates call it. A helper that is
   * advertised but never exercised anywhere in this repo is unverifiable from
   * here — the flag makes that explicit rather than silent.
   */
  exercisedByTemplates: boolean;
}

export const MCP_API: readonly McpHelper[] = [
  {
    name: "refFor",
    signature: "refFor(inst)",
    summary: "Mint a short session ref token for an Instance.",
    exercisedByTemplates: true,
  },
  {
    name: "resolve",
    signature: "resolve(refOrPath)",
    summary: "Resolve a ref token or dotted path to an Instance, or nil.",
    exercisedByTemplates: true,
  },
  {
    name: "query",
    signature: "query(selector)",
    summary: "Run a selector across the tree and return matching Instances.",
    exercisedByTemplates: true,
  },
  {
    name: "decode",
    signature: "decode(json)",
    summary: "JSONDecode a string into a Luau table. How tool args arrive.",
    exercisedByTemplates: true,
  },
  {
    name: "diagnostics",
    signature: "diagnostics(n)",
    summary: "Recent captured errors/warnings plus run mode and totals.",
    exercisedByTemplates: true,
  },
  {
    name: "waypoint",
    signature: "waypoint(name, fn)",
    summary: "Run fn inside one ChangeHistoryService recording (atomic undo).",
    exercisedByTemplates: true,
  },
  {
    name: "read",
    signature: "read(args)",
    summary: "The read tool, callable from inside eval.",
    exercisedByTemplates: false,
  },
  {
    name: "mutate",
    signature: "mutate(args)",
    summary: "The mutate tool, callable from inside eval.",
    exercisedByTemplates: false,
  },
  {
    name: "serialize",
    signature: "serialize(value)",
    summary: "Convert a Luau value into the JSON-safe envelope the server expects.",
    exercisedByTemplates: true,
  },
  {
    name: "viewport",
    signature: "viewport(limit)",
    summary: "Camera state plus on-screen instances with projected 2D bounds.",
    exercisedByTemplates: false,
  },
];

/** Declared helper names, for validation. */
export const MCP_API_NAMES: ReadonlySet<string> = new Set(MCP_API.map((h) => h.name));

/** The surface advertised to the model in the run_code description. */
export function mcpApiSignatureList(): string {
  return MCP_API.map((h) => h.signature).join(", ");
}
