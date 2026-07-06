// End-to-end test for the greenfield MCP: spawn the REAL server process, speak
// newline-delimited JSON-RPC over stdio, and run a REAL grounding lookup against
// the on-disk SAP cloudification dataset. No mocks.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "server.js");

function startServer() {
  const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
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
  const request = (method, params, timeoutMs = 15000) => {
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

test("greenfield MCP initializes and lists the ground_released_apis tool", async () => {
  const srv = startServer();
  after(() => srv.close());
  const init = await srv.request("initialize", {});
  assert.equal(init.result.serverInfo.name, "greenfield");
  const list = await srv.request("tools/list", {});
  assert.ok(list.result.tools.some((t) => t.name === "ground_released_apis"));
});

test("ground_released_apis returns a real grounding pack with the deprecated successor", async () => {
  const srv = startServer();
  after(() => srv.close());
  await srv.request("initialize", {});
  const res = await srv.request("tools/call", { name: "ground_released_apis", arguments: { refs: ["CL_A4C_BC_FACTORY", "ACTVT", "CI_DCLS_CHK"] } });
  const payload = JSON.parse(res.result.content[0].text);
  assert.match(payload.pack, /CL_BCFG_CD_REUSE_API_FACTORY/, "renders the released successor");
  assert.equal(payload.counts.deprecated, 1);
  assert.equal(payload.counts.released, 1);
  assert.equal(payload.counts.notToBeReleased, 1);
});

test("ground_released_apis harvests refs from design text when refs omitted", async () => {
  const srv = startServer();
  after(() => srv.close());
  await srv.request("initialize", {});
  const res = await srv.request("tools/call", { name: "ground_released_apis", arguments: { text: "The behavior wraps CL_A4C_BC_FACTORY to build the order." } });
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.counts.deprecated, 1);
});

test("greenfield MCP lists the lint_abap_cloud tool", async () => {
  const srv = startServer();
  after(() => srv.close());
  await srv.request("initialize", {});
  const list = await srv.request("tools/list", {});
  assert.ok(list.result.tools.some((t) => t.name === "lint_abap_cloud"));
});

test("lint_abap_cloud parses real ABAP and returns blocking findings + a repair brief", async () => {
  const srv = startServer();
  after(() => srv.close());
  await srv.request("initialize", {});
  const source = "REPORT zr_x.\nSTART-OF-SELECTION.\n  WRITE 'x'.\n  CALL FUNCTION 'Z_FM'.";
  const res = await srv.request("tools/call", { name: "lint_abap_cloud", arguments: { files: [{ filename: "zr_x.prog.abap", source }] } });
  const payload = JSON.parse(res.result.content[0].text);
  assert.ok(payload.errorCount >= 1, "WRITE is a blocking error");
  assert.ok(payload.findings.some((f) => f.rule_id === "gf-cloud-no-write"));
  assert.match(payload.repair, /gf-cloud-no-write/);
});

test("an unknown tool is a JSON-RPC error", async () => {
  const srv = startServer();
  after(() => srv.close());
  await srv.request("initialize", {});
  const res = await srv.request("tools/call", { name: "nope", arguments: {} });
  assert.ok(res.error, "unknown tool returns an error");
});
