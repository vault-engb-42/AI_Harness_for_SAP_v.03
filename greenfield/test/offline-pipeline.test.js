// GF-3e — offline dry-run of the greenfield pipeline hand-off. Drives the REAL
// greenfield MCP server over stdio through the exact sequence the lanes chain,
// with NO SAP connection and NO mocks:
//   1. /abap-design grounding  -> ground_released_apis over the design gap text
//   2. /abap-implement lint     -> lint_abap_cloud over the generator's first cut
//   3. lint->regenerate loop     -> fix per the repair brief, re-lint clean
//   4. /abap-validate pre-flight -> lint_abap_cloud the fixed source == 0 errors
// Proves the two offline tools hand off as a pipeline against the real dataset
// and the real parser.
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
  const call = async (name, args) => {
    const res = await request("tools/call", { name, arguments: args });
    return JSON.parse(res.result.content[0].text);
  };
  return { request, call, close: () => child.kill() };
}

// The generator's FIRST cut: uses a deprecated released API and a forbidden WRITE.
const DIRTY_SOURCE = `CLASS zcl_approval DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS build.
ENDCLASS.
CLASS zcl_approval IMPLEMENTATION.
  METHOD build.
    DATA lo TYPE REF TO cl_a4c_bc_factory.
    WRITE 'building'.
  ENDMETHOD.
ENDCLASS.`;

// After the lint->regenerate loop: released successor, no WRITE, Clean-ABAP
// (inline DATA(), FINAL class) so the regenerated source is genuinely violation-free.
const FIXED_SOURCE = `CLASS zcl_approval DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS build RETURNING VALUE(rv) TYPE i.
ENDCLASS.
CLASS zcl_approval IMPLEMENTATION.
  METHOD build.
    DATA(factory) = cl_bcfg_cd_reuse_api_factory=>get( ).
    rv = 1.
  ENDMETHOD.
ENDCLASS.`;

test("offline greenfield pipeline hands off: ground -> lint -> repair -> re-lint clean", async () => {
  const srv = startServer();
  after(() => srv.close());
  await srv.request("initialize", {});

  // Stage 1 — /abap-design grounding. The design gap names a deprecated SAP API;
  // grounding must flag it and name the released successor BEFORE any code exists.
  const grounded = await srv.call("ground_released_apis", {
    text: "Build a custom approval BO. The behavior wraps CL_A4C_BC_FACTORY to build the configuration and exposes a released RAP action.",
  });
  assert.equal(grounded.counts.deprecated, 1, "design grounding flags the deprecated dependency");
  assert.match(grounded.pack, /CL_BCFG_CD_REUSE_API_FACTORY/, "grounding names the released successor for the design");

  // Stage 2 — /abap-implement lint. The generator's first cut ignored the grounding
  // (deprecated API) and used a forbidden WRITE; the offline lint must block it.
  const firstLint = await srv.call("lint_abap_cloud", { files: [{ filename: "zcl_approval.clas.abap", source: DIRTY_SOURCE }] });
  assert.ok(firstLint.errorCount >= 2, "the first cut is blocked on >=2 errors");
  const firstRules = firstLint.findings.map((f) => f.rule_id);
  assert.ok(firstRules.includes("gf-ground-deprecated"), "lint catches the deprecated API the design warned about");
  assert.ok(firstRules.includes("gf-cloud-no-write"), "lint catches the forbidden WRITE");
  assert.match(firstLint.repair, /gf-ground-deprecated/, "the repair brief drives the lint->regenerate loop");

  // Stage 3 + 4 — after regenerating per the repair brief (successor API, no WRITE),
  // the same lint clears, which is exactly the /abap-validate offline pre-flight.
  const preflight = await srv.call("lint_abap_cloud", { files: [{ filename: "zcl_approval.clas.abap", source: FIXED_SOURCE }] });
  assert.equal(preflight.errorCount, 0, "the regenerated source clears the lint gate + validate pre-flight");
  assert.match(preflight.repair, /no .*violation/i, "a clean pre-flight reports no violations");
});
