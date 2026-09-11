/**
 * The WebSocket transport (PLAN.md #14).
 *
 * Long-poll stays the default and the fallback. The socket exists for the
 * direction long-poll cannot do — the plugin pushing when nothing was asked of
 * it — not for latency, which test/bench/poll-latency.mjs measures at ~1.4ms p50
 * for the poll, noise next to Studio doing the work.
 *
 * The security tests here are the important ones. A WebSocket is NOT subject to
 * CORS: any page on any site can open one to 127.0.0.1 and the browser will not
 * stop it. What the browser always does is attach an Origin header. Refusing
 * every upgrade that carries one is the entire defence.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";

import { StudioBridge } from "../../dist/bridge.js";
import { MAX_PROTOCOL_VERSION, MIN_PROTOCOL_VERSION } from "../../dist/protocol.js";
import { rpcReadOnlyCommands } from "../../dist/rpc-policy.js";
import "./_fixtures.mjs";

async function makeBridge(opts = {}) {
  const bridge = new StudioBridge(0, { readOnlyCommands: rpcReadOnlyCommands(), ...opts });
  await bridge.start();
  return { bridge, url: `ws://127.0.0.1:${bridge.boundPort}/ws` };
}

/** Open a socket and resolve to { ws } on open, or { error } on refusal. */
function connect(url, options) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, options);
    ws.once("open", () => resolve({ ws }));
    ws.once("error", (err) => resolve({ error: err }));
  });
}

/** A plugin that answers every command by echoing the tool name. */
function attachEchoPlugin(ws, { onMessage } = {}) {
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    onMessage?.(msg);
    if (msg.type === "command") {
      ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, result: { echoed: msg.tool } }));
    }
  });
}

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

describe("websocket transport", () => {
  test("a socket plugin serves commands without any polling", async () => {
    const { bridge, url } = await makeBridge();
    try {
      const { ws } = await connect(url, { headers: { authorization: `Bearer ${bridge.token}` } });
      attachEchoPlugin(ws);
      ws.send(JSON.stringify({ type: "hello", protocol: MAX_PROTOCOL_VERSION, writeEnabled: true }));
      await settle();

      assert.equal(bridge.transportKind, "websocket");
      assert.equal(bridge.connected, true);
      assert.equal(bridge.writeEnabled, true);
      assert.deepEqual(await bridge.send("read", { path: "Workspace" }, 3000), { echoed: "read" });
      assert.equal(bridge.queueDepth, 0, "nothing should be waiting for a poll");
      ws.close();
    } finally {
      await bridge.stop();
    }
  });

  test("a command queued before the socket connects is drained on hello", async () => {
    const { bridge, url } = await makeBridge();
    try {
      // Make the bridge think a plugin is around, then queue with nobody to take it.
      await fetch(`http://127.0.0.1:${bridge.boundPort}/health`).catch(() => {});
      const { ws } = await connect(url, { headers: { authorization: `Bearer ${bridge.token}` } });
      attachEchoPlugin(ws);
      // Sent BEFORE hello, so it lands in the queue rather than on the socket.
      const pending = bridge.send("read", {}, 3000);
      await settle(20);
      ws.send(JSON.stringify({ type: "hello", protocol: MAX_PROTOCOL_VERSION, writeEnabled: true }));
      assert.deepEqual(await pending, { echoed: "read" });
      ws.close();
    } finally {
      await bridge.stop();
    }
  });

  test("writes follow the panel toggle, and a missing field means off", async () => {
    const { bridge, url } = await makeBridge();
    try {
      const { ws } = await connect(url, { headers: { authorization: `Bearer ${bridge.token}` } });
      ws.send(JSON.stringify({ type: "hello", protocol: MAX_PROTOCOL_VERSION, writeEnabled: true }));
      await settle();
      assert.equal(bridge.writeEnabled, true);

      ws.send(JSON.stringify({ type: "state", writeEnabled: false }));
      await settle();
      assert.equal(bridge.writeEnabled, false);

      ws.send(JSON.stringify({ type: "state", writeEnabled: true }));
      await settle();
      assert.equal(bridge.writeEnabled, true);

      // No field at all is OFF, never "unchanged" (AUDIT.md #24).
      ws.send(JSON.stringify({ type: "state" }));
      await settle();
      assert.equal(bridge.writeEnabled, false);
      ws.close();
    } finally {
      await bridge.stop();
    }
  });

  test("closing the socket turns writes off immediately", async () => {
    // Write permission must never outlive the plugin that granted it.
    const { bridge, url } = await makeBridge();
    try {
      const { ws } = await connect(url, { headers: { authorization: `Bearer ${bridge.token}` } });
      ws.send(JSON.stringify({ type: "hello", protocol: MAX_PROTOCOL_VERSION, writeEnabled: true }));
      await settle();
      assert.equal(bridge.writeEnabled, true);

      ws.close();
      await settle(120);
      assert.equal(bridge.writeEnabled, false, "writes must not survive the socket");
    } finally {
      await bridge.stop();
    }
  });

  test("a second socket replaces the first rather than racing it", async () => {
    const { bridge, url } = await makeBridge();
    try {
      const first = await connect(url, { headers: { authorization: `Bearer ${bridge.token}` } });
      const closed = new Promise((r) => first.ws.once("close", (code, reason) => r(reason.toString())));
      first.ws.send(JSON.stringify({ type: "hello", protocol: MAX_PROTOCOL_VERSION, writeEnabled: true }));
      await settle();

      const second = await connect(url, { headers: { authorization: `Bearer ${bridge.token}` } });
      attachEchoPlugin(second.ws);
      second.ws.send(JSON.stringify({ type: "hello", protocol: MAX_PROTOCOL_VERSION, writeEnabled: true }));

      assert.equal(await closed, "replaced_by_new_connection");
      assert.deepEqual(await bridge.send("read", {}, 3000), { echoed: "read" });
      second.ws.close();
    } finally {
      await bridge.stop();
    }
  });

  test("an out-of-range protocol is refused, same as the 426 on /poll", async () => {
    const { bridge, url } = await makeBridge();
    try {
      const { ws } = await connect(url, { headers: { authorization: `Bearer ${bridge.token}` } });
      const got = new Promise((r) => ws.once("message", (raw) => r(JSON.parse(raw.toString()))));
      ws.send(JSON.stringify({ type: "hello", protocol: MIN_PROTOCOL_VERSION - 1, writeEnabled: true }));
      const msg = await got;
      assert.equal(msg.error, "protocol_mismatch");
      assert.deepEqual(msg.supported, [MIN_PROTOCOL_VERSION, MAX_PROTOCOL_VERSION]);
      await settle(80);
      assert.notEqual(bridge.transportKind, "websocket", "a mismatched plugin must not hold the socket");
    } finally {
      await bridge.stop();
    }
  });

  test("unknown message types are ignored, which is what keeps it additive", async () => {
    const { bridge, url } = await makeBridge();
    try {
      const { ws } = await connect(url, { headers: { authorization: `Bearer ${bridge.token}` } });
      attachEchoPlugin(ws);
      ws.send(JSON.stringify({ type: "hello", protocol: MAX_PROTOCOL_VERSION, writeEnabled: true }));
      await settle();
      ws.send(JSON.stringify({ type: "some_future_thing", payload: 1 }));
      await settle();
      assert.equal(bridge.transportKind, "websocket", "the socket must survive");
      assert.deepEqual(await bridge.send("read", {}, 3000), { echoed: "read" });
      ws.close();
    } finally {
      await bridge.stop();
    }
  });

  test("/health reports which transport is in use", async () => {
    const { bridge, url } = await makeBridge();
    try {
      const health = async () =>
        (await fetch(`http://127.0.0.1:${bridge.boundPort}/health`, { method: "POST" })).json();
      assert.equal((await health()).transport, "none");

      const { ws } = await connect(url, { headers: { authorization: `Bearer ${bridge.token}` } });
      ws.send(JSON.stringify({ type: "hello", protocol: MAX_PROTOCOL_VERSION }));
      await settle();
      assert.equal((await health()).transport, "websocket");
      ws.close();
    } finally {
      await bridge.stop();
    }
  });
});

