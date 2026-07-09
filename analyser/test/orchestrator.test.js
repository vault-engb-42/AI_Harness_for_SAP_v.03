import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzePackage, writeReport } from "../src/orchestrator.js";
import { validateFindings } from "../src/validate-findings.js";

// pid-suffixed so parallel runs never collide; cleaned in teardown.
const TMP = join(tmpdir(), `analyser-orch-test-${process.pid}`);
after(() => rmSync(TMP, { recursive: true, force: true }));

const FILES = [
  {
    filename: "zcl_svc.clas.abap",
    source: `CLASS zcl_svc DEFINITION PUBLIC INHERITING FROM cl_a4c_bc_factory.
  PUBLIC SECTION.
    METHODS run.
ENDCLASS.
CLASS zcl_svc IMPLEMENTATION.
  METHOD run.
    AUTHORITY-CHECK OBJECT 'S_DEVELOP' ID 'ACTVT' FIELD '03'.
    SELECT SINGLE * FROM bapiret1 INTO @DATA(ls).
  ENDMETHOD.
ENDCLASS.`,
  },
];

const OPTS = { source_system: "DEV100", package: "ZTEST", generated_at: "2026-07-02T00:00:00Z" };

test("analyzePackage emits a schema-valid findings document", () => {
  const doc = analyzePackage(FILES, OPTS);
  const { valid, errors } = validateFindings(doc);
  assert.ok(valid, `schema errors: ${errors.join("; ")}`);
  assert.equal(doc.source_system, "DEV100");
  assert.equal(doc.package, "ZTEST");
  assert.equal(doc.generated_at, "2026-07-02T00:00:00Z");
});

test("findings include the released-api and P4 invariant hits", () => {
  const doc = analyzePackage(FILES, OPTS);
  assert.ok(doc.findings.some((f) => f.rule_id === "released-api" && /BAPIRET1/.test(f.message)), "released-api for table");
  assert.ok(doc.findings.some((f) => f.rule_id === "invariant-authority-check-subrc"), "P4 invariant");
  assert.ok(doc.findings.some((f) => f.family === "abaplint"), "abaplint rules ran too");
});

test("s4_readiness reflects the deprecated dependencies", () => {
  const doc = analyzePackage(FILES, OPTS);
  assert.equal(doc.s4_readiness.deprecated_hits, 2, "inherited class + table both deprecated");
  assert.equal(doc.s4_readiness.released_hits, 0);
  assert.equal(doc.s4_readiness.s4_readiness_pct, 0);
});

test("blast_radius lists the at-risk SAP objects", () => {
  const doc = analyzePackage(FILES, OPTS);
  const objs = doc.blast_radius.map((b) => b.object);
  assert.ok(objs.includes("BAPIRET1"));
  assert.ok(objs.includes("CL_A4C_BC_FACTORY"));
});

test("nodes are enriched with modernization metadata", () => {
  const doc = analyzePackage(FILES, OPTS);
  const parent = doc.graph.nodes.find((n) => n.id === "CL_A4C_BC_FACTORY");
  assert.equal(parent.effort_tier, "re-platform");
  assert.equal(parent.modernization_target, "CL_BCFG_CD_REUSE_API_FACTORY");
  // §15.5: clean_core_grade is the oracle Level (C=deprecated); posture is dual-
  // emitted via the crosswalk C->brownfield-mixed (was "classic" pre-§15.5).
  assert.equal(parent.clean_core_grade, "C");
  assert.equal(parent.clean_core_posture, "brownfield-mixed");
  const customer = doc.graph.nodes.find((n) => n.id === "ZCL_SVC");
  // customer node grade = weakest dependency Level (§2 cap): its deps are C -> C.
  assert.equal(customer.clean_core_grade, "C");
  assert.equal(customer.clean_core_posture, "brownfield-mixed");
});

test("namespace_summary counts customer vs SAP", () => {
  const doc = analyzePackage(FILES, OPTS);
  assert.equal(doc.namespace_summary.Z, 1); // ZCL_SVC
  assert.ok(doc.namespace_summary.sap >= 2); // CL_A4C_BC_FACTORY + BAPIRET1
});

test("namespace_summary counts OBJECTS, not method/form member nodes", () => {
  // Cross-object method calls materialize method nodes (ZCL_A.RUN, ZCL_B.DO_WORK,
  // ...) which carry their owner's namespace. Those are members, not distinct
  // repository objects, so they must not inflate the customer/SAP breakdown.
  const files = [
    { filename: "zcl_a.clas.abap", source: `CLASS zcl_a DEFINITION PUBLIC FINAL.\n  PUBLIC SECTION.\n    METHODS run.\n    DATA mo_b TYPE REF TO zcl_b.\nENDCLASS.\nCLASS zcl_a IMPLEMENTATION.\n  METHOD run.\n    mo_b->do_work( ).\n    mo_b->do_more( ).\n  ENDMETHOD.\nENDCLASS.` },
    { filename: "zcl_b.clas.abap", source: `CLASS zcl_b DEFINITION PUBLIC FINAL.\n  PUBLIC SECTION.\n    METHODS do_work.\n    METHODS do_more.\nENDCLASS.\nCLASS zcl_b IMPLEMENTATION.\n  METHOD do_work.\n  ENDMETHOD.\n  METHOD do_more.\n  ENDMETHOD.\nENDCLASS.` },
  ];
  const doc = analyzePackage(files, OPTS);
  assert.equal(doc.namespace_summary.Z, 2, "two customer OBJECTS (ZCL_A, ZCL_B), not their 3 method nodes");
  assert.equal(doc.namespace_summary.customer_total, 2);
});

test("writeReport refuses a schema-invalid document (fail-closed)", () => {
  const bad = { package: "ZP" }; // missing required fields
  assert.throws(() => writeReport(bad, join(TMP, "never.json")), /schema-invalid/);
});

test("writeReport round-trips valid JSON", () => {
  const doc = analyzePackage(FILES, OPTS);
  const out = join(TMP, "findings.json");
  writeReport(doc, out);
  const reparsed = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(reparsed.package, "ZTEST");
  assert.ok(validateFindings(reparsed).valid);
});
