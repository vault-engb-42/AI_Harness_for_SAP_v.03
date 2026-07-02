// End-to-end tests for the MCP-ADT bridge: spawn the real server process,
// speak newline-delimited JSON-RPC over stdio, and let it make real HTTP calls
// to the stub sidecar fixture. No mocks — the actual code path is exercised.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startStub } from "./adt-stub.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "server.js");

let stub;
before(async () => {
  stub = await startStub();
});
after(async () => {
  await stub.close();
});

function startBridge(extraEnv = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ADT_MCP_URL: stub.url, ...extraEnv },
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
  const request = (method, params, timeoutMs = 2500) => {
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

test("tools/call forwards a read tool to the sidecar and returns its result", async () => {
  const b = startBridge();
  try {
    const r = await b.request("tools/call", {
      name: "aws_abap_cb_get_source",
      arguments: { object_name: "ZDEMO", object_type: "PROG" },
    });
    assert.notEqual(r.result.isError, true);
    const text = r.result.content[0].text;
    assert.ok(text.includes("hello from stub"), `expected forwarded source, got: ${text}`);
  } finally {
    b.close();
  }
});

test("write tools are blocked by default (P5 fail-closed)", async () => {
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

test("write tools run when HARNESS_ADT_ALLOW_WRITE=1", async () => {
  const b = startBridge({ HARNESS_ADT_ALLOW_WRITE: "1" });
  try {
    const r = await b.request("tools/call", {
      name: "aws_abap_cb_create_object",
      arguments: { name: "ZNEW", type: "CLAS", package: "$TMP", transport_request: "K900001" },
    });
    assert.notEqual(r.result.isError, true);
    assert.ok(r.result.content[0].text.includes('"created":true'));
  } finally {
    b.close();
  }
});
