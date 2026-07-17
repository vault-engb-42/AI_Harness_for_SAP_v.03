// LIVE WRITE-PATH end-to-end: the three tools the TALOS reference faked,
// exercised for REAL against a DEV system (P5: writes only ever hit DEV).
// Creates a class in LIVE_WRITE_PACKAGE, updates its source, writes its test
// class, syntax-checks and activates it. The object stays in the package for
// operator inspection (transportable packages need LIVE_WRITE_TRANSPORT).
//
// Requires (fails loudly if missing): SAP_HOST, SAP_USER, SAP_PASSWORD,
// LIVE_WRITE_PACKAGE (e.g. $TMP or ZLOCAL; set LIVE_WRITE_TRANSPORT for
// transportable packages).
// Invoke: npm run test:live:write   — deliberately NOT part of test:live.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "server.js");

const missing = ["SAP_HOST", "SAP_USER", "SAP_PASSWORD", "LIVE_WRITE_PACKAGE"].filter((v) => !process.env[v]);
if (missing.length) {
  throw new Error(
    `test:live:write requires ${missing.join(", ")} — writes run ONLY against a DEV system (P5). ` +
      `Live tests are never skipped and never faked.`,
  );
}

const PKG = process.env.LIVE_WRITE_PACKAGE;
const TRANSPORT = process.env.LIVE_WRITE_TRANSPORT;
// Unique-enough name inside the 30-char limit; timestamp keeps reruns clean.
const CLASS_NAME = `ZCL_HARNESS_E2E_${Date.now().toString(36).toUpperCase()}`.slice(0, 30);

const CLASS_SOURCE = `CLASS ${CLASS_NAME.toLowerCase()} DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS answer RETURNING VALUE(rv_answer) TYPE i.
ENDCLASS.
CLASS ${CLASS_NAME.toLowerCase()} IMPLEMENTATION.
  METHOD answer.
    rv_answer = 42.
  ENDMETHOD.
ENDCLASS.`;

const TEST_SOURCE = `CLASS ltcl_answer DEFINITION FINAL FOR TESTING DURATION SHORT RISK LEVEL HARMLESS.
  PRIVATE SECTION.
    METHODS answer_is_42 FOR TESTING.
ENDCLASS.
CLASS ltcl_answer IMPLEMENTATION.
  METHOD answer_is_42.
    DATA(lo) = NEW ${CLASS_NAME.toLowerCase()}( ).
    cl_abap_unit_assert=>assert_equals( act = lo->answer( ) exp = 42 ).
  ENDMETHOD.
ENDCLASS.`;

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

test(`create_object creates ${CLASS_NAME} in ${PKG} for real`, async () => {
  const { status, json } = await call("aws_abap_cb_create_object", {
    name: CLASS_NAME,
    type: "CLAS",
    package: PKG,
    description: "harness live write-path E2E",
    transport_request: TRANSPORT,
  });
  assert.equal(status, 200, JSON.stringify(json).slice(0, 400));
  assert.equal(json.result.created, true);
});

test("update_source writes the real implementation (lock -> PUT -> unlock)", async () => {
  const { status, json } = await call("aws_abap_cb_update_source", {
    object_name: CLASS_NAME,
    object_type: "CLAS",
    source_code: CLASS_SOURCE,
    transport_request: TRANSPORT,
  });
  assert.equal(status, 200, JSON.stringify(json).slice(0, 400));
  assert.equal(json.result.updated, true);
});

test("the written source reads back from SAP", async () => {
  const { status, json } = await call("aws_abap_cb_get_source", { object_name: CLASS_NAME, object_type: "CLAS" });
  assert.equal(status, 200, JSON.stringify(json).slice(0, 400));
  assert.match(json.result.source, /rv_answer = 42/);
});

test("create_or_update_test_class writes the real testclasses include", async () => {
  const { status, json } = await call("aws_abap_cb_create_or_update_test_class", {
    class_name: CLASS_NAME,
    test_source: TEST_SOURCE,
    transport_request: TRANSPORT,
  });
  assert.equal(status, 200, JSON.stringify(json).slice(0, 400));
  assert.equal(json.result.created, true);
});

test("check_syntax passes on the written class", async () => {
  const { status, json } = await call("aws_abap_cb_check_syntax", { object_name: CLASS_NAME, object_type: "CLAS" });
  assert.equal(status, 200, JSON.stringify(json).slice(0, 400));
  assert.equal(json.result.has_errors, false, JSON.stringify(json.result.errors));
});

test("activate_object activates the written class", async () => {
  const { status, json } = await call("aws_abap_cb_activate_object", { object_name: CLASS_NAME, object_type: "CLAS" });
  assert.equal(status, 200, JSON.stringify(json).slice(0, 400));
  assert.equal(json.result.success, true, JSON.stringify(json.result.errors));
});

test("run_unit_tests executes the real ABAP Unit test", async () => {
  const { status, json } = await call("aws_abap_cb_run_unit_tests", { object_name: CLASS_NAME, object_type: "CLAS" });
  assert.equal(status, 200, JSON.stringify(json).slice(0, 400));
  const results = json.result.results;
  assert.ok(results.length > 0, "unit tests ran");
  assert.ok(results.every((r) => r.status === "passed"), JSON.stringify(results));
});

// G3 live write-path for SRVB + TABL — BLOCKED-ON-DEV-CREDS (documented, not faked).
// The G3 URI maps + create bodies for TABL (source-based, blue:blueSource) and SRVB
// (config-only service binding) are wired and unit-covered offline (test/lib.test.js,
// test/write.test.js). The LIVE round-trip is deferred, not because it is unimportant but
// because it needs a full RAP object graph this class-only fixture does not build:
//   - TABL: create_object (TABL) -> update_source (a `define table zfoo { … }` DDL) -> activate_object.
//   - SRVB: create_object (SRVB, service_definition = an ACTIVATED SRVD that in turn projects
//     an activated CDS/RAP BO) -> activate_object, which PUBLISHES the service via POST
//     …/businessservices/odatav4/publishjobs (G10) -> probe the published-URL / $metadata for
//     reachability. The publish request + binding-type are unit-covered; the round-trip is live.
// Per the repo's no-fake rule (README "Live tests are never skipped and never faked"), this
// chain is added when DEV creds AND a seeded SRVD/CDS fixture graph exist — not stubbed here.
