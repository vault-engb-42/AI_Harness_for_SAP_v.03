// LIVE end-to-end: analyser MCP -> ported sidecar -> REAL SAP -> full local
// analysis pipeline. Read-only against SAP; writes only the local report.
// Requires SAP_HOST/SAP_USER/SAP_PASSWORD (+ SAP_TEST_PACKAGE, default
// SABAPDEMOS). Fails loudly if missing. Invoke: npm run test:live
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { validateFindings } from "../../src/validate-findings.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ANALYSER = join(HERE, "..", "..", "server.js");
const SIDECAR = join(HERE, "..", "..", "..", "sap-adt-sidecar", "server.js");
const OUT = join(tmpdir(), "analyser-live-e2e", "findings.json");

const missing = ["SAP_HOST", "SAP_USER", "SAP_PASSWORD"].filter((v) => !process.env[v]);
if (missing.length) {
  throw new Error(`test:live requires ${missing.join(", ")} — live tests are never skipped and never faked.`);
}
const PKG = process.env.SAP_TEST_PACKAGE ?? "SABAPDEMOS";

let sidecar;
let analyser;
const pending = new Map();
let counter = 0;

before(async () => {
  sidecar = spawn(process.execPath, [SIDECAR], {
    env: { ...process.env, ADAPTER_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const sidecarUrl = await new Promise((resolve, reject) => {
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
  analyser = spawn(process.execPath, [ANALYSER], {
    env: { ...process.env, ADT_MCP_URL: sidecarUrl },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  analyser.stdout.on("data", (d) => {
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
  analyser?.kill();
  sidecar?.kill();
  rmSync(join(tmpdir(), "analyser-live-e2e"), { recursive: true, force: true });
});

function request(method, params, timeoutMs = 600_000) {
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
    analyser.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

test("analyse_source_system: live package pull -> local parse -> schema-valid report", async () => {
  await request("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
  const r = await request("tools/call", {
    name: "analyse_source_system",
    arguments: { package: PKG, source_system: process.env.SAP_HOST, out: OUT },
  });
  assert.notEqual(r.result.isError, true, r.result.content?.[0]?.text?.slice(0, 400));
  const summary = JSON.parse(r.result.content[0].text);
  assert.ok(summary.objects > 0, "objects pulled from the live system");
  const doc = JSON.parse(readFileSync(OUT, "utf8"));
  const { valid, errors } = validateFindings(doc);
  assert.ok(valid, `schema errors: ${errors.join("; ")}`);
  assert.ok(doc.graph.nodes.length > 0, "graph built from live source");
});
