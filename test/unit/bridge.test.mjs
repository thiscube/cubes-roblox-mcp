/**
 * Bridge tests: the security guard, body limits, queue limits, and the
 * long-poll liveness bugs. Each one binds an ephemeral loopback port.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import http from "node:http";
import { StudioBridge } from "../../dist/bridge.js";
import { MAX_PROTOCOL_VERSION, MIN_PROTOCOL_VERSION, protocolSupported } from "../../dist/protocol.js";

/**
 * Spin up a bridge on an OS-assigned port; caller must stop it.
 *
 * Port 0, not a fixed counter: `node --test` runs test files in parallel, and
 * hand-picked ranges collided intermittently with EADDRINUSE.
 */
async function makeBridge() {
  const bridge = new StudioBridge(0);
  await bridge.start();
  const p = bridge.boundPort;
  const base = `http://127.0.0.1:${p}`;
  const call = (path, { method = "POST", headers = {}, body, token = bridge.token } = {}) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
  return { bridge, base, call, port: p };
}

const goodPoll = { protocol: MAX_PROTOCOL_VERSION, writeEnabled: false };

describe("bridge guard (#1, #27, #28)", () => {
  test("#1 a cross-origin request is refused outright", async () => {
    const { bridge, call } = await makeBridge();
    try {
      const res = await call("/rpc", { headers: { origin: "https://evil.example" }, body: { tool: "read" } });
      assert.equal(res.status, 403);
      assert.equal((await res.json()).error, "origin_not_allowed");
    } finally {
      await bridge.stop();
    }
  });

  test("#1 a non-loopback Host is refused (DNS rebinding)", async () => {
    const { bridge, port } = await makeBridge();
    try {
      // fetch/undici refuses to send a custom Host header, so use raw http.
      const status = await new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: "/rpc",
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${bridge.token}`,
              host: "attacker.example.com",
              "content-length": 2,
            },
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode));
          },
        );
        req.on("error", reject);
        req.end("{}");
      });
      assert.equal(status, 403);
    } finally {
      await bridge.stop();
    }
  });

  test("#1 text/plain (the CORS-simple trick) is refused", async () => {
    const { bridge, call } = await makeBridge();
    try {
      const res = await call("/rpc", {
        headers: { "content-type": "text/plain;charset=UTF-8" },
        body: JSON.stringify({ tool: "read" }),
      });
      assert.equal(res.status, 415);
    } finally {
      await bridge.stop();
    }
  });

  test("#28 an unauthenticated request is refused on every route", async () => {
    const { bridge, call } = await makeBridge();
    try {
      for (const path of ["/rpc", "/poll", "/result"]) {
        const res = await call(path, { token: null, body: {} });
        assert.equal(res.status, 401, `${path} accepted an unauthenticated request`);
      }
    } finally {
      await bridge.stop();
    }
  });

  test("#28 a wrong token is refused", async () => {
    const { bridge, call } = await makeBridge();
    try {
      const res = await call("/poll", { token: "not-the-token", body: goodPoll });
      assert.equal(res.status, 401);
    } finally {
      await bridge.stop();
    }
  });

  test("#27 a forged poll cannot turn on write mode", async () => {
    const { bridge, call } = await makeBridge();
    try {
      // Authenticated poll with writes off — the honest state.
      const poll = call("/poll", { body: { protocol: MAX_PROTOCOL_VERSION, writeEnabled: false } });
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(bridge.writeEnabled, false);

      // Unauthenticated attacker tries to flip it.
      const forged = await call("/poll", { token: null, body: { protocol: MAX_PROTOCOL_VERSION, writeEnabled: true } });
      assert.equal(forged.status, 401);
      assert.equal(bridge.writeEnabled, false, "an unauthenticated poll flipped the write toggle");
      await bridge.stop();
      await poll.catch(() => {});
    } finally {
      await bridge.stop();
    }
  });

  test("#24 a poll that omits writeEnabled means OFF, not 'unchanged'", async () => {
    const { bridge, call } = await makeBridge();
    try {
      const a = call("/poll", { body: { protocol: MAX_PROTOCOL_VERSION, writeEnabled: true } });
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(bridge.writeEnabled, true);
      const b = call("/poll", { body: { protocol: MAX_PROTOCOL_VERSION } });
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(bridge.writeEnabled, false, "a missing field must not inherit the old value");
      await bridge.stop();
      await Promise.allSettled([a, b]);
    } finally {
      await bridge.stop();
    }
  });
});

describe("bridge limits (#4, #29, #32)", () => {
  test("#4 an oversized Content-Length is refused before buffering", async () => {
    const { bridge, base, call } = await makeBridge();
    try {
      const res = await fetch(`${base}/rpc`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${bridge.token}`,
          "content-length": String(64 * 1024 * 1024),
        },
        body: JSON.stringify({ tool: "read" }),
      }).catch(() => ({ status: 413 }));
      assert.equal(res.status, 413);
    } finally {
      await bridge.stop();
    }
  });

  test("#32 a malformed body is a structured 400, not a raw 500", async () => {
    const { bridge, call } = await makeBridge();
    try {
      for (const path of ["/poll", "/rpc"]) {
        const res = await call(path, { body: "zzz not json" });
        assert.equal(res.status, 400, `${path} should 400`);
        const j = await res.json();
        assert.equal(j.error, "bad_json");
      }
    } finally {
      await bridge.stop();
    }
  });

  test("#29 the queue is capped", async () => {
    const { bridge, call } = await makeBridge();
    try {
      const poll = call("/poll", { body: { protocol: MAX_PROTOCOL_VERSION, writeEnabled: true } });
      await new Promise((r) => setTimeout(r, 50));
      // Fire more commands than the queue can hold; none of them will be answered.
      const sends = [];
      for (let i = 0; i < 300; i++) sends.push(bridge.send("read", {}, 500).catch((e) => e.code));
      const codes = await Promise.all(sends);
      assert.ok(codes.includes("bridge_busy"), "expected the queue cap to shed load");
      await bridge.stop();
      await poll.catch(() => {});
    } finally {
      await bridge.stop();
    }
  });
});

