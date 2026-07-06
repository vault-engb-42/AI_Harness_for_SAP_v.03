// End-to-end tests for the analyser MCP server: spawn the REAL server process,
// speak newline-delimited JSON-RPC over stdio, and run a REAL analysis of the
// on-disk fixture bundle (real abaplint parse, real rule packs, real report
// write). No mocks, no stubs, no fakes. The two live modes (source-system /
// via-ADT) require the real MCP-ADT sidecar and live in the test:live suite.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { filesFromBundle } from "../src/modes.js";
import { validateFindings } from "../src/validate-findings.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "server.js");
const FIXTURES = join(HERE, "fixtures");
const OUT_DIR = join(tmpdir(), "analyser-mcp-e2e");

after(() => rmSync(OUT_DIR, { recursive: true, force: true }));

function startServer() {
  // Reports are contained under ANALYSER_OUTPUT_DIR; the test writes to tmp.
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ANALYSER_OUTPUT_DIR: tmpdir() },
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
  const request = (method, params, timeoutMs = 30000) => {
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
  return { request, sendRaw: (s) => child.stdin.write(s), close: () => child.kill() };
}

test("filesFromBundle reads real ABAP/CDS/BDEF files from a directory", () => {
  const files = filesFromBundle(FIXTURES);
  const names = files.map((f) => f.filename).sort();
  assert.deepEqual(names, ["zbp_travel.bdef.asbdef", "zcl_legacy.clas.abap", "zi_travel.ddls.asddls"]);
  assert.ok(files.every((f) => f.source.length > 0), "sources are read");
});

test("filesFromBundle on a missing directory throws an actionable error", () => {
  assert.throws(() => filesFromBundle(join(FIXTURES, "does-not-exist")), /bundle path/i);
});

test("initialize + tools/list expose the four analyser tools", async () => {
  const s = startServer();
  try {
    const init = await s.request("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
    assert.equal(init.result.serverInfo.name, "abap-analyser");
    const r = await s.request("tools/list", {});
    const names = r.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["analyse_bundle", "analyse_source_system", "analyse_via_adt", "get_report"]);
    assert.ok(r.result.tools.every((t) => t.inputSchema), "tools carry input schemas");
  } finally {
    s.close();
  }
});

test("get_report returns a previously written report and errors on a missing one", async () => {
  const s = startServer();
  const out = join(OUT_DIR, "get-report.json");
  try {
    await s.request("tools/call", {
      name: "analyse_bundle",
      arguments: { path: FIXTURES, package: "ZGOLDEN", out },
    });
    const r = await s.request("tools/call", { name: "get_report", arguments: { out } });
    assert.notEqual(r.result.isError, true);
    const doc = JSON.parse(r.result.content[0].text);
    assert.equal(doc.package, "ZGOLDEN");

    const missing = await s.request("tools/call", {
      name: "get_report",
      arguments: { out: join(OUT_DIR, "nope.json") },
    });
    assert.equal(missing.result.isError, true);
    assert.match(missing.result.content[0].text, /no report/i);
  } finally {
    s.close();
  }
});

test("analyse_bundle end-to-end: real fixtures -> real analysis -> schema-valid report on disk", async () => {
  const s = startServer();
  const out = join(OUT_DIR, "findings.json");
  try {
    const r = await s.request("tools/call", {
      name: "analyse_bundle",
      arguments: { path: FIXTURES, package: "ZGOLDEN", source_system: "OFFLINE-BUNDLE", out },
    });
    assert.notEqual(r.result.isError, true, JSON.stringify(r.result).slice(0, 400));
    const summary = JSON.parse(r.result.content[0].text);
    assert.equal(summary.package, "ZGOLDEN");
    assert.equal(summary.objects, 3);
    assert.ok(summary.findings > 0, "findings counted");
    assert.ok(summary.nodes > 0 && summary.edges > 0, "graph counted");
    assert.equal(summary.out, out);

    assert.ok(existsSync(out), "report written");
    const doc = JSON.parse(readFileSync(out, "utf8"));
    const { valid, errors } = validateFindings(doc);
    assert.ok(valid, `schema errors: ${errors.join("; ")}`);
    assert.ok(doc.findings.some((f) => f.rule_id === "released-api"), "cross-pack findings present");
    assert.ok(doc.graph.nodes.some((n) => n.id === "ZCL_LEGACY"));
  } finally {
    s.close();
  }
});

test("analyse_bundle with a bad path returns a tool error, not a crash", async () => {
  const s = startServer();
  try {
    const r = await s.request("tools/call", {
      name: "analyse_bundle",
      arguments: { path: join(FIXTURES, "nope") },
    });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /bundle path/i);
  } finally {
    s.close();
  }
});

test("an out path escaping the report root is rejected (containment)", async () => {
  const s = startServer();
  try {
    const r = await s.request("tools/call", {
      name: "analyse_bundle",
      arguments: { path: FIXTURES, out: join(tmpdir(), "..", "escape", "findings.json") },
    });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /escapes the report root/);
  } finally {
    s.close();
  }
});

test("unknown analyser tools are rejected with a JSON-RPC error", async () => {
  const s = startServer();
  try {
    const r = await s.request("tools/call", { name: "not_a_tool", arguments: {} });
    assert.ok(r.error);
    assert.equal(r.error.code, -32602);
  } finally {
    s.close();
  }
});

test("protocol branches: ping answers, unknown method errors, garbage lines are ignored", async () => {
  const s = startServer();
  try {
    const pong = await s.request("ping", {});
    assert.deepEqual(pong.result, {});
    const unknown = await s.request("no/such/method", {});
    assert.equal(unknown.error.code, -32601);
    // a non-JSON line must not kill the server: send garbage, then ping again
    s.sendRaw("this is not json\n");
    const stillAlive = await s.request("ping", {});
    assert.deepEqual(stillAlive.result, {});
  } finally {
    s.close();
  }
});
