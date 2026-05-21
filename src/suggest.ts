/**
 * Suggested next call.
 *
 * Successful tool responses (excluding snapshot no-ops) carry at most one
 * `next_likely` hint — non-binding, the agent can act on it or ignore it. The
 * goal is to nudge the agent in sensible directions (verify a write, page through
 * results, test a script change) without it having to rediscover the obvious
 * next step each turn. The server caps to 1 entry; this module ranks candidates.
 */

export interface NextLikely {
  call: string;
  args?: Record<string, unknown>;
  reason: string;
}

export function suggestNext(tool: string, _args: unknown, payload: unknown): NextLikely[] {
  if (!payload || typeof payload !== "object") return [];
  const p = payload as Record<string, any>;
  if (p.error) return [];

  const out: NextLikely[] = [];

  switch (tool) {
    case "search_tools": {
      const first = p.unlocked?.[0];
      if (first) {
        out.push({
          call: first.name,
          reason: `top match — ${String(first.description ?? "").slice(0, 70)}`,
        });
      }
      break;
    }

    case "read": {
      if (p.cursor) {
        out.push({ call: "read", args: { cursor: p.cursor }, reason: "next page of results" });
      }
      const items: any[] = Array.isArray(p.items) ? p.items : [];
      const script = items.find((i) => typeof i?.class === "string" && /Script$/.test(i.class));
      if (script && !script.props?.Source) {
        out.push({
          call: "read",
          args: { ref: script.ref, select: ["Source"] },
          reason: `read the source of ${script.name}`,
        });
      }
      break;
    }

    case "mutate": {
      const changes: any[] = Array.isArray(p.changes) ? p.changes : [];
      const firstRef = changes.map((c) => c?.ref).find(Boolean);
      if (firstRef) {
        out.push({
          call: "read",
          args: { ref: firstRef, format: "full" },
          reason: "verify the change landed as expected",
        });
      }
      const wroteScript = changes.some(
        (c) =>
          (Array.isArray(c?.modified) && c.modified.includes("Source")) ||
          (c?.op === "create" && typeof c?.class === "string" && /Script$/.test(c.class)),
      );
      if (wroteScript) {
        out.push({ call: "run_code", reason: "playtest / smoke-test the script change" });
      }
      const lintErrors =
        Array.isArray(p.lint) && p.lint.some((l: any) => (l?.errorCount ?? 0) > 0);
      if (lintErrors) {
        out.push({ call: "mutate", reason: "fix the lint errors reported under `lint` first" });
      }
      break;
    }

    case "macro_save":
      if (p.saved) {
        out.push({
          call: "macro_run",
          args: { name: p.saved },
          reason: "replay the macro you just saved",
        });
      }
      break;

    case "run_code":
      // After arbitrary Luau, a read is the usual way to confirm the effect.
      out.push({ call: "read", reason: "read back the part of the tree you just touched" });
      break;
  }

  // Caller (server.ts) currently caps to 1; we return up to 3 candidates so the
  // cap can be tuned without changing this module. The first item is the best
  // single suggestion.
  return out.slice(0, 3);
}
