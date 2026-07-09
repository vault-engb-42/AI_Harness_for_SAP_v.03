import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRegistry } from "../src/abaplint-loader.js";
import { computeMetrics } from "../src/metrics.js";
import { analyzePackage } from "../src/orchestrator.js";
import { validateFindings } from "../src/validate-findings.js";

// Package-level codebase metrics (Summary tab): LOC + counts + size class + a
// Maintainability Index (token-based Halstead volume + cyclomatic + LOC + comment
// ratio). Real abaplint parse, no mocks. The MI is analyser-defined (like
// code_health) — a bounded 0-100 UX score, not a numeric oracle.

const REPORT = "REPORT zr.\nSTART-OF-SELECTION.\n  WRITE 'a'.";

test("computeMetrics: LOC, object/kind counts, customer-vs-SAP split, size class", () => {
  const reg = loadRegistry([{ filename: "zr.prog.abap", source: REPORT }]);
  const m = computeMetrics([], reg);
  assert.equal(m.object_count, 1);
  assert.equal(m.by_kind.report, 1);
  assert.ok(m.total_loc >= 3, `total_loc counts raw rows: ${m.total_loc}`);
  assert.equal(m.customer_loc, m.total_loc, "Z* object is customer LOC");
  assert.equal(m.sap_loc, 0);
  assert.equal(m.size_class, "S", "<10k LOC");
  assert.equal(m.max_nesting, 0);
  assert.equal(m.max_cyclomatic, 0, "no class methods in a bare report");
});

test("computeMetrics: Maintainability Index is a bounded integer 0-100", () => {
  const reg = loadRegistry([{ filename: "zr.prog.abap", source: REPORT }]);
  const m = computeMetrics([], reg);
  assert.ok(Number.isInteger(m.maintainability_index), "MI is an integer");
  assert.ok(m.maintainability_index >= 0 && m.maintainability_index <= 100, `MI in [0,100]: ${m.maintainability_index}`);
  assert.ok(m.comment_ratio >= 0 && m.comment_ratio <= 1);
});

test("computeMetrics: nesting + cyclomatic reflect real structure; duplication from clone findings", () => {
  const cls = [
    "CLASS zcl_x DEFINITION PUBLIC. PUBLIC SECTION. METHODS m. PRIVATE SECTION. DATA v TYPE i. ENDCLASS.",
    "CLASS zcl_x IMPLEMENTATION. METHOD m.",
    "  IF v = 1. WHILE v < 2. v = 2. ENDWHILE. ENDIF.",
    "ENDMETHOD. ENDCLASS.",
  ].join("\n");
  const reg = loadRegistry([{ filename: "zcl_x.clas.abap", source: cls }]);
  const findings = [{ rule_id: "talos-duplicate-block", object: "ZCL_X", severity: "priority-3", message: "dup" }];
  const m = computeMetrics(findings, reg);
  assert.equal(m.by_kind.class, 1);
  assert.equal(m.max_nesting, 2, "IF > WHILE");
  assert.ok(m.max_cyclomatic >= 3, `method has IF + WHILE branches: ${m.max_cyclomatic}`);
  assert.equal(m.duplication_findings, 1);
});

test("computeMetrics is deterministic and total on an empty registry", () => {
  const reg = loadRegistry([]);
  const m = computeMetrics([], reg);
  assert.equal(m.object_count, 0);
  assert.equal(m.total_loc, 0);
  assert.equal(m.size_class, "S");
  assert.equal(JSON.stringify(m), JSON.stringify(computeMetrics([], reg)));
});

test("analyzePackage emits a schema-valid metrics block (end-to-end wiring)", () => {
  const doc = analyzePackage([{ filename: "zr.prog.abap", source: REPORT }], { package: "ZX", generated_at: "2026-01-01T00:00:00.000Z" });
  assert.ok(doc.metrics, "metrics block present");
  assert.equal(doc.metrics.object_count, 1);
  assert.equal(validateFindings(doc).valid, true, "emitted document is schema-valid");
});
