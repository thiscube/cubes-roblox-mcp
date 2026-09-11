import { spawn } from "node:child_process";
import { readFile, unlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import type { ToolEntry, ToolContext } from "./registry.js";

/**
 * Vision / observation tools.
 *
 * `screenshot` prefers to ask STUDIO for the pixels and falls back to the host
 * OS (PLAN.md #1). The plugin path uses `StudioCaptureService`, which hands back
 * the framebuffer directly — so it cannot capture a window sitting on top of
 * Studio, which the OS path can and does. The OS path is still needed, because
 * `StudioCaptureService` is FFlag-gated and not present in every Studio build.
 *
 * The OS path shells out to the host
 * OS screen-capture tool, base64-encodes the PNG, and returns it via the
 * `__mcpContent` escape hatch so the agent can SEE the result inline.
 *
 * Three things this file has to get right, all of which it previously got wrong
 * (AUDIT.md #3 and #15):
 *
 *   1. Never interpolate caller input into a shell script. `insets` is declared as
 *      a number in the JSON Schema, but the MCP SDK does not validate arguments, so
 *      a string argument used to land in the PowerShell source and execute.
 *      Everything is coerced through `px()` now.
 *   2. Always clean up the temp file, including on success.
 *   3. Cap the payload. A full-monitor PNG is megabytes of base64 in a single
 *      message; it is downscaled, and refused outright if it is still too big.
 *
 * The default region is the Studio viewport, not the whole monitor — capturing
 * every other window the user has open and shipping it to a model should be an
 * explicit choice, not a default.
 */

/** Max base64 payload we will inline. Beyond this the shot is downscaled, then refused. */
const MAX_INLINE_BYTES = 1_400_000;
/** Longest edge we downscale to when a capture is over budget. */
const DOWNSCALE_MAX_EDGE = 1400;
const CAPTURE_TIMEOUT_MS = 15_000;
/** How long to give Studio before falling back to the OS. */
const STUDIO_CAPTURE_TIMEOUT_MS = 12_000;
/**
 * How long to remember that this plugin cannot capture.
 *
 * Long enough that a session with an old plugin does not pay a failed round trip
 * on every screenshot, short enough that upgrading the plugin starts working
 * without restarting the server.
 */
const STUDIO_CAPTURE_RETRY_MS = 60_000;

export type Region = "full" | "studio" | "viewport";

/** Where the pixels come from. */
export type CaptureSource = "auto" | "studio" | "os";

/** When Studio last told us it cannot capture. 0 means "never asked, or it can". */
let studioCaptureUnavailableAt = 0;

/** Test seam: forget what we learned about the plugin's capture support. */
export function __resetStudioCaptureMemo(): void {
  studioCaptureUnavailableAt = 0;
}

function studioCaptureWorthTrying(): boolean {
  return Date.now() - studioCaptureUnavailableAt > STUDIO_CAPTURE_RETRY_MS;
}

/**
 * Ask the plugin for the framebuffer.
 *
 * Returns the base64 PNG, or null when Studio cannot do it — in which case the
 * caller falls back to the OS rather than failing, because an older plugin
 * simply does not have the handler.
 */
async function studioCapture(
  bridge: ToolContext["bridge"],
  region: Region,
): Promise<{ base64: string; width?: number; height?: number } | null> {
  try {
    const reply = (await bridge.send(
      "capture",
      // `region` is passed through so the plugin can crop to the 3D viewport
      // itself. A plugin that ignores it returns the whole Studio window, which
      // is still better than the OS path.
      { region, maxEdge: DOWNSCALE_MAX_EDGE },
      STUDIO_CAPTURE_TIMEOUT_MS,
    )) as { png?: unknown; base64?: unknown; width?: unknown; height?: unknown; error?: unknown };

    const data = typeof reply?.png === "string" ? reply.png : reply?.base64;
    if (typeof data !== "string" || data.length === 0) {
      // A structured error, or a plugin that has no `capture` handler at all.
      studioCaptureUnavailableAt = Date.now();
      return null;
    }
    return {
      base64: data,
      width: typeof reply.width === "number" ? reply.width : undefined,
      height: typeof reply.height === "number" ? reply.height : undefined,
    };
  } catch {
    // unknown_tool from an older plugin, a timeout, a disconnect. All of these
    // mean "use the OS path", never "fail the screenshot".
    studioCaptureUnavailableAt = Date.now();
    return null;
  }
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * Coerce an arbitrary argument to a safe pixel count.
 *
 * This is the fix for the PowerShell injection: the result is always a finite
 * integer in a sane range, so nothing a caller sends can survive into a script.
 */
export function px(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(4096, Math.max(0, Math.trunc(n)));
}

/** Defaults tuned for the standard Studio layout: strip title/toolbar, Explorer, Output. */
const VIEWPORT_DEFAULTS: Insets = { top: 110, right: 280, bottom: 200, left: 0 };

export function resolveInsets(region: Region, raw: unknown): Insets {
  const base = region === "viewport" ? VIEWPORT_DEFAULTS : { top: 0, right: 0, bottom: 0, left: 0 };
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    top: px(o.top, base.top),
    right: px(o.right, base.right),
    bottom: px(o.bottom, base.bottom),
    left: px(o.left, base.left),
  };
}

// --------------------------------------------------------------------------
// Platform capture backends
// --------------------------------------------------------------------------

function run(cmd: string, args: string[], timeoutMs = CAPTURE_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { windowsHide: true });
    let stderr = "";
    proc.stderr?.on("data", (d) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`${cmd}_timeout`));
    }, timeoutMs);
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}: ${stderr.trim().slice(0, 200)}`));
    });
  });
}

/** PowerShell capture. All numeric values are pre-validated integers from `px`. */
function windowsScript(outPath: string, region: Region, insets: Insets): string {
  const escaped = outPath.replace(/'/g, "''");
  if (region === "full") {
    return `Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save('${escaped}')
