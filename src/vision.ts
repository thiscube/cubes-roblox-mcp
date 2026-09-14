import { spawn } from "node:child_process";
import { mkdir, readFile, unlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import type { ToolEntry, ToolContext } from "./registry.js";
import { stateDir } from "./paths.js";

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
/** The plugin command that returns the framebuffer. Protocol 3. */
export const STUDIO_CAPTURE_COMMAND = "capture";
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

/**
 * When a given transport last told us it cannot capture.
 *
 * Keyed by the transport, not stored in a module variable, because "this plugin
 * has no capture handler" is a fact about a CONNECTION, not about this process.
 * With one Studio window the difference is invisible; with several (PLAN.md #11)
 * one old plugin would otherwise suppress the Studio path for every other window
 * for a minute. A WeakMap so a dead transport takes its entry with it.
 */
const studioCaptureUnavailableAt = new WeakMap<object, number>();

/** Test seam: forget what we learned about a plugin's capture support. */
export function __resetStudioCaptureMemo(bridge?: object): void {
  if (bridge) studioCaptureUnavailableAt.delete(bridge);
  else lastMemoKey && studioCaptureUnavailableAt.delete(lastMemoKey);
}

/** The most recent transport we recorded against, so a bare reset still works. */
let lastMemoKey: object | null = null;

function studioCaptureWorthTrying(bridge: object): boolean {
  const at = studioCaptureUnavailableAt.get(bridge) ?? 0;
  return Date.now() - at > STUDIO_CAPTURE_RETRY_MS;
}

function rememberCaptureUnavailable(bridge: object): void {
  studioCaptureUnavailableAt.set(bridge, Date.now());
  lastMemoKey = bridge;
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
      STUDIO_CAPTURE_COMMAND,
      // `region` is passed through so the plugin can crop to the 3D viewport
      // itself. A plugin that ignores it returns the whole Studio window, which
      // is still better than the OS path.
      { region, maxEdge: DOWNSCALE_MAX_EDGE },
      STUDIO_CAPTURE_TIMEOUT_MS,
    )) as { png?: unknown; base64?: unknown; width?: unknown; height?: unknown; error?: unknown };

    const data = typeof reply?.png === "string" ? reply.png : reply?.base64;
    if (typeof data !== "string" || data.length === 0) {
      // A structured error, or a plugin that has no `capture` handler at all.
      rememberCaptureUnavailable(bridge as object);
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
    rememberCaptureUnavailable(bridge as object);
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

function run(cmd: string, args: string[], timeoutMs = CAPTURE_TIMEOUT_MS, env?: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { windowsHide: true, ...(env ? { env: { ...process.env, ...env } } : {}) });
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

/**
 * PowerShell capture. All numeric values are pre-validated integers from `px`.
 *
 * Studio regions are captured with PrintWindow, not by copying the screen: the
 * window renders itself into our bitmap, so a window sitting on top of Studio is
 * not in the shot. Copying the screen is what made every capture taken from an
 * MCP client's own window a picture of that client. PrintWindow with
 * PW_RENDERFULLCONTENT (2) includes Studio's DirectX viewport; if it fails, the
 * old screen copy is the fallback.
 *
 * `viewport`, when known, is the 3D view's size in pixels as the plugin reports
 * it. Studio's viewport is its own child window of exactly that size, so the
 * crop is found rather than guessed from insets, whatever the panel layout.
 * Without it the insets apply, as before.
 */
function windowsScript(outPath: string, region: Region, insets: Insets, viewport?: { w: number; h: number }): string {
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
  const vw = viewport ? px(viewport.w, 0) : 0;
  const vh = viewport ? px(viewport.h, 0) : 0;
  const wholeWindow = region === "studio" ? "$true" : "$false";
  return `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
try { Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class CubesCap {
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Rt, B; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  public static R[] Children(IntPtr p) {
    var list = new List<R>();
    EnumChildWindows(p, (h, l) => { R r; if (IsWindowVisible(h) && GetWindowRect(h, out r)) list.Add(r); return true; }, IntPtr.Zero);
    return list.ToArray();
  }
}
'@ } catch {}
[void][CubesCap]::SetProcessDPIAware()
$proc = Get-Process | Where-Object { $_.ProcessName -like 'RobloxStudio*' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { [Console]::Error.WriteLine('studio_window_not_found'); exit 2 }
$hwnd = $proc.MainWindowHandle
if ([CubesCap]::IsIconic($hwnd)) { [Console]::Error.WriteLine('studio_minimized'); exit 4 }
$rect = New-Object CubesCap+R
[void][CubesCap]::GetWindowRect($hwnd, [ref]$rect)
$W = $rect.Rt - $rect.L; $H = $rect.B - $rect.T
if ($W -lt 50 -or $H -lt 50) { [Console]::Error.WriteLine('studio_window_too_small'); exit 3 }
$full = New-Object System.Drawing.Bitmap $W, $H
$g = [System.Drawing.Graphics]::FromImage($full)
$hdc = $g.GetHdc()
$printed = [CubesCap]::PrintWindow($hwnd, $hdc, 2)
$g.ReleaseHdc($hdc)
if (-not $printed) { $g.CopyFromScreen($rect.L, $rect.T, 0, 0, $full.Size) }
$g.Dispose()
$x = ${left}; $y = ${top}; $w = $W - ${left} - ${right}; $h = $H - ${top} - ${bottom}
if (${wholeWindow}) { $x = 0; $y = 0; $w = $W; $h = $H }
elseif (${vw} -gt 0 -and ${vh} -gt 0) {
  # The viewport child window: exact size first, then the same size under display scaling.
  $best = $null
  foreach ($s in @(1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 3.0, 0.8, 0.6667, 0.5714, 0.5)) {
    foreach ($c in [CubesCap]::Children($hwnd)) {
      $cw = $c.Rt - $c.L; $ch = $c.B - $c.T
      if ([Math]::Abs($cw - ${vw} * $s) -le 2 -and [Math]::Abs($ch - ${vh} * $s) -le 2) { $best = $c; break }
    }
    if ($best) { break }
  }
  if ($best) { $x = $best.L - $rect.L; $y = $best.T - $rect.T; $w = $best.Rt - $best.L; $h = $best.B - $best.T }
}
$x = [Math]::Max(0, $x); $y = [Math]::Max(0, $y)
$w = [Math]::Min($w, $W - $x); $h = [Math]::Min($h, $H - $y)
if ($w -lt 50 -or $h -lt 50) { [Console]::Error.WriteLine('studio_window_too_small'); exit 3 }
$crop = $full.Clone((New-Object System.Drawing.Rectangle $x, $y, $w, $h), $full.PixelFormat)
$crop.Save('${escaped}', [System.Drawing.Imaging.ImageFormat]::Png)
$crop.Dispose(); $full.Dispose()`;
}

/**
 * Where PowerShell compiles the capture helper. Add-Type writes a .cs file to
 * TEMP, and a TEMP the process cannot write to made every Studio capture fall
 * back to a full-screen shot of whatever was in front. The server's own state
 * directory is always writable by the user it runs as.
 */
async function captureTempDir(): Promise<string | undefined> {
  const dir = join(stateDir(), "tmp");
  try {
    await mkdir(dir, { recursive: true });
    return dir;
  } catch {
    return undefined;
  }
}

/**
 * The 3D viewport's size in pixels, read from the plugin's camera, for an exact
 * crop. Null when there is no plugin or no answer; the insets apply then.
 */
async function viewportPixels(bridge: ToolContext["bridge"] | undefined): Promise<{ w: number; h: number } | null> {
  if (!bridge?.connected) return null;
  try {
    const reply = (await bridge.send(
      "read",
      { query: "Workspace/*[ClassName=Camera]", select: ["ViewportSize"], limit: 5, prefetch: false },
      5_000,
    )) as { items?: Array<{ props?: { ViewportSize?: { value?: unknown } } }> };
    for (const item of reply?.items ?? []) {
      const raw = item?.props?.ViewportSize?.value;
      const m = typeof raw === "string" ? /^\s*([\d.]+)\s*,\s*([\d.]+)/.exec(raw) : null;
      if (m && Number(m[1]) >= 50 && Number(m[2]) >= 50) return { w: Math.round(Number(m[1])), h: Math.round(Number(m[2])) };
    }
  } catch {
    // An older plugin or a busy bridge: the insets still work.
  }
  return null;
}

async function capture(outPath: string, region: Region, insets: Insets, viewport?: { w: number; h: number }): Promise<void> {
  if (process.platform === "win32") {
    const tmp = await captureTempDir();
    await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", windowsScript(outPath, region, insets, viewport)],
      CAPTURE_TIMEOUT_MS,
      tmp ? { TMP: tmp, TEMP: tmp } : undefined,
    );
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
  pluginCommand: STUDIO_CAPTURE_COMMAND,
  readOnly: true,
  // The OS fallback spawns powershell / screencapture / gnome-screenshot and
  // writes a PNG into the temp directory. There was nowhere to say so until
  // `process` existed, and spawning a binary is the widest-reaching of the three
  // effects a tool can have. `screenshot` is core, so a read-only build carries
  // it either way — declaring it makes that a visible exemption rather than an
  // omission nobody noticed.
  effects: { process: true },
  description:
    "Capture a PNG inline so the agent can see the screen. Captures the Studio window itself, so windows covering it are not in the shot. Regions: 'viewport' (default, the 3D area), 'studio', 'full' (your whole monitor).",
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

    // Someone asking for `source: "studio"` is opting into the framebuffer
    // specifically — for occlusion, and for not shipping whatever else is on
    // their monitor to a model. Refuse rather than quietly hand them an OS
    // capture: that is the opposite of what they asked for. These two checks sit
    // OUTSIDE the attempt below, which is where they were, so a disconnected
    // plugin or `region: "full"` skipped the refusal along with the attempt.
    if (source === "studio") {
      if (requested === "full") {
        return {
          error: "studio_cannot_capture_full",
          hint: "Studio can only return its own framebuffer. Use region 'viewport' or 'studio', or source 'os'.",
        };
      }
      if (!ctx?.bridge?.connected) {
        return {
          error: "studio_not_connected",
          hint: "source 'studio' needs the plugin connected. Use source 'auto' to fall back to the OS.",
        };
      }
    }

    // Studio first. It returns the framebuffer, so an overlapping window cannot
    // end up in the shot — which is the whole reason this path exists. `full`
    // means the whole monitor and is by definition an OS job.
    if (source !== "os" && requested !== "full" && ctx?.bridge?.connected) {
      if (source === "studio" || studioCaptureWorthTrying(ctx.bridge)) {
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
    // An exact viewport crop needs the camera's pixel size; only Windows can use it.
    const viewport =
      requested === "viewport" && source !== "os" && process.platform === "win32"
        ? ((await viewportPixels(ctx?.bridge)) ?? undefined)
        : undefined;
    try {
      await capture(path, requested, insets, viewport);
    } catch (err) {
      // Minimized, Studio has no pixels to give, and a full-screen shot of the
      // desktop is not what was asked for. Say so instead.
      if (err instanceof Error && err.message.includes("studio_minimized")) {
        await cleanup();
        return {
          error: "studio_minimized",
          hint: "Roblox Studio is minimized, so there is nothing to capture. Ask the user to restore the Studio window.",
        };
      }
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
