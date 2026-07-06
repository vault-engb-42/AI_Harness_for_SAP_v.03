// End-to-end tests for the ported sidecar's HTTP envelope: spawn the REAL
// server process and make REAL HTTP requests to it. No mocks, no stubs, no
// fakes. Everything that needs a live SAP behind the sidecar lives in
// test:live (sidecar.live.test.js); these tests cover the envelope contract
// and REAL failure paths (bad input, missing credentials, unreachable SAP).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "server.js");

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

async function mcp(body, headers = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

const CREDS = {
  "X-SAP-Host": "127.0.0.1",
  "X-SAP-Port": "1",
  "X-SAP-User": "TESTER",
  "X-SAP-Password": "not-a-real-password",
};

test("GET /health reports real mode and no mock backend", async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "healthy");
  assert.equal(body.mode, "real");
  assert.match(body.mode_reason, /no fakes/i);
});

test("POST /mcp with unparseable JSON returns 400 Invalid JSON body", async () => {
  const { status, json } = await mcp("{not json", CREDS);
  assert.equal(status, 400);
  assert.match(json.detail, /Invalid JSON body/);
});

test("POST /mcp without a tool field returns 400", async () => {
  const { status, json } = await mcp({ params: {} }, CREDS);
  assert.equal(status, 400);
  assert.match(json.detail, /Missing 'tool' field/);
});

test("POST /mcp with an unknown tool returns 404", async () => {
  const { status, json } = await mcp({ tool: "not_a_tool", params: {} }, CREDS);
  assert.equal(status, 404);
  assert.match(json.detail, /Unknown tool: not_a_tool/);
});

test("missing X-SAP credential headers are rejected with the exact list", async () => {
  const { status, json } = await mcp({ tool: "aws_abap_cb_connection_status", params: {} }, { "X-SAP-Host": "h" });
  assert.equal(status, 400);
  assert.match(json.detail, /Missing required headers: X-SAP-User, X-SAP-Password/);
});

test("an unreachable SAP host surfaces a REAL connection failure, sanitized", async () => {
  // Port 1 on loopback is genuinely closed: the sidecar makes a REAL fetch to
  // SAP and must surface the failure without leaking credentials.
  const { status, json } = await mcp({ tool: "aws_abap_cb_connection_status", params: {} }, CREDS);
  assert.ok(status >= 400, `expected error status, got ${status}`);
  assert.ok(!JSON.stringify(json).includes("not-a-real-password"), "password never leaks");
});

test("all 17 tools are routable (non-404 for every registered name)", async () => {
  const names = [
    "aws_abap_cb_connection_status", "aws_abap_cb_get_objects", "aws_abap_cb_get_source",
    "aws_abap_cb_search_object", "aws_abap_cb_get_test_classes", "aws_abap_cb_get_transport_requests",
    "aws_abap_cb_query_scmon_usage", "aws_abap_cb_query_smodilog_modifications", "aws_abap_cb_check_syntax",
    "aws_abap_cb_activate_object", "aws_abap_cb_activate_objects_batch", "aws_abap_cb_run_atc_check",
    "aws_abap_cb_run_unit_tests", "aws_abap_cb_get_migration_analysis", "aws_abap_cb_create_object",
    "aws_abap_cb_update_source", "aws_abap_cb_create_or_update_test_class",
  ];
  for (const tool of names) {
    const { status } = await mcp({ tool, params: {} }, CREDS);
    assert.notEqual(status, 404, `${tool} not routed`);
  }
});
