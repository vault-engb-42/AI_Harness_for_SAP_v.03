import { test } from "node:test";
import assert from "node:assert/strict";
import { DependencyGraph } from "../src/cpg.js";
import { loadRegistry } from "../src/abaplint-loader.js";
import * as cloud from "../src/cloudification.js";
import { releasedApiRule } from "../rules/released-api.js";
import { invariantAuthCheckRule } from "../rules/invariant-auth-check.js";
import { runRules } from "../src/rule-engine.js";
import { ALL_RULES } from "../rules/index.js";

// ---- released-api (graph + real cloudification registry, no mocks) ----

function graphWith(edges) {
  const g = new DependencyGraph();
  for (const e of edges) {
    g.addNode({ id: e.source, kind: "class", object: e.source, namespace: "Z" });
    g.addEdge(e);
  }
  return g;
}

test("released-api flags a uses-table edge to a deprecated SAP table (priority-2)", () => {
  const g = graphWith([{ source: "ZCL_X", target: "BAPIRET1", kind: "uses-table" }]);
  const findings = releasedApiRule.check({ graph: g, cloud });
  const f = findings.find((x) => x.object === "ZCL_X");
  assert.ok(f, "finding raised");
  assert.equal(f.severity, "priority-2");
  assert.match(f.message, /BAPIRET1/);
  assert.match(f.message, /deprecated/);
});

test("released-api suggests the released successor when the dataset has one", () => {
  const g = graphWith([{ source: "ZCL_X", target: "CL_A4C_BC_FACTORY", kind: "inherits" }]);
  const [f] = releasedApiRule.check({ graph: g, cloud });
  assert.ok(f.suggestion?.includes("CL_BCFG_CD_REUSE_API_FACTORY"), "successor suggested");
});

test("released-api does NOT flag a released target", () => {
  const g = graphWith([{ source: "ZCL_X", target: "/ATL/BLART_RANGE", kind: "uses-table" }]);
  assert.deepEqual(releasedApiRule.check({ graph: g, cloud }), []);
});

test("released-api does NOT flag unknown (customer) targets", () => {
  const g = graphWith([{ source: "ZCL_X", target: "ZCL_MY_HELPER", kind: "call-function" }]);
  assert.deepEqual(releasedApiRule.check({ graph: g, cloud }), []);
});

test("released-api ignores edge kinds whose target is not an object name", () => {
  const g = graphWith([{ source: "ZCL_X", target: "ZCL_X.SOME_METHOD", kind: "call-method" }]);
  assert.deepEqual(releasedApiRule.check({ graph: g, cloud }), []);
});

// ---- P4 invariant (real registry, statement walk) ----

const AUTH_OK = `REPORT zr_ok.
START-OF-SELECTION.
  AUTHORITY-CHECK OBJECT 'S_CARRID' ID 'ACTVT' FIELD '03'.
  IF sy-subrc <> 0.
    RETURN.
  ENDIF.`;

const AUTH_BAD = `REPORT zr_bad.
START-OF-SELECTION.
  AUTHORITY-CHECK OBJECT 'S_CARRID' ID 'ACTVT' FIELD '03'.
  WRITE 'done'.`;

test("invariant rule passes when AUTHORITY-CHECK is followed by SY-SUBRC", () => {
  const reg = loadRegistry([{ filename: "zr_ok.prog.abap", source: AUTH_OK }]);
  assert.deepEqual(invariantAuthCheckRule.check({ reg }), []);
});

test("invariant rule flags AUTHORITY-CHECK with no following SY-SUBRC (priority-1)", () => {
  const reg = loadRegistry([{ filename: "zr_bad.prog.abap", source: AUTH_BAD }]);
  const [f] = invariantAuthCheckRule.check({ reg });
  assert.ok(f, "violation raised");
  assert.equal(f.severity, "priority-1");
  assert.equal(f.object, "ZR_BAD");
  assert.equal(f.family, "invariant");
  assert.match(f.message, /AUTHORITY-CHECK/);
});

// ---- through the engine ----

test("ALL_RULES run through the engine and stamp rule_id/family", () => {
  const reg = loadRegistry([{ filename: "zr_bad.prog.abap", source: AUTH_BAD }]);
  const g = graphWith([{ source: "ZCL_X", target: "BAPIRET1", kind: "uses-table" }]);
  const findings = runRules(ALL_RULES, { graph: g, reg, cloud });
  assert.ok(findings.some((f) => f.rule_id === "released-api"));
  assert.ok(findings.some((f) => f.rule_id === "invariant-authority-check-subrc"));
});
