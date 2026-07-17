// End-to-end tests for the MCP-ADT bridge: spawn the REAL server process and
// speak newline-delimited JSON-RPC over stdio. No mocks, no stubs, no fakes —
// everything here exercises the bridge's real code path without substituting
// its dependency. The sidecar round-trip itself is covered by
// bridge.live.test.js (npm run test:live) against the REAL MCP-ADT sidecar.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ADT_TOOLS } from "../adt-tools.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "server.js");

function startBridge(extraEnv = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let buf = "";
  child.stdout.on("data", (d) => {
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
  let counter = 0;
  const request = (method, params, timeoutMs = 5000) => {
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
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  };
  return { request, close: () => child.kill() };
}

test("initialize returns serverInfo and tools capability", async () => {
  const b = startBridge();
  try {
    const r = await b.request("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
    assert.equal(r.error, undefined);
    assert.equal(r.result.serverInfo.name, "sap-adt");
    assert.ok(r.result.capabilities.tools, "advertises tools capability");
  } finally {
    b.close();
  }
});

test("tools/list exposes all 17 ADT tools", async () => {
  const b = startBridge();
  try {
    const r = await b.request("tools/list", {});
    const names = r.result.tools.map((t) => t.name);
    assert.equal(names.length, 17);
    assert.ok(names.includes("aws_abap_cb_get_source"));
    assert.ok(names.includes("aws_abap_cb_run_atc_check"));
    assert.ok(r.result.tools[0].inputSchema, "tools carry an inputSchema");
  } finally {
    b.close();
  }
});

test("write tools are blocked by default (P5 fail-closed) before any network I/O", async () => {
  const b = startBridge();
  try {
    const r = await b.request("tools/call", {
      name: "aws_abap_cb_create_object",
      arguments: { name: "ZNEW", type: "CLAS", package: "$TMP", transport_request: "K900001" },
    });
    assert.equal(r.result.isError, true);
    assert.ok(r.result.content[0].text.startsWith("BLOCKED"));
  } finally {
    b.close();
  }
});

test("unknown tools are rejected with a JSON-RPC error", async () => {
  const b = startBridge();
  try {
    const r = await b.request("tools/call", { name: "not_a_tool", arguments: {} });
    assert.ok(r.error, "error response");
    assert.equal(r.error.code, -32602);
  } finally {
    b.close();
  }
});

// §0.5 bridge->sidecar param contract (G3). The bridge forwards args VERBATIM to the
// sidecar (adt-client.js: POST body {tool, params: args}); it renames nothing. So the
// bridge's advertised params and the sidecar handler's read params must agree EXACTLY:
//  - every param a sidecar handler READS must be advertised (else the MCP client can never
//    send it — `additionalProperties:false` forbids extras — and the write silently breaks
//    the day HARNESS_ADT_ALLOW_WRITE=1);
//  - the bridge must advertise NOTHING the sidecar ignores (else it over-promises a
//    capability that is a silent no-op, e.g. run_unit_tests with_coverage);
//  - every param the handler REQUIRES must be in `required`.
// This table mirrors the sidecar handler signatures (sap-adt-sidecar/handlers/{write,
// quality,read}.js) — the contract the two sides must agree on. Memory
// [[bridge-sidecar-param-drift]]. It fails against the pre-G3 drift (update_source `source`
// vs `source_code`; missing `test_source`; batch {name,type} vs {object_name,object_type};
// `variant` vs `check_variant`) AND the reverse-drift the adversarial pass surfaced
// (create_object `service_definition` unadvertised; run_unit_tests `with_coverage`,
// run_atc_check `transport_number`, search_object `package_name` advertised-but-unread).
const SIDECAR_CONTRACT = {
  aws_abap_cb_create_object: { reads: ["name", "type", "package", "description", "transport_request", "service_definition", "binding_type"], requires: ["name", "type", "package"] },
  aws_abap_cb_update_source: { reads: ["object_name", "object_type", "source_code", "transport_request"], requires: ["object_name", "object_type", "source_code"] },
  aws_abap_cb_create_or_update_test_class: { reads: ["class_name", "test_source", "transport_request"], requires: ["class_name", "test_source"] },
  aws_abap_cb_check_syntax: { reads: ["object_name", "object_type"], requires: ["object_name", "object_type"] },
  aws_abap_cb_activate_object: { reads: ["object_name", "object_type"], requires: ["object_name", "object_type"] },
  aws_abap_cb_run_atc_check: { reads: ["object_name", "object_type", "package_name", "check_variant"], requires: [] },
  aws_abap_cb_run_unit_tests: { reads: ["object_name", "object_type", "with_coverage"], requires: ["object_name"] },
  aws_abap_cb_get_migration_analysis: { reads: ["object_name", "object_type"], requires: ["object_name", "object_type"] },
  aws_abap_cb_search_object: { reads: ["query", "object_type", "max_results"], requires: [] },
};

test("§0.5 bridge schemas advertise every param the sidecar reads, and require what it requires", () => {
  const byName = Object.fromEntries(ADT_TOOLS.map((t) => [t.name, t]));
  for (const [name, contract] of Object.entries(SIDECAR_CONTRACT)) {
    const schema = byName[name]?.inputSchema;
    assert.ok(schema, `${name} must be advertised by the bridge`);
    const props = Object.keys(schema.properties ?? {});
    const required = schema.required ?? [];
    for (const r of contract.reads) assert.ok(props.includes(r), `${name}: inputSchema must advertise '${r}' — the sidecar reads it`);
    for (const req of contract.requires) assert.ok(required.includes(req), `${name}: '${req}' must be in required — the sidecar demands it`);
  }
});

test("§0.5 bridge advertises NOTHING the sidecar ignores (no advertised-but-unread param)", () => {
  const byName = Object.fromEntries(ADT_TOOLS.map((t) => [t.name, t]));
  for (const [name, contract] of Object.entries(SIDECAR_CONTRACT)) {
    const props = Object.keys(byName[name]?.inputSchema?.properties ?? {});
    const reads = new Set(contract.reads);
    const overAdvertised = props.filter((p) => !reads.has(p));
    assert.deepEqual(overAdvertised, [], `${name}: advertises param(s) the sidecar never reads (silent no-op / over-promise): ${overAdvertised.join(", ")}`);
  }
});

test("§0.5 activate_objects_batch item schema uses object_name/object_type (sidecar reads those)", () => {
  const byName = Object.fromEntries(ADT_TOOLS.map((t) => [t.name, t]));
  const items = byName.aws_abap_cb_activate_objects_batch?.inputSchema?.properties?.objects?.items;
  assert.ok(items, "activate_objects_batch must advertise objects[].items");
  const props = Object.keys(items.properties ?? {});
  assert.ok(props.includes("object_name") && props.includes("object_type"), "batch items must use object_name/object_type, not name/type");
  assert.deepEqual([...(items.required ?? [])].sort(), ["object_name", "object_type"], "batch items must require object_name and object_type");
});

test("a read tool surfaces a real transport failure as a tool error (sidecar down)", async () => {
  // Point at a port that is genuinely closed: the bridge makes a REAL fetch,
  // gets a REAL connection failure, and must surface it as isError — the
  // actual behavior a user sees when the sidecar is not running.
  const b = startBridge({ ADT_MCP_URL: "http://127.0.0.1:1" });
  try {
    const r = await b.request("tools/call", {
      name: "aws_abap_cb_connection_status",
      arguments: {},
    });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /ADT error/);
  } finally {
    b.close();
  }
});