$g.Dispose(); $bmp.Dispose()`;
  }
  const { top, right, bottom, left } = insets;
  return `$ErrorActionPreference = 'Stop'
try { Add-Type @'
using System;
using System.Runtime.InteropServices;
public class _RW {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out _R r);
  public struct _R { public int L, T, Rt, B; }
}
'@ } catch {}
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$proc = Get-Process | Where-Object { $_.ProcessName -like 'RobloxStudio*' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { Write-Error 'studio_window_not_found'; exit 2 }
$rect = New-Object _RW+_R
[void][_RW]::GetWindowRect($proc.MainWindowHandle, [ref]$rect)
$x = $rect.L + ${left}
$y = $rect.T + ${top}
$w = ($rect.Rt - $rect.L) - ${left} - ${right}
$h = ($rect.B - $rect.T) - ${top} - ${bottom}
if ($w -lt 50 -or $h -lt 50) { Write-Error 'studio_window_too_small'; exit 3 }
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h)))
$bmp.Save('${escaped}')
$g.Dispose(); $bmp.Dispose()`;
}

async function capture(outPath: string, region: Region, insets: Insets): Promise<void> {
  if (process.platform === "win32") {
    await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      windowsScript(outPath, region, insets),
    ]);
    return;
  }
  if (process.platform === "darwin") {
    // -x silences the shutter; -o omits window shadow. Region cropping on macOS
    // would need window-id lookup, so Studio-relative regions fall back to full.
    await run("screencapture", ["-x", "-o", "-t", "png", outPath]);
    return;
  }
  // Linux: try the common CLI capture tools in order of ubiquity.
  const candidates: Array<[string, string[]]> = [
    ["gnome-screenshot", ["-f", outPath]],
    ["spectacle", ["-b", "-n", "-o", outPath]],
    ["import", ["-window", "root", outPath]],
    ["scrot", [outPath]],
  ];
  let lastErr: unknown;
  for (const [cmd, args] of candidates) {
    try {
      await run(cmd, args);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `no screen capture tool available on linux (tried ${candidates.map((c) => c[0]).join(", ")}): ${String(lastErr)}`,
  );
}

/** Best-effort downscale in place. Returns true if the file was rewritten. */
async function downscale(path: string): Promise<boolean> {
  try {
    if (process.platform === "darwin") {
      await run("sips", ["-Z", String(DOWNSCALE_MAX_EDGE), path], 10_000);
      return true;
    }
    if (process.platform === "win32") {
      const escaped = path.replace(/'/g, "''");
      await run(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          `Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile('${escaped}')
