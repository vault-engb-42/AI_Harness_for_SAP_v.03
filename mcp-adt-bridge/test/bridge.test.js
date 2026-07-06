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