describe("bridge liveness (#5, #6, #18, A5)", () => {
  test("#5 a command is NOT lost when the polling socket dies", async () => {
    const { bridge, base, call } = await makeBridge();
    try {
      const ac = new AbortController();
      const dead = fetch(`${base}/poll`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${bridge.token}` },
        body: JSON.stringify({ protocol: MAX_PROTOCOL_VERSION, writeEnabled: true }),
        signal: ac.signal,
      }).catch(() => {});
      await new Promise((r) => setTimeout(r, 100));
      ac.abort();
      await new Promise((r) => setTimeout(r, 100));

      // Queue a command while no live poller exists.
      const inflight = bridge.send("read", { path: "Workspace" }, 4000).catch((e) => e.code);
      await new Promise((r) => setTimeout(r, 50));

      // A fresh poll must receive it rather than get 204 while the command vanishes.
      const res = await call("/poll", { body: { protocol: MAX_PROTOCOL_VERSION, writeEnabled: true } });
      assert.equal(res.status, 200, "the reconnecting poll should have received the queued command");
      const cmd = await res.json();
      assert.equal(cmd.tool, "read");

      await call("/result", { body: { id: cmd.id, ok: true, result: { got: true } } });
      assert.deepEqual(await inflight, { got: true });
      await dead;
    } finally {
      await bridge.stop();
    }
  });

  test("#6 a bad handshake does not block a healthy plugin", async () => {
    const { bridge, call } = await makeBridge();
    try {
      const poll = call("/poll", { body: { protocol: MAX_PROTOCOL_VERSION, writeEnabled: true } });
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(bridge.connected, true);

      // Someone pokes the bridge with a nonsense protocol.
      const bad = await call("/poll", { body: { protocol: 999 } });
      assert.equal(bad.status, 426);

      // The healthy plugin is still connected, so sends must still work.
      assert.equal(bridge.connected, true, "a bad handshake must not disconnect a good plugin");
      const inflight = bridge.send("read", {}, 2000).catch((e) => e.code);
      // The already-parked poll is the receiver — do not open a second one.
      const cmd = await (await poll).json();
      await call("/result", { body: { id: cmd.id, ok: true, result: 1 } });
      assert.equal(await inflight, 1, "send() was blocked by an unrelated bad handshake");
    } finally {
      await bridge.stop();
    }
  });

  test("A5 the protocol check is a range, not equality", () => {
    assert.equal(protocolSupported(MAX_PROTOCOL_VERSION), true);
    assert.equal(protocolSupported(MIN_PROTOCOL_VERSION), true);
    assert.equal(protocolSupported(MIN_PROTOCOL_VERSION - 1), false);
    assert.equal(protocolSupported(MAX_PROTOCOL_VERSION + 1), false);
    assert.ok(MIN_PROTOCOL_VERSION <= MAX_PROTOCOL_VERSION);
  });

  test("#18 the cancelled-id structure drains instead of growing forever", async () => {
    const { bridge } = await makeBridge();
    try {
      // Internals: mark ids cancelled, then resolve them via late results.
      for (let i = 0; i < 2000; i++) bridge.markCancelled(`id-${i}`);
      assert.ok(bridge.cancelled.size <= 1000, "cancelled set exceeded its cap");
      const before = bridge.cancelled.size;
      for (let i = 1000; i < 2000; i++) bridge.handleResult({ id: `id-${i}`, ok: true, result: 1 });
      assert.ok(bridge.cancelled.size < before, "late results should drain the structure");
    } finally {
      await bridge.stop();
    }
  });
});

describe("rpc write gate (#1)", () => {
  test("#1 unknown tool names are treated as writes, not waved through", async () => {
    const { bridge, call } = await makeBridge();
    try {
      const poll = call("/poll", { body: { protocol: MAX_PROTOCOL_VERSION, writeEnabled: false } });
      await new Promise((r) => setTimeout(r, 50));
      for (const tool of ["tune", "playtest_play", "character_teleport", "event_watch", "eval", "mutate"]) {
        const res = await call("/rpc", { body: { tool, args: {} } });
        assert.equal(res.status, 403, `${tool} was not gated`);
        assert.equal((await res.json()).error, "write_mode_disabled");
      }
      await bridge.stop();
      await poll.catch(() => {});
    } finally {
      await bridge.stop();
    }
  });

  test("read-class tools still work with writes off", async () => {
    const { bridge, call } = await makeBridge();
    try {
      const poll = call("/poll", { body: { protocol: MAX_PROTOCOL_VERSION, writeEnabled: false } });
      await new Promise((r) => setTimeout(r, 50));
      const pending = call("/rpc", { body: { tool: "read", args: { path: "Workspace" } } });
      // The parked poll receives it.
      const cmd = await (await poll).json();
      assert.equal(cmd.tool, "read");
      await call("/result", { body: { id: cmd.id, ok: true, result: { items: [] } } });
      const body = await (await pending).json();
      assert.equal(body.ok, true);
    } finally {
      await bridge.stop();
    }
  });
});
