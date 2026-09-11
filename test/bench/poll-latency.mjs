// Run: npm run build && node test/bench/poll-latency.mjs
//
// What does the transport actually cost per command?
//
// The case for a WebSocket is usually made on latency, and for this bridge that
// case is weak: a parked long-poll is handed a command the moment one is queued,
// so the only cost is the round trip before the plugin's next poll parks again.
// This measures both, against the real bridge, so the claim in the code is a
// number rather than an intuition.
import { StudioBridge } from "../../dist/bridge.js";
import { MAX_PROTOCOL_VERSION } from "../../dist/protocol.js";
import WebSocket from "ws";

const N = 200;

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return `p50 ${q(0.5).toFixed(2)}ms  p90 ${q(0.9).toFixed(2)}ms  p99 ${q(0.99).toFixed(2)}ms  max ${s[s.length - 1].toFixed(2)}ms`;
}

async function measureLongPoll() {
  const bridge = new StudioBridge(0);
  await bridge.start();
  const port = bridge.boundPort;
  const post = (path, body) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bridge.token}` },
      body: JSON.stringify(body),
    });

  let running = true;
  // A plugin that answers instantly and re-polls at once: the best case.
  (async () => {
    while (running) {
      const res = await post("/poll", { protocol: MAX_PROTOCOL_VERSION, writeEnabled: true }).catch(() => null);
      if (!running || !res) break;
      const body = await res.json().catch(() => ({}));
      if (body?.id) await post("/result", { id: body.id, ok: true, result: { ok: true } }).catch(() => {});
    }
  })();
  await new Promise((r) => setTimeout(r, 150));

  const samples = [];
  for (let i = 0; i < N; i++) {
    const t = performance.now();
    await bridge.send("read", {}, 5000);
    samples.push(performance.now() - t);
  }
  running = false;
  await new Promise((r) => setTimeout(r, 50));
  await bridge.stop();
  return samples;
}

async function measureWebSocket() {
  const bridge = new StudioBridge(0);
  await bridge.start();
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.boundPort}/ws`, {
    headers: { authorization: `Bearer ${bridge.token}` },
  });
  await new Promise((res, rej) => {
    ws.on("open", res);
    ws.on("error", rej);
  });
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "command") ws.send(JSON.stringify({ type: "result", id: m.id, ok: true, result: { ok: true } }));
  });
  ws.send(JSON.stringify({ type: "hello", protocol: MAX_PROTOCOL_VERSION, writeEnabled: true }));
  await new Promise((r) => setTimeout(r, 80));

  const samples = [];
  for (let i = 0; i < N; i++) {
    const t = performance.now();
    await bridge.send("read", {}, 5000);
    samples.push(performance.now() - t);
  }
  ws.close();
  await bridge.stop();
  return samples;
}

console.log(`sequential commands, n=${N}, loopback\n`);
console.log(`long-poll  ${stats(await measureLongPoll())}`);
console.log(`websocket  ${stats(await measureWebSocket())}`);
console.log(`
Both are noise next to Studio doing the work — a mutate is tens of milliseconds
before anything touches the DataModel. So the socket is not worth having for
latency. It is worth having because the plugin can push when nothing has been
asked of it, which long-poll cannot do at all.`);
process.exit(0);
