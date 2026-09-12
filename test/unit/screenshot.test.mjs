/**
 * Screenshots come from Studio first (PLAN.md #1).
 *
 * The OS path captures whatever pixels are on the screen inside Studio's window
 * rect, so anything sitting on top of Studio ends up in the shot instead. Asking
 * the plugin for the framebuffer cannot have that problem. But
 * `StudioCaptureService` is FFlag-gated and absent from some builds, and an
 * older plugin has no `capture` handler at all, so the OS path is a fallback we
 * keep rather than a path we replace.
 *
 * These tests are all about the routing decision, since that is the part this
 * repo owns. Whether Studio's own capture is any good is a manual check.
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { screenshotTool, __resetStudioCaptureMemo } from "../../dist/vision.js";
import { capabilities } from "../../dist/registry.js";

/** A one-pixel PNG, base64. Small enough to inline, real enough to pass through. */
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function bridge({ connected = true, reply } = {}) {
  const sent = [];
  return {
    sent,
    connected,
    writeEnabled: true,
    async send(tool, args, timeoutMs) {
      sent.push({ tool, args, timeoutMs });
      if (!reply) throw new Error("unknown_tool");
      return reply(tool, args);
    },
  };
}

const shoot = (args, b) => screenshotTool.handler(args, { bridge: b });
const metaOf = (res) => res.__structured;

