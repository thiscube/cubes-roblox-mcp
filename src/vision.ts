import { spawn } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import type { ToolEntry } from "./registry.js";

/**
 * Vision / observation tools.
 *
 * `screenshot` is special: its handler runs PURE SERVER-SIDE (no plugin call) —
 * it shells out to PowerShell to capture the screen, base64-encodes the PNG, and
 * returns it via the `__mcpContent` escape hatch so the agent can SEE the result
 * inline in the tool response.
 *
 * The other three vision tools (viewport_capture, camera_set, raycast) are
 * dispatchTool-style entries declared inline in seed.ts — they route through
 * Transport.luau's dispatch, which auto-forwards to the play-DM bus when a
 * playtest is running.
 */

/** PowerShell to capture the primary monitor to <PATH>. */
function fullScreenPs(outPath: string): string {
  const escaped = outPath.replace(/'/g, "''");
  return `Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save('${escaped}')
$g.Dispose(); $bmp.Dispose()`;
}

/**
 * PowerShell to capture just the Roblox Studio window (or a chrome-cropped
 * "viewport" rectangle of it). Uses Win32 GetWindowRect via Add-Type so the
 * crop tracks Studio even when the user moves or resizes it.
 *
 * Insets are subtracted from the Studio window rect — the defaults for
 * `mode: "viewport"` strip the title bar / toolbar / output / right-side
 * panels so the 3D viewport ends up dominating the frame. Tuned for the
 * standard Studio layout; users with custom dock layouts can shift them
 * via the explicit `insets` arg.
 */
function studioWindowPs(
  outPath: string,
  insets?: { top?: number; right?: number; bottom?: number; left?: number },
): string {
  const escaped = outPath.replace(/'/g, "''");
  const t = insets?.top ?? 0;
  const r = insets?.right ?? 0;
  const b = insets?.bottom ?? 0;
  const l = insets?.left ?? 0;
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
$x = $rect.L + ${l}
$y = $rect.T + ${t}
$w = ($rect.Rt - $rect.L) - ${l} - ${r}
$h = ($rect.B - $rect.T) - ${t} - ${b}
if ($w -lt 50 -or $h -lt 50) { Write-Error 'studio_window_too_small'; exit 3 }
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h)))
$bmp.Save('${escaped}')
$g.Dispose(); $bmp.Dispose()`;
}

/** Spawn powershell.exe, return when it exits. Throws on non-zero exit. */
function runPowerShell(script: string, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true },
    );
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error("powershell_timeout"));
    }, timeoutMs);
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`powershell_exit_${code}: ${stderr.trim()}`));
    });
  });
}

export const screenshotTool: ToolEntry = {
  name: "screenshot",
  category: "viewport",
  subcategories: ["vision", "image"],
  keywords: ["screenshot", "image", "capture", "snap", "see", "view", "screen"],
  description:
    "Capture a PNG and return it inline so the agent can see what's on screen. Modes: 'full' (whole primary monitor — works even if Studio isn't focused), 'studio' (just the Roblox Studio window — no other apps), 'viewport' (Studio window cropped to the 3D area — best for examining a scene). 'studio'/'viewport' fall back to 'full' if Studio isn't running.",
  write: false,
  inputSchema: {
    type: "object",
    properties: {
      region: {
        type: "string",
        enum: ["full", "studio", "viewport"],
        description:
          "What to capture (default 'full'). 'viewport' subtracts standard chrome insets from the Studio window so the 3D scene dominates the frame.",
      },
      insets: {
        type: "object",
        description:
          "Override the pixel insets cropped from the Studio window. Defaults for 'viewport' are { top: 110, right: 280, bottom: 200, left: 0 } — tweak if your dock layout is non-standard.",
        properties: {
          top: { type: "number" },
          right: { type: "number" },
          bottom: { type: "number" },
          left: { type: "number" },
        },
      },
    },
  },
  handler: async (args) => {
    const requested = typeof args?.region === "string" ? args.region : "full";
    const userInsets = (args as any)?.insets as Record<string, number> | undefined;
    const path = join(tmpdir(), `cubes-mcp-screenshot-${randomBytes(8).toString("hex")}.png`);

    // Choose a capture script per region. "studio" and "viewport" use the
    // Win32 window-rect path; "viewport" additionally crops standard chrome
    // insets so the 3D area dominates. Anything else falls back to full.
    let actualRegion = requested;
    const buildScript = (region: string): string => {
      if (region === "studio") return studioWindowPs(path, userInsets);
      if (region === "viewport") {
        // Defaults tuned for the standard Studio layout: strip title +
        // toolbar (top), Explorer/Properties (right), Output (bottom).
        const defaults = { top: 110, right: 280, bottom: 200, left: 0 };
        return studioWindowPs(path, { ...defaults, ...(userInsets ?? {}) });
      }
      return fullScreenPs(path);
    };

    let warning: string | undefined;
    try {
      await runPowerShell(buildScript(requested));
    } catch (err) {
      // If a Studio-relative capture fails (e.g. Studio not running),
      // fall back to full-screen rather than returning an error — the
      // agent still gets *something* visual.
      if (requested !== "full") {
        warning = `Fell back to full screen: ${err instanceof Error ? err.message : String(err)}`;
        actualRegion = "full";
        try {
          await runPowerShell(fullScreenPs(path));
        } catch (err2) {
          void unlink(path).catch(() => undefined);
          return {
            error: "screenshot_failed",
            message: err2 instanceof Error ? err2.message : String(err2),
          };
        }
      } else {
        void unlink(path).catch(() => undefined);
        return {
          error: "screenshot_failed",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }

    try {
      const buf = await readFile(path);
      const base64 = buf.toString("base64");
      const meta: Record<string, unknown> = {
        savedTo: path,
        sizeBytes: buf.length,
        region: actualRegion,
      };
      if (actualRegion !== requested) meta.requested = requested;
      if (warning) meta.warning = warning;
      // __mcpContent: handler-returned content blocks bypass the default JSON
      // wrapper in server.ts. Used to ship the image as a real MCP image block
      // (so the model SEES it) alongside a small JSON metadata text block.
      return {
        __mcpContent: [
          { type: "image", data: base64, mimeType: "image/png" },
          { type: "text", text: JSON.stringify(meta) },
        ],
      };
    } catch (err) {
      void unlink(path).catch(() => undefined);
      return {
        error: "screenshot_failed",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  },
};