describe("websocket upgrade guard", () => {
  test("an Origin header is refused, because CORS does not protect a WebSocket", async () => {
    // Any page on any site can open a socket to 127.0.0.1. The browser will not
    // stop it, but it always sends Origin — and the plugin never does.
    const { bridge, url } = await makeBridge();
    try {
      const { ws, error } = await connect(url, {
        headers: { authorization: `Bearer ${bridge.token}`, origin: "https://evil.example" },
      });
      ws?.close();
      assert.ok(error, "a browser-originated upgrade must be refused");
      assert.match(error.message, /403/);
    } finally {
      await bridge.stop();
    }
  });

  test("a wrong token is refused", async () => {
    const { bridge, url } = await makeBridge();
    try {
      const { ws, error } = await connect(url, { headers: { authorization: "Bearer wrong" } });
      ws?.close();
      assert.ok(error);
      assert.match(error.message, /401/);
    } finally {
      await bridge.stop();
    }
  });

  test("no token at all is refused", async () => {
    const { bridge, url } = await makeBridge();
    try {
      const { ws, error } = await connect(url);
      ws?.close();
      assert.ok(error);
      assert.match(error.message, /401/);
    } finally {
      await bridge.stop();
    }
  });

  test("a non-loopback Host is refused", async () => {
    const { bridge, url } = await makeBridge();
    try {
      const { ws, error } = await connect(url, {
        headers: { authorization: `Bearer ${bridge.token}`, host: "evil.example" },
      });
      ws?.close();
      assert.ok(error, "DNS rebinding must not reach the socket");
      assert.match(error.message, /403/);
    } finally {
      await bridge.stop();
    }
  });

  test("the token may travel in the query string, but only on the upgrade", async () => {
    // Roblox's WebSocket client cannot be relied on to set custom headers. This
    // is a real downgrade — query strings reach logs — so it is scoped to /ws.
    const { bridge } = await makeBridge();
    try {
      const ok = await connect(`ws://127.0.0.1:${bridge.boundPort}/ws?token=${bridge.token}`);
      assert.ok(ok.ws, "the plugin needs a header-free way in");
      ok.ws.close();

      const bad = await connect(`ws://127.0.0.1:${bridge.boundPort}/ws?token=nope`);
      bad.ws?.close();
      assert.ok(bad.error);

      // The HTTP routes have no such excuse and must not accept it.
      const res = await fetch(`http://127.0.0.1:${bridge.boundPort}/rpc?token=${bridge.token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool: "read", args: {} }),
      });
      assert.equal(res.status, 401, "a query token must not authenticate an HTTP route");
    } finally {
      await bridge.stop();
    }
  });

  test("an upgrade on any other path is refused", async () => {
    const { bridge } = await makeBridge();
    try {
      const { ws, error } = await connect(`ws://127.0.0.1:${bridge.boundPort}/poll`, {
        headers: { authorization: `Bearer ${bridge.token}` },
      });
      ws?.close();
      assert.ok(error);
      assert.match(error.message, /404/);
    } finally {
      await bridge.stop();
    }
  });
});
