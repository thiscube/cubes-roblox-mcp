import { type ToolEntry, evalTool, luaJson } from "../registry.js";
import { diffSnapshots } from "../snapshot-diff.js";
import type { SnapshotInstance } from "../memory.js";
import { applyPatch, loadProfile, saveProfile, type ProfilePatch } from "../profile.js";

/**
 * Server-side memory: profiles, macros, snapshots, undo.
 *
 * One file per Category value — the registry's own taxonomy names the file,
 * so there is never a question of where a new tool goes (A6).
 */

export const SESSION_TOOLS: ToolEntry[] = [
  {
    name: "profile_update",
    channel: "local",
    category: "session",
    subcategories: ["memory", "profile", "decision", "convention"],
    keywords: [
      "profile",
      "remember",
      "memory",
      "decision",
      "convention",
      "style",
      "genre",
      "save",
      "note",
      "context",
      "persist",
      "learn",
    ],
    description:
      "Upsert the per-place profile (~/.cubesmcp/profiles/{placeId}.json). genre/placeName/style/structure shallow-merge; decision/knownIssue/sessionSummary append. Record conventions and style calls here so the next session starts with them.",
    inputSchema: {
      type: "object",
      properties: {
        genre: {
          type: "string",
          description:
            "Detected genre: obby, simulator, rpg, racing, tower_defense, casual_sim, social, experimental, unknown.",
        },
        placeName: { type: "string", description: "Set/replace the place name." },
        style: {
          type: "object",
          description:
            "Shallow-merged into profile.style. Keys: palette[], materials[], naming, notes.",
        },
        structure: {
          type: "object",
          description:
            "Shallow-merge into profile.structure. Free-form key/value (e.g. modelRoot='Workspace.Entities').",
        },
        decision: {
          type: "object",
          description: "Append to decisions log. { topic, choice }.",
          properties: {
            topic: { type: "string" },
            choice: { type: "string" },
          },
          required: ["topic", "choice"],
        },
        knownIssue: { type: "string", description: "Append to knownIssues." },
        sessionSummary: {
          type: "object",
          description:
            "Append to sessionLog. { session, summary }. Use at the end of a session to leave breadcrumbs for next time.",
          properties: {
            session: { type: "string" },
            summary: { type: "string" },
          },
          required: ["session", "summary"],
        },
      },
    },
    handler: async (args, ctx) => {
      const ctxData = await ctx.getPlaceContext();
      const profile = await loadProfile(ctxData.placeId, ctxData.placeName);
      const patch: ProfilePatch = {
        genre: typeof args.genre === "string" ? args.genre : undefined,
        placeName: typeof args.placeName === "string" ? args.placeName : undefined,
        style:
          args.style && typeof args.style === "object"
            ? (args.style as ProfilePatch["style"])
            : undefined,
        structure:
          args.structure && typeof args.structure === "object"
            ? (args.structure as ProfilePatch["structure"])
            : undefined,
        decision:
          args.decision && typeof args.decision === "object"
            ? (args.decision as ProfilePatch["decision"])
            : undefined,
        knownIssue:
          typeof args.knownIssue === "string" ? args.knownIssue : undefined,
        sessionSummary:
          args.sessionSummary && typeof args.sessionSummary === "object"
            ? (args.sessionSummary as ProfilePatch["sessionSummary"])
            : undefined,
      };
      applyPatch(profile, patch);
      await saveProfile(profile);
      return {
        ok: true,
        placeId: profile.placeId,
        updatedAt: profile.updatedAt,
        decisionsCount: profile.decisions.length,
        sessionLogCount: profile.sessionLog.length,
        hint: "Read studio://project/profile to see the updated profile.",
      };
    },
  },
  {
    name: "macro_save",
    channel: "local",
    category: "session",
    subcategories: ["macro", "record"],
    keywords: ["macro", "record", "save", "sequence", "replay", "reuse", "automate", "memory"],
    description:
      "Save a reusable macro. Either captures the mutate ops from the last N history entries (from_last) or takes an explicit ops array. Replay with macro_run. Note: only direct `mutate` ops are captured, not specialist-tool calls.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Macro name." },
        from_last: {
          type: "number",
          description: "Capture mutate ops from the last N history entries (default 10).",
        },
        ops: {
          type: "array",
          items: { type: "object" },
          description: "Explicit ops to save (alternative to from_last).",
        },
      },
      required: ["name"],
    },
    handler: async (args, ctx) => {
      const name = String(args.name ?? "").trim();
      if (!name) return { error: "bad_args", hint: "macro_save needs a 'name'." };
      const ops = Array.isArray(args.ops)
        ? (args.ops as unknown[])
        : ctx.memory.opsFromHistory(typeof args.from_last === "number" ? args.from_last : 10);
      if (ops.length === 0) {
        return {
          error: "empty_macro",
          hint: "No mutate ops to save — pass `ops` explicitly, or run some mutate calls first then use from_last.",
        };
      }
      const macro = ctx.memory.saveMacro(name, ops);
      return { saved: macro.name, opCount: macro.opCount, hint: `Replay with macro_run({ name: "${name}" }).` };
    },
  },
  {
    name: "macro_run",
    channel: "mutate",
    category: "session",
    subcategories: ["macro", "replay"],
    keywords: ["macro", "run", "replay", "execute", "repeat", "reuse", "memory"],
    description:
      "Replay a saved macro — re-submits its ops as one atomic mutate batch (single undo waypoint). Lint results come back under the nested mutate result, same as a normal mutate.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Macro name to run." },
        confirm: {
          type: "boolean",
          description:
            "Required when the macro's ops are destructive. Forwarded to the mutate pipeline.",
        },
      },
      required: ["name"],
    },
    handler: async (args, ctx) => {
      const name = String(args.name ?? "").trim();
      const macro = ctx.memory.getMacro(name);
      if (!macro) {
        return {
          error: "macro_not_found",
          name,
          hint: "Check the studio://session/macros resource.",
        };
      }
      // Route through handleMutate so the macro's ops hit the same
      // destructiveness gate + script-source lint as a normal mutate call.
      // Calling bridge.send("mutate", ...) directly would let a saved macro with
      // a delete op or Source overwrite execute without confirm: true.
      const result = await ctx.handleMutate({ ops: macro.ops, confirm: args.confirm === true });
      return { ran: name, opCount: macro.opCount, result };
    },
  },
  evalTool(
    {
      name: "history_undo",
      category: "session",
      subcategories: ["undo", "history", "revert"],
      keywords: ["undo", "revert", "rollback", "back", "reverse", "oops", "mistake", "wrong"],
      description:
        "Undo the last N ChangeHistoryService waypoints. Every MCP mutate call creates its own named waypoint, so this reliably reverses MCP-driven changes. n defaults to 1.",
      inputSchema: {
        type: "object",
        properties: {
          n: { type: "number", description: "Number of waypoints to undo (default 1, max 20)." },
        },
      },
    },
    (args) => `
local a = __MCP.decode(${luaJson(args)})
local n = math.min(math.max(tonumber(a.n) or 1, 1), 20)
local CHS = game:GetService("ChangeHistoryService")
local undone = 0
for _ = 1, n do
  local ok = pcall(function() CHS:Undo() end)
  if ok then undone += 1 else break end
end
return { undone = undone, requested = n }
`,
  ),
  {
    name: "snapshot",
    // Dispatches a `snapshot` command to the plugin, so the channel is dispatch,
    // not local. It only reads the DataModel, hence the explicit opt-out.
    channel: "dispatch",
    readOnly: true,
    category: "session",
    subcategories: ["version-control", "capture", "checkpoint"],
    keywords: [
      "snapshot",
      "capture",
      "checkpoint",
      "save state",
      "baseline",
      "version",
      "before",
      "record state",
    ],
    description:
      "Capture a subtree's state (stable identity, ClassName, projected properties) server-side under `name`. Returns a small summary, NOT the tree. Pair with `diff` to see what changed later. Held in bounded session memory; oldest is dropped.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Key to store this snapshot under. Re-using a name overwrites it.",
        },
        path: {
          type: "string",
          description:
            "Subtree root: a ref or dotted path. Required, because capturing the whole DataModel is too heavy to default to.",
        },
      },
      required: ["name", "path"],
    },
    handler: async (args, ctx) => {
      const name = String(args.name ?? "").trim();
      if (!name) return { error: "bad_args", hint: "snapshot needs a non-empty 'name'." };
      const path = String(args.path ?? "").trim();
      if (!path) {
        return {
          error: "bad_args",
          hint: "snapshot needs a 'path' (a ref or dotted path). Capturing the whole DataModel is not supported — pick a subtree, e.g. 'Workspace'.",
        };
      }
      const capture = (await ctx.bridge.send("snapshot", { path })) as
        | {
            path?: string;
            instances?: SnapshotInstance[];
            instanceCount?: number;
            truncated?: boolean;
            capLimit?: number;
          }
        | undefined;
      if (capture && typeof capture === "object" && "error" in capture) {
        return capture;
      }
      const instances = Array.isArray(capture?.instances) ? capture!.instances : [];
      const truncated = capture?.truncated === true;
      const stored = ctx.memory.saveSnapshot(name, {
        path: capture?.path ?? path,
        instances,
        truncated,
      });
      return {
        name: stored.name,
        path: stored.path,
        instanceCount: stored.instanceCount,
        capturedAt: stored.capturedAt,
        ...(truncated
          ? {
              truncated: true,
              note: `Subtree exceeded the ${capture?.capLimit ?? "capture"} instance cap — snapshot is partial. Snapshot a smaller subtree for a complete capture.`,
            }
          : {}),
        hint: `Compare later with diff({ from: "${name}", to: "live" }), or against another snapshot.`,
      };
    },
  },
  {
    name: "diff",
    // Dispatches a `snapshot` command to the plugin, so the channel is dispatch,
    // not local. It only reads the DataModel, hence the explicit opt-out.
    channel: "dispatch",
    readOnly: true,
    category: "session",
    subcategories: ["version-control", "compare", "delta"],
    keywords: [
      "diff",
      "compare",
      "delta",
      "changed",
      "what changed",
      "difference",
      "drift",
      "since",
      "version",
    ],
    description:
      "Compare two snapshots and return only the delta: { added, removed, changed }. `from` and `to` are snapshot names; `to` may be the literal 'live' to diff against a fresh capture at `from`'s path. Never returns full trees.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Baseline snapshot name." },
        to: {
          type: "string",
          description:
            "Later snapshot name, or 'live' to capture at `from`'s path now and diff against that.",
        },
      },
      required: ["from", "to"],
    },
    handler: async (args, ctx) => {
      const fromName = String(args.from ?? "").trim();
      const toArg = String(args.to ?? "").trim();
      if (!fromName || !toArg) {
        return { error: "bad_args", hint: "diff needs 'from' and 'to'." };
      }
      const fromSnap = ctx.memory.getSnapshot(fromName);
      if (!fromSnap) {
        return {
          error: "snapshot_not_found",
          name: fromName,
          hint: "Take it first with snapshot(), or check the studio://session/snapshots resource.",
        };
      }

      let toInstances: SnapshotInstance[];
      let toLabel: string;
      let liveTruncated = false;
      if (toArg === "live") {
        // Fresh capture at the baseline's path — no need to store it.
        const capture = (await ctx.bridge.send("snapshot", { path: fromSnap.path })) as
          | { instances?: SnapshotInstance[]; truncated?: boolean }
          | undefined;
        if (capture && typeof capture === "object" && "error" in capture) {
          return capture;
        }
        toInstances = Array.isArray(capture?.instances) ? capture!.instances : [];
        liveTruncated = capture?.truncated === true;
        toLabel = `live@${fromSnap.path}`;
      } else {
        const toSnap = ctx.memory.getSnapshot(toArg);
        if (!toSnap) {
          return {
            error: "snapshot_not_found",
            name: toArg,
            hint: "Pass an existing snapshot name, or the literal 'live'.",
          };
        }
        toInstances = toSnap.instances;
        toLabel = toSnap.name;
      }

      const delta = diffSnapshots(fromSnap.instances, toInstances);
      return {
        from: fromSnap.name,
        to: toLabel,
        path: fromSnap.path,
        added: delta.added,
        removed: delta.removed,
        changed: delta.changed,
        summary: {
          added: delta.added.length,
          removed: delta.removed.length,
          changed: delta.changed.length,
        },
        ...(fromSnap.truncated || liveTruncated
          ? { partial: true, note: "One side of the diff was a truncated capture — the delta may be incomplete." }
          : {}),
      };
    },
  },
];
