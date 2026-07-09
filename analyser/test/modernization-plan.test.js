import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRegistry } from "../src/abaplint-loader.js";
import * as cloud from "../src/cloudification.js";
import { scoreDebt } from "../src/debt-scorer.js";
import { analyzePackage } from "../src/orchestrator.js";
import { validateFindings } from "../src/validate-findings.js";
import {
  modernizationTarget,
  effortTier,
  priorityRank,
  migrationComplexity,
  transportRank,
  modernizationPlan,
} from "../src/modernization-plan.js";

// §3.D modernization plan. TALOS enrich_node_metadata + transport sequence
// (reference §10 / Appendix B) over our real inputs (debt, normalized PageRank,
// AST metrics). Threshold logic is pure and unit-tested exactly; the assembler is
// checked end-to-end on a real parse with the real cloud oracle (no mocks).

test("modernizationTarget maps node kind -> target artifact (default Review Required)", () => {
  assert.equal(modernizationTarget("class"), "RAP Business Object");
  assert.equal(modernizationTarget("report"), "Fiori Elements App");
  assert.equal(modernizationTarget("function"), "OData V4 Service");
  assert.equal(modernizationTarget("interface"), "RAP Interface");
  assert.equal(modernizationTarget("table"), "CDS View Entity");
  assert.equal(modernizationTarget("cds"), "CDS View Entity");
  assert.equal(modernizationTarget("behavior"), "Review Required");
  assert.equal(modernizationTarget("nonsense"), "Review Required");
});

test("effortTier: XL>0.7|>200, L>0.5|>100, M>0.3|>50, else S (debt OR stmts)", () => {
  assert.equal(effortTier(0.71, 0), "XL");
  assert.equal(effortTier(0, 201), "XL");
  assert.equal(effortTier(0.51, 0), "L");
  assert.equal(effortTier(0, 101), "L");
  assert.equal(effortTier(0.31, 0), "M");
  assert.equal(effortTier(0, 51), "M");
  assert.equal(effortTier(0.3, 50), "S", "thresholds are strict >");
  assert.equal(effortTier(0, 0), "S");
});

test("priorityRank: P1>0.8, P2>0.5, else P3 (strict >)", () => {
  assert.equal(priorityRank(0.81), "P1");
  assert.equal(priorityRank(0.8), "P2");
  assert.equal(priorityRank(0.51), "P2");
  assert.equal(priorityRank(0.5), "P3");
  assert.equal(priorityRank(0), "P3");
});

test("migrationComplexity: 4 strict-> flags fire; the obj_type term is 0 in our taxonomy", () => {
  assert.equal(migrationComplexity({ dyn_call_ratio: 0.4, cyclomatic: 11, nesting: 6, debt: 0.7, kind: "class" }), 4);
  assert.equal(migrationComplexity({ dyn_call_ratio: 0.3, cyclomatic: 10, nesting: 5, debt: 0.6, kind: "class" }), 0);
  assert.equal(migrationComplexity({ dyn_call_ratio: 0, cyclomatic: 0, nesting: 0, debt: 0, kind: "class" }), 0);
});

test("transportRank: cds<intf<class<behavior<everything else", () => {
  assert.equal(transportRank("cds"), 1);
  assert.equal(transportRank("interface"), 2);
  assert.equal(transportRank("class"), 3);
  assert.equal(transportRank("behavior"), 4);
  assert.ok(transportRank("report") > 4 && transportRank("function") > 4 && transportRank("table") > 4);
});