$max = ${DOWNSCALE_MAX_EDGE}
$scale = [Math]::Min(1.0, $max / [Math]::Max($src.Width, $src.Height))
$w = [int]($src.Width * $scale); $h = [int]($src.Height * $scale)
$dst = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($dst)
$g.InterpolationMode = 'HighQualityBicubic'
$g.DrawImage($src, 0, 0, $w, $h)
$src.Dispose()
$dst.Save('${escaped}')
$g.Dispose(); $dst.Dispose()`,
        ],
        10_000,
      );
      return true;
    }
    await run("convert", [path, "-resize", `${DOWNSCALE_MAX_EDGE}x${DOWNSCALE_MAX_EDGE}>`, path], 10_000);
    return true;
  } catch {
    return false;
  }
}

export const screenshotTool: ToolEntry = {
  name: "screenshot",
  category: "viewport",
  subcategories: ["vision", "image"],
  keywords: ["screenshot", "image", "capture", "snap", "see", "view", "screen"],
  // Dispatches a `capture` command to the plugin before falling back to the OS,
  // so the channel is dispatch. It only reads pixels, hence the opt-out.
  channel: "dispatch",
  readOnly: true,
  description:
    "Capture a PNG inline so the agent can see the screen. Asks Studio for the framebuffer first (immune to windows covering Studio), falls back to an OS capture. Regions: 'viewport' (default, the 3D area), 'studio', 'full' (your whole monitor).",
  inputSchema: {
    type: "object",
    properties: {
      region: {
        type: "string",
        enum: ["full", "studio", "viewport"],
        description:
          "What to capture. Default 'viewport'. Use 'full' deliberately — it captures your whole screen, not just Studio.",
      },
      source: {
        type: "string",
        enum: ["auto", "studio", "os"],
        description:
          "Where the pixels come from. Default 'auto': Studio first, OS if it can't.",
      },
      insets: {
        type: "object",
        description:
          "Insets cropped from the Studio window on the OS path only. Defaults for 'viewport': { top: 110, right: 280, bottom: 200, left: 0 }. Clamped to 0-4096.",
        properties: {
          top: { type: "number" },
          right: { type: "number" },
          bottom: { type: "number" },
          left: { type: "number" },
        },
      },
    },
  },
  handler: async (args, ctx) => {
    const requested: Region =
      args?.region === "full" || args?.region === "studio" || args?.region === "viewport"
        ? args.region
        : "viewport";
    const source: CaptureSource =
      args?.source === "studio" || args?.source === "os" || args?.source === "auto"
        ? args.source
        : "auto";

    // Studio first. It returns the framebuffer, so an overlapping window cannot
    // end up in the shot — which is the whole reason this path exists. `full`
    // means the whole monitor and is by definition an OS job.
    if (source !== "os" && requested !== "full" && ctx?.bridge?.connected) {
      if (source === "studio" || studioCaptureWorthTrying()) {
        const shot = await studioCapture(ctx.bridge, requested);
        if (shot) {
          const bytes = Buffer.byteLength(shot.base64, "utf8");
          if (bytes <= MAX_INLINE_BYTES) {
            const meta: Record<string, unknown> = {
              sizeBytes: bytes,
              region: requested,
              source: "studio",
              platform: process.platform,
            };
            if (shot.width) meta.width = shot.width;
            if (shot.height) meta.height = shot.height;
            return {
              __mcpContent: [
                { type: "image", data: shot.base64, mimeType: "image/png" },
                { type: "text", text: JSON.stringify(meta) },
              ],
              __structured: meta,
            };
          }
          // Too big to inline. The OS path can downscale on disk; Studio's
          // answer is already in memory, so fall through rather than ship it.
          if (source === "studio") {
            return {
              error: "screenshot_too_large",
              sizeBytes: bytes,
              limitBytes: MAX_INLINE_BYTES,
              source: "studio",
              hint: "Studio returned more than the inline budget. Retry with source 'os', which downscales.",
            };
          }
        } else if (source === "studio") {
          return {
            error: "studio_capture_unavailable",
            hint: "This plugin has no capture handler, or StudioCaptureService is off in this build. Use source 'auto' or 'os'.",
          };
        }
      }
    }

    const insets = resolveInsets(requested, args?.insets);
    const path = join(tmpdir(), `cubes-mcp-screenshot-${randomBytes(8).toString("hex")}.png`);

    // When we hand the caller a path (the too-large case) we must NOT delete it.
    let keepFile = false;
    const cleanup = () => (keepFile ? Promise.resolve() : unlink(path).catch(() => undefined));

    let actualRegion: Region = requested;
    let warning: string | undefined;
    try {
      await capture(path, requested, insets);
    } catch (err) {
      if (requested === "full") {
        await cleanup();
        return {
          error: "screenshot_failed",
          message: err instanceof Error ? err.message : String(err),
          platform: process.platform,
        };
      }
      warning = `Fell back to full screen: ${err instanceof Error ? err.message : String(err)}`;
      actualRegion = "full";
      try {
        await capture(path, "full", insets);
      } catch (err2) {
        await cleanup();
        return {
          error: "screenshot_failed",
          message: err2 instanceof Error ? err2.message : String(err2),
          platform: process.platform,
        };
      }
    }

    try {
      let size = (await stat(path)).size;
      let downscaled = false;
      if (size > MAX_INLINE_BYTES) {
        downscaled = await downscale(path);
        if (downscaled) size = (await stat(path)).size;
      }
      if (size > MAX_INLINE_BYTES) {
        // Refuse rather than blow up the context window with a multi-megabyte blob.
        // Keep the file so the hint below is actionable.
        keepFile = true;
        return {
          error: "screenshot_too_large",
          sizeBytes: size,
          limitBytes: MAX_INLINE_BYTES,
          savedTo: path,
          hint: "The capture is too big to inline. Use region 'viewport', or open the saved file directly.",
        };
      }

      const buf = await readFile(path);
      const base64 = buf.toString("base64");
      const meta: Record<string, unknown> = {
        sizeBytes: buf.length,
        region: actualRegion,
        source: "os",
        platform: process.platform,
      };
      if (actualRegion !== requested) meta.requested = requested;
      if (downscaled) meta.downscaled = `longest edge ${DOWNSCALE_MAX_EDGE}px`;
      if (warning) meta.warning = warning;

      return {
        __mcpContent: [
          { type: "image", data: base64, mimeType: "image/png" },
          { type: "text", text: JSON.stringify(meta) },
        ],
        __structured: meta,
      };
    } catch (err) {
      return {
        error: "screenshot_failed",
        message: err instanceof Error ? err.message : String(err),
      };
    } finally {
      // Always clean up. The old code only unlinked on failure, so every
      // successful capture leaked a PNG into the temp dir forever (AUDIT.md #15).
      await cleanup();
    }
  },
};
