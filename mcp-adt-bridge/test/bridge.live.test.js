// LIVE end-to-end: MCP bridge (stdio) -> ported sidecar (HTTP) -> REAL SAP.
// The full chain a Claude Code agent exercises in production. Read-only.
// Requires SAP_HOST/SAP_USER/SAP_PASSWORD (fails loudly if missing).
// Invoke: npm run test:live
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(HERE, "..", "server.js");
const SIDECAR = join(HERE, "..", "..", "sap-adt-sidecar", "server.js");

const missing = ["SAP_HOST", "SAP_USER", "SAP_PASSWORD"].filter((v) => !process.env[v]);
if (missing.length) {
  throw new Error(`test:live requires ${missing.join(", ")} — live tests are never skipped and never faked.`);
}

let sidecar;
let sidecarUrl;
let bridge;
const pending = new Map();
let counter = 0;

before(async () => {
  sidecar = spawn(process.execPath, [SIDECAR], {
    env: { ...process.env, ADAPTER_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  sidecarUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("sidecar did not start")), 5000);
    let out = "";
    sidecar.stdout.on("data", (d) => {
      out += d.toString();
      const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
  });
  bridge = spawn(process.execPath, [BRIDGE], {
    env: { ...process.env, ADT_MCP_URL: sidecarUrl },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  bridge.stdout.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
});
after(() => {
  bridge?.kill();
  sidecar?.kill();
});

function request(method, params, timeoutMs = 120_000) {
  const id = ++counter;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, timeoutMs);
    pending.set(id, (m) => {
      clearTimeout(timer);
      resolve(m);
    });
    bridge.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

test("full chain: bridge stdio -> sidecar -> live SAP connection_status", async () => {
  const init = await request("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
  assert.equal(init.result.serverInfo.name, "sap-adt");
  const r = await request("tools/call", { name: "aws_abap_cb_connection_status", arguments: {} });
  assert.notEqual(r.result.isError, true, r.result.content?.[0]?.text?.slice(0, 300));
  const status = JSON.parse(r.result.content[0].text);
  assert.equal(status.connected, true, "real SAP session through the full chain");
});

test("full chain: source read of a standard class", async () => {
  const cls = process.env.SAP_TEST_CLASS ?? "CL_ABAP_TSTMP";
  const r = await request("tools/call", {
    name: "aws_abap_cb_get_source",
    arguments: { object_name: cls, object_type: "CLAS" },
  });
  assert.notEqual(r.result.isError, true, r.result.content?.[0]?.text?.slice(0, 300));
  const payload = JSON.parse(r.result.content[0].text);
  assert.match(payload.source, /CLASS/i);
});