test("assembler: only customer compilation units get a plan entry, sorted by transport order", () => {
  const reg = loadRegistry([
    { filename: "zcl_x.clas.abap", source: "CLASS zcl_x DEFINITION PUBLIC. PUBLIC SECTION. METHODS m. ENDCLASS.\nCLASS zcl_x IMPLEMENTATION. METHOD m. WRITE 'a'. ENDMETHOD. ENDCLASS." },
    { filename: "zr.prog.abap", source: "REPORT zr.\nSTART-OF-SELECTION.\n  WRITE 'a'." },
  ]);
  const g = {
    nodes: [
      { id: "ZCL_X", kind: "class", object: "ZCL_X", namespace: "Z", rank: 0.9 },
      { id: "ZR", kind: "report", object: "ZR", namespace: "Z", rank: 0.4 },
      { id: "T001", kind: "table", object: "T001", namespace: "sap", rank: 1.0 },
    ],
    edges: [],
  };
  const debt = scoreDebt(g, [], reg);
  const plan = modernizationPlan(g, debt, [], reg, cloud);

  assert.equal(plan.objects.length, 2, "SAP node excluded; two customer units");
  assert.deepEqual(plan.objects.map((o) => o.object), ["ZCL_X", "ZR"], "class (transport 3) before report (99)");
  const cls = plan.objects[0];
  assert.equal(cls.modernization_target, "RAP Business Object");
  assert.equal(cls.priority_rank, "P1", "rank 0.9 -> P1");
  assert.equal(plan.objects[1].priority_rank, "P3", "rank 0.4 -> P3");
  assert.equal(plan.summary.total_objects, 2);
  assert.equal(plan.summary.by_priority.P1, 1);
  assert.deepEqual(plan.summary.transport_order, ["ZCL_X", "ZR"]);
});

test("transformations: modernization-family findings join per object with released successor", () => {
  const reg = loadRegistry([{ filename: "zr.prog.abap", source: "REPORT zr.\nSTART-OF-SELECTION.\n  WRITE 'a'." }]);
  const g = { nodes: [{ id: "ZR", kind: "report", object: "ZR", namespace: "Z", rank: 0.4 }], edges: [] };
  const findings = [
    { rule_id: "released-api", family: "released-api", object: "ZR", referenced_object: "T001", message: "uses non-released API T001", suggestion: "replace T001 with I_COMPANYCODE" },
    { rule_id: "abaplint:naming", family: "abaplint", object: "ZR", message: "name too short" },
  ];
  const plan = modernizationPlan(g, scoreDebt(g, [], reg), findings, reg, cloud);
  const t = plan.objects[0].transformations;
  assert.equal(t.length, 1, "raw abaplint lint is not a transformation; the released-api finding is");
  assert.equal(t[0].kind, "released-api");
  assert.equal(t[0].released_successor, "I_COMPANYCODE", "structured successor from the real oracle");
  assert.equal(plan.objects[0].transformation_count, 1);
});

test("analyzePackage emits a schema-valid modernization_plan (real end-to-end wiring)", () => {
  const doc = analyzePackage(
    [{ filename: "zcl_x.clas.abap", source: "CLASS zcl_x DEFINITION PUBLIC. PUBLIC SECTION. METHODS m. ENDCLASS.\nCLASS zcl_x IMPLEMENTATION. METHOD m. WRITE 'a'. ENDMETHOD. ENDCLASS." }],
    { package: "ZX", generated_at: "2026-01-01T00:00:00.000Z" },
  );
  assert.ok(doc.modernization_plan, "modernization_plan block present");
  assert.ok(Array.isArray(doc.modernization_plan.objects));
  assert.ok(doc.modernization_plan.objects.some((o) => o.object === "ZCL_X"));
  assert.equal(validateFindings(doc).valid, true, "emitted document is schema-valid");
});

test("modernizationPlan is deterministic and total on an empty graph", () => {
  const reg = loadRegistry([]);
  const empty = modernizationPlan({ nodes: [], edges: [] }, { scores: [] }, [], reg, cloud);
  assert.deepEqual(empty.objects, []);
  assert.equal(empty.summary.total_objects, 0);
  assert.equal(JSON.stringify(empty), JSON.stringify(modernizationPlan({ nodes: [], edges: [] }, { scores: [] }, [], reg, cloud)));
});
