// LIVE end-to-end tests: ported sidecar -> REAL SAP system. Read-only tools.
// Requires (fails loudly if missing — never skipped, never faked):
//   SAP_HOST, SAP_USER, SAP_PASSWORD  (required)
//   SAP_PORT (default 44300), SAP_CLIENT (default 100)
//   SAP_TEST_PACKAGE (default SABAPDEMOS), SAP_TEST_CLASS (default CL_ABAP_TSTMP)
// Self-signed certificate? run with NODE_TLS_REJECT_UNAUTHORIZED=0.
// Invoke: npm run test:live
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "server.js");

const REQUIRED = ["SAP_HOST", "SAP_USER", "SAP_PASSWORD"];
const missing = REQUIRED.filter((v) => !process.env[v]);
if (missing.length) {
  throw new Error(
    `test:live requires live SAP credentials — set ${missing.join(", ")} ` +
      `(plus optional SAP_PORT/SAP_CLIENT/SAP_TEST_PACKAGE/SAP_TEST_CLASS). ` +
      `Live tests are never skipped and never faked.`,
  );
}

const PKG = process.env.SAP_TEST_PACKAGE ?? "SABAPDEMOS";
const CLS = process.env.SAP_TEST_CLASS ?? "CL_ABAP_TSTMP";

let child;
let base;
before(async () => {
  child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ADAPTER_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("sidecar did not start")), 5000);
    let out = "";
    child.stdout.on("data", (d) => {
      out += d.toString();
      const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
  });
});
after(() => child.kill());

async function call(tool, params = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-SAP-Host": process.env.SAP_HOST,
      "X-SAP-Port": process.env.SAP_PORT ?? "44300",
      "X-SAP-Client": process.env.SAP_CLIENT ?? "100",
      "X-SAP-User": process.env.SAP_USER,
      "X-SAP-Password": process.env.SAP_PASSWORD,
    },
    body: JSON.stringify({ tool, params }),
    signal: AbortSignal.timeout(120_000),
  });
  const json = await res.json();
  return { status: res.status, json };
}

test("connection_status authenticates against the live system", async () => {
  const { status, json } = await call("aws_abap_cb_connection_status");
  assert.equal(status, 200, JSON.stringify(json).slice(0, 300));
  assert.equal(json.result.connected, true, "real CSRF-backed session established");
});

test("get_objects enumerates a real package", async () => {
  const { status, json } = await call("aws_abap_cb_get_objects", { package_name: PKG });
  assert.equal(status, 200, JSON.stringify(json).slice(0, 300));
  assert.ok(Array.isArray(json.result.objects), "objects array");
});

test("search_object finds standard objects", async () => {
  const { status, json } = await call("aws_abap_cb_search_object", { query: "CL_ABAP*", max_results: 5 });
  assert.equal(status, 200, JSON.stringify(json).slice(0, 300));
  assert.ok(json.result.objects.length > 0, "search returned hits");
});

test("get_source reads a real class", async () => {
  const { status, json } = await call("aws_abap_cb_get_source", { object_name: CLS, object_type: "CLAS" });
  assert.equal(status, 200, JSON.stringify(json).slice(0, 300));
  assert.match(json.result.source, /CLASS/i, "real ABAP source returned");
});

test("check_syntax runs a real server-side check", async () => {
  const { status, json } = await call("aws_abap_cb_check_syntax", { object_name: CLS, object_type: "CLAS" });
  assert.equal(status, 200, JSON.stringify(json).slice(0, 300));
  assert.equal(typeof json.result.has_errors, "boolean");
});

test("get_transport_requests queries real CTS data", async () => {
  const { status, json } = await call("aws_abap_cb_get_transport_requests", {});
  assert.equal(status, 200, JSON.stringify(json).slice(0, 300));
  assert.ok(Array.isArray(json.result.transports));
});

test("scmon/smodilog report data_available:false with the stated reason", async () => {
  const scmon = await call("aws_abap_cb_query_scmon_usage", {});
  assert.equal(scmon.json.result.data_available, false);
  assert.match(scmon.json.result.reason, /ADT REST/);
});
