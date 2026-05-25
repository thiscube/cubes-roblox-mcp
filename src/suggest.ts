/**
 * Suggested next call.
 *
 * Successful tool responses (excluding snapshot no-ops) carry up to 3
 * `next_likely` hints — non-binding, the agent can act on them or ignore. The
 * goal is to nudge the agent in sensible directions (verify a write, screenshot
 * to confirm visually, snapshot for rollback, test a script change) without it
 * having to rediscover the obvious next steps each turn.
 *
 * Suggestions are RANKED: the first entry is the highest-priority next step,
 * the rest are alternates. The server's `next_likely` cap (currently 3) trims
 * the tail.
 *
 * Whenever possible suggestions include `args` already wired to the relevant
 * ref/path so the agent can copy the body directly — closer to "one-click
 * follow-up" than "name of the next tool to call."
 */

export interface NextLikely {
  call: string;
  args?: Record<string, unknown>;
  reason: string;
}

/** Class-name suffixes that read as "visual" — once one of these is touched, a screenshot is a sensible next step. */
const VISUAL_CLASS_RE =
  /^(Part|MeshPart|UnionOperation|NegateOperation|TrussPart|WedgePart|CornerWedgePart|Decal|Texture|Beam|Trail|ParticleEmitter|Model|Folder)$/;

function isVisualChange(change: { class?: string; op?: string; modified?: string[] }): boolean {
  if (change.op === "create" && change.class && VISUAL_CLASS_RE.test(change.class)) return true;
  if (change.op === "set" && Array.isArray(change.modified)) {
    return change.modified.some((m) =>
      ["Position", "Size", "Color", "Material", "Transparency", "CFrame", "Orientation"].includes(m),
    );
  }
  return false;
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
      // If the read returned a viewport bundle, a real screenshot is usually
      // the very next thing the agent wants — bboxes confirm positions but
      // can't confirm "does it look right."
      if (p.camera && Array.isArray(p.instances)) {
        out.push({
          call: "screenshot",
          args: { region: "viewport" },
          reason: "see the scene you just sampled with bboxes",
        });
      }
      // Visual instances in the result + no error → suggest a screenshot.
      const visualHit = items.find((i) => typeof i?.class === "string" && VISUAL_CLASS_RE.test(i.class));
      if (visualHit && !p.camera) {
        out.push({
          call: "screenshot",
          args: { region: "viewport" },
          reason: "see the visual instance(s) you just read",
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
      // Visual change → a screenshot confirms it the way the agent's bbox
      // imagination can't. High-leverage especially after creating/repositioning
      // BaseParts, Models, Decals, particles, etc.
      if (changes.some(isVisualChange)) {
        out.push({
          call: "screenshot",
          args: { region: "viewport" },
          reason: "see the result of the change in the viewport",
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
      // Big batch → recommend snapshotting for cheap rollback.
      if (changes.length >= 5) {
        out.push({
          call: "snapshot",
          args: { path: "Workspace" },
          reason: "checkpoint after a big change so you can diff/rollback later",
        });
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

    case "run_code": {
      // After arbitrary Luau, a read is the usual way to confirm the effect.
      out.push({ call: "read", reason: "read back the part of the tree you just touched" });
      // If the result mentions a ref or path (common pattern: `return { ref = __MCP.refFor(x) }`),
      // suggest a screenshot — Luau is often used for batch creates that benefit from visual confirmation.
      const r = p.result;
      if (r && typeof r === "object" && (r.ref || r.path)) {
        out.push({
          call: "screenshot",
          args: { region: "viewport" },
          reason: "see the result of the script in the viewport",
        });
      }
      break;
    }

    case "screenshot":
      // After a visual capture, the obvious follow-up is camera_set if the
      // shot was framed wrong, or a mutate if the shot revealed an issue.
      // The agent reads the image itself — it knows which.
      out.push({
        call: "camera_set",
        reason: "reposition the camera for a better angle if the framing is off",
      });
      break;

    case "snapshot":
      out.push({
        call: "diff",
        args: { from: p.snapshot ?? p.snapshotId },
        reason: "later, diff against this snapshot to see exactly what changed",
      });
      break;

    case "camera_set":
      out.push({
        call: "screenshot",
        args: { region: "viewport" },
        reason: "see the new camera angle",
      });
      break;

    case "profile_update":
      if (p.placeId === 0) {
        out.push({
          call: "profile_update",
          args: { placeName: "name your unsaved place so the profile becomes findable later" },
          reason: "this place has no PlaceId (unsaved) — naming it helps later sessions",
        });
      }
      break;
  }

  // Caller (server.ts) caps to 3; we keep the ranking here so the top entry
  // is always the most-likely-next call.
  return out.slice(0, 3);
}