describe("screenshot routing", () => {
  beforeEach(() => __resetStudioCaptureMemo());

  test("a connected plugin that can capture is used, and the OS is not", async () => {
    const b = bridge({ reply: () => ({ png: TINY_PNG, width: 1, height: 1 }) });
    const res = await shoot({ region: "viewport" }, b);

    assert.deepEqual(b.sent.map((s) => s.tool), ["capture"]);
    assert.equal(b.sent[0].args.region, "viewport");
    assert.equal(metaOf(res).source, "studio");
    assert.equal(metaOf(res).width, 1);
    const image = res.__mcpContent.find((c) => c.type === "image");
    assert.equal(image.data, TINY_PNG);
    assert.equal(image.mimeType, "image/png");
  });

  test("the result carries structuredContent, not just a text blob", async () => {
    const b = bridge({ reply: () => ({ png: TINY_PNG }) });
    const res = await shoot({}, b);
    const text = JSON.parse(res.__mcpContent.find((c) => c.type === "text").text);
    assert.deepEqual(res.__structured, text, "the two representations must not drift");
  });

  test("`base64` is accepted as well as `png`, since plugins name it either way", async () => {
    const b = bridge({ reply: () => ({ base64: TINY_PNG }) });
    assert.equal(metaOf(await shoot({}, b)).source, "studio");
  });

  test("a plugin with no capture handler falls back to the OS rather than failing", async () => {
    const b = bridge(); // send() throws, like an unknown_tool reply
    const res = await shoot({ region: "viewport" }, b);
    assert.deepEqual(b.sent.map((s) => s.tool), ["capture"], "it should have asked once");
    // No display in CI, so the OS path fails — the point is that it was reached
    // and that the failure is the OS's, not a refusal to try.
    assert.notEqual(metaOf(res)?.source, "studio");
    assert.ok(res.error === "screenshot_failed" || metaOf(res)?.source === "os");
  });

  test("a structured error from the plugin also falls back", async () => {
    const b = bridge({ reply: () => ({ error: "capture_service_unavailable" }) });
    const res = await shoot({}, b);
    assert.notEqual(metaOf(res)?.source, "studio");
  });

  test("the plugin is not asked twice in a row once it has said no", async () => {
    const b = bridge();
    await shoot({}, b);
    await shoot({}, b);
    assert.equal(b.sent.length, 1, "a failed capture must be remembered for a while");
  });

  test("source 'studio' never touches the OS, and says why it could not", async () => {
    const b = bridge();
    const res = await shoot({ source: "studio" }, b);
    assert.equal(res.error, "studio_capture_unavailable");
    assert.match(res.hint, /source 'auto' or 'os'/);
  });

  test("source 'studio' is refused when the plugin is not connected", async () => {
    // Someone asking for the framebuffer specifically is asking NOT to ship
    // whatever else is on their monitor to a model. Quietly giving them an OS
    // capture is the opposite of what they asked for. The refusal used to sit
    // inside the connected guard, so it was skipped along with the attempt.
    const b = bridge({ connected: false, reply: () => ({ png: TINY_PNG }) });
    const res = await shoot({ source: "studio" }, b);
    assert.equal(res.error, "studio_not_connected");
    assert.deepEqual(b.sent, []);
  });

  test("source 'studio' with region 'full' is refused, not silently downgraded", async () => {
    const b = bridge({ reply: () => ({ png: TINY_PNG }) });
    const res = await shoot({ source: "studio", region: "full" }, b);
    assert.equal(res.error, "studio_cannot_capture_full");
    assert.deepEqual(b.sent, [], "Studio cannot see the rest of the monitor");
  });

  test("the capture memo is per connection, not per process", async () => {
    // One Studio window with an old plugin must not suppress the Studio path for
    // every other window (PLAN.md #11).
    const old = bridge();
    await shoot({}, old);
    await shoot({}, old);
    assert.equal(old.sent.length, 1, "the same plugin is not asked twice");

    const fresh = bridge({ reply: () => ({ png: TINY_PNG }) });
    const res = await shoot({}, fresh);
    assert.equal(metaOf(res).source, "studio", "a different plugin gets its own chance");
  });

  test("source 'os' never asks the plugin", async () => {
    const b = bridge({ reply: () => ({ png: TINY_PNG }) });
    await shoot({ source: "os" }, b);
    assert.deepEqual(b.sent, []);
  });

  test("region 'full' never asks the plugin, because Studio cannot see the monitor", async () => {
    const b = bridge({ reply: () => ({ png: TINY_PNG }) });
    await shoot({ region: "full" }, b);
    assert.deepEqual(b.sent, []);
  });

  test("a disconnected plugin goes straight to the OS", async () => {
    const b = bridge({ connected: false, reply: () => ({ png: TINY_PNG }) });
    await shoot({}, b);
    assert.deepEqual(b.sent, []);
  });

  test("no bridge at all still works, which is how the tool used to behave", async () => {
    const res = await screenshotTool.handler({}, {});
    assert.ok(res.error === "screenshot_failed" || res.__structured?.source === "os");
  });

  test("an oversize Studio capture falls back rather than blowing the budget", async () => {
    const huge = "A".repeat(2_000_000);
    const b = bridge({ reply: () => ({ png: huge }) });
    const res = await shoot({}, b);
    assert.notEqual(metaOf(res)?.source, "studio", "2 MB of base64 must not be inlined");
  });

  test("an oversize capture on source 'studio' is reported, not silently dropped", async () => {
    const huge = "A".repeat(2_000_000);
    const b = bridge({ reply: () => ({ png: huge }) });
    const res = await shoot({ source: "studio" }, b);
    assert.equal(res.error, "screenshot_too_large");
    assert.equal(res.source, "studio");
    assert.ok(res.sizeBytes > res.limitBytes);
  });

  test("it stays non-write-class, so read-only builds keep it", () => {
    assert.equal(screenshotTool.channel, "dispatch", "it talks to the plugin now");
    assert.equal(capabilities(screenshotTool).write, false);
    assert.equal(capabilities(screenshotTool).touchesStudio, true);
  });

  test("the Studio call gets its own timeout, shorter than a tool default", async () => {
    const b = bridge({ reply: () => ({ png: TINY_PNG }) });
    await shoot({}, b);
    assert.ok(b.sent[0].timeoutMs > 0 && b.sent[0].timeoutMs <= 15_000);
  });
});
