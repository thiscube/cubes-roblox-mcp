import { createMcpServer } from "../../dist/server.js";
import { installFakeDump } from "./_fixtures.mjs";
import { ALL_TOOLS } from "../../dist/tools/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Ajv = require("ajv").default ?? require("ajv");
installFakeDump();
const ajv = new Ajv({ strict: false, allErrors: true });

// Hostile-but-plausible plugin answers: right field names, wrong types.
const HOSTILE = { ok: true, applied: "3", results: {}, instances: {}, children: "none",
                  camera: [], cursor: 7, snapshot: false, unchanged: "yes", lint: "clean",
                  level: "catastrophic", summary: 12, detail: {}, uncertain: "maybe",
                  retry_with: [], result: null };
class Hostile { connected=true; writeEnabled=true; async send(){ return HOSTILE; } }
class Benign  { connected=true; writeEnabled=true; async send(){ return { ok:true, applied:1, results:[] }; } }

async function run(TransportClass, label) {
  const server = createMcpServer(new TransportClass());
  const h = server._requestHandlers; const signal = new AbortController().signal;
  const call = (n,a={}) => h.get("tools/call")({method:"tools/call",params:{name:n,arguments:a}},{signal});
  for (const t of ALL_TOOLS) await call(t.name, {});
  const { tools } = await h.get("tools/list")({method:"tools/list",params:{}},{signal});
  const schemas = new Map(tools.map(t=>[t.name, t.outputSchema]));
  const missing = tools.filter(t=>!t.outputSchema).map(t=>t.name);
  if (missing.length) console.log(`  MISSING outputSchema: ${missing.join(", ")}`);
  const fails = [];
  for (const name of schemas.keys()) {
    const res = await call(name, {});
    const sc = res.structuredContent;
    if (sc === undefined) { fails.push(`${name}: NO structuredContent`); continue; }
    const sch = schemas.get(name);
    const ok = ajv.validate(sch, sc);
    if (!ok) fails.push(`${name}: ${ajv.errors.map(e=>`${e.instancePath||"/"} ${e.message}`).join("; ")}\n      payload=${JSON.stringify(sc).slice(0,220)}`);
  }
  console.log(`${label}: ${fails.length} schema violations of ${schemas.size} tools`);
  for (const f of fails) console.log("   -", f);
}
await run(Benign, "BENIGN plugin ");
await run(Hostile, "HOSTILE plugin");
