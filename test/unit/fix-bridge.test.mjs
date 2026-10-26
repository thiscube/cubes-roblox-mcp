/**
 * Bridge fixes from BUGHUNT-2026-10-26: IPv6 loopback Host, the token-home
 * refusal rule, and the per-window write toggle.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { StudioBridge, tokenHomeRefusal } from "../../dist/bridge.js";
import { MAX_PROTOCOL_VERSION } from "../../dist/protocol.js";
import { rpcReadOnlyCommands } from "../../dist/rpc-policy.js";
import "./_fixtures.mjs";

async function makeBridge() {
  const bridge = new StudioBridge(0, { readOnlyCommands: rpcReadOnlyCommands() });
  await bridge.start();
  return { bridge, port: bridge.boundPort };
}

function rawStatus(port, host, bridge) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/health",
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${bridge.token}`,
          host,
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
}

/** Fire a poll and leave it parked; the bridge records the instance on arrival. */
function park(port, bridge, body) {
  const req = http.request({
    host: "127.0.0.1",
    port,
    path: "/poll",
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bridge.token}` },
  });
  req.on("error", () => {});
  req.end(JSON.stringify(body));
  return req;
}

const settle = () => new Promise((r) => setTimeout(r, 100));

describe("bridge fixes", () => {
  test("[::1]:port is accepted as loopback, look-alikes are not", async () => {
    const { bridge, port } = await makeBridge();
    try {
      assert.notEqual(await rawStatus(port, `[::1]:${port}`, bridge), 403);
      assert.notEqual(await rawStatus(port, "[::1]", bridge), 403);
      assert.equal(await rawStatus(port, `[::1].evil.example:${port}`, bridge), 403);
      assert.equal(await rawStatus(port, `[::2]:${port}`, bridge), 403);
    } finally {
      await bridge.stop();
    }
  });

  test("token home: symlink, shared-writable and foreign-owned dirs are refused", () => {
    const dir = (o) => ({ isSymbolicLink: () => false, isFile: () => false, isDirectory: () => true, mode: 0o700, uid: 1, ...o });
    assert.match(tokenHomeRefusal("/h", dir({ isSymbolicLink: () => true }), 1, false), /symlink/);
    assert.match(tokenHomeRefusal("/h", dir({ mode: 0o777 }), 1, true), /writable/);
    assert.match(tokenHomeRefusal("/h", dir({ uid: 2 }), 1, true), /owned/);
    assert.equal(tokenHomeRefusal("/h", dir({ mode: 0o777 }), 1, false), null);
    assert.equal(tokenHomeRefusal("/h", dir({}), 1, true), null);
  });

  test("one window's write toggle does not open writes for another", async () => {
    const { bridge, port } = await makeBridge();
    const reqs = [];
    try {
      reqs.push(park(port, bridge, { protocol: MAX_PROTOCOL_VERSION, instanceId: "A", writeEnabled: true }));
      await settle();
      assert.equal(bridge.writeEnabled, true);
      reqs.push(park(port, bridge, { protocol: MAX_PROTOCOL_VERSION, instanceId: "B", writeEnabled: false }));
      await settle();
      assert.equal(bridge.writeEnabled, false);
      await assert.rejects(bridge.send("mutate", {}, 500, "B"), { code: "write_mode_disabled" });
      await assert.rejects(bridge.send("mutate", {}, 500), { code: "write_mode_disabled" });
      // Targeted at the window that said yes: passes the gate (then times out, nobody answers).
      await assert.rejects(bridge.send("mutate", {}, 300, "A"), (err) => err.code !== "write_mode_disabled");
    } finally {
      for (const r of reqs) r.destroy();
      await bridge.stop();
    }
  });
});
