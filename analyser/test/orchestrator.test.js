import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzePackage, writeReport } from "../src/orchestrator.js";
import { validateFindings } from "../src/validate-findings.js";

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
  assert.equal(parent.clean_core_posture, "classic");
  const customer = doc.graph.nodes.find((n) => n.id === "ZCL_SVC");
  assert.equal(customer.clean_core_posture, "brownfield-mixed");
});

test("namespace_summary counts customer vs SAP", () => {
  const doc = analyzePackage(FILES, OPTS);
  assert.equal(doc.namespace_summary.Z, 1); // ZCL_SVC
  assert.ok(doc.namespace_summary.sap >= 2); // CL_A4C_BC_FACTORY + BAPIRET1
});

test("writeReport round-trips valid JSON", () => {
  const doc = analyzePackage(FILES, OPTS);
  const out = join(tmpdir(), "analyser-orch-test", "findings.json");
  writeReport(doc, out);
  const reparsed = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(reparsed.package, "ZTEST");
  assert.ok(validateFindings(reparsed).valid);
  rmSync(join(tmpdir(), "analyser-orch-test"), { recursive: true, force: true });
});
