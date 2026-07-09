import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRegistry } from "../src/abaplint-loader.js";
import { methodCyclomatic, classCohesion } from "../src/ast-metrics.js";

// Faithful AST metrics (arch spec §3.C code_health.clarity). Real abaplint parse,
// no mocks. Cyclomatic reuses abaplint's own CyclomaticComplexityStats branch set
// (Assert/Check/If/ElseIf/While/Case/SelectLoop/Catch/Cleanup/EndAt/Loop — NOTE:
// DO/DATA are NOT branches) and adds the spec's +1. LCOM is Henderson-Sellers.

// Ground-truthed against @abaplint/core 2.119.53: simple has 0 branches (cc=1);
// branchy has IF + ELSEIF = 2 branches (cc=3) — the DO loop does NOT count.
// LCOM*: m=2, a=2, mu(MV_TOTAL)=2 (both methods), mu(MV_COUNT)=1 (branchy) ->
// (2 - 3/2)/(2-1) = 0.5.
const CALC = [
  "CLASS zcl_calc DEFINITION PUBLIC.",
  "  PUBLIC SECTION.",
  "    METHODS simple.",
  "    METHODS branchy IMPORTING iv TYPE i RETURNING VALUE(rv) TYPE i.",
  "  PRIVATE SECTION.",
  "    DATA mv_total TYPE i.",
  "    DATA mv_count TYPE i.",
  "ENDCLASS.",
  "CLASS zcl_calc IMPLEMENTATION.",
  "  METHOD simple.",
  "    mv_total = 0.",
  "  ENDMETHOD.",
  "  METHOD branchy.",
  "    IF iv > 0.",
  "      mv_total = mv_total + iv.",
  "    ELSEIF iv < 0.",
  "      mv_total = mv_total - iv.",
  "    ENDIF.",
  "    DO 3 TIMES.",
  "      mv_count = mv_count + 1.",
  "    ENDDO.",
  "    rv = mv_total.",
  "  ENDMETHOD.",
  "ENDCLASS.",
].join("\n");

test("methodCyclomatic returns McCabe b+1 per method, using abaplint's branch set (DO excluded)", () => {
  const reg = loadRegistry([{ filename: "zcl_calc.clas.abap", source: CALC }]);
  const cc = methodCyclomatic(reg);
  assert.deepEqual(cc, [
    { object: "ZCL_CALC", method: "BRANCHY", cyclomatic: 3 },
    { object: "ZCL_CALC", method: "SIMPLE", cyclomatic: 1 },
  ]);
});

test("classCohesion computes Henderson-Sellers LCOM* (0.5 for the two-field split class)", () => {
  const reg = loadRegistry([{ filename: "zcl_calc.clas.abap", source: CALC }]);
  const coh = classCohesion(reg);
  assert.deepEqual(coh, [{ object: "ZCL_CALC", lcom: 0.5, methods: 2, attributes: 2 }]);
});

test("classCohesion returns LCOM* 0 for a fully cohesive class (one field, all methods use it)", () => {
  const src = [
    "CLASS zcl_coh DEFINITION PUBLIC.",
    "  PUBLIC SECTION. METHODS a. METHODS b.",
    "  PRIVATE SECTION. DATA mv TYPE i.",
    "ENDCLASS.",
    "CLASS zcl_coh IMPLEMENTATION.",
    "  METHOD a. mv = 1. ENDMETHOD.",
    "  METHOD b. mv = mv + 1. ENDMETHOD.",
    "ENDCLASS.",
  ].join("\n");
  const reg = loadRegistry([{ filename: "zcl_coh.clas.abap", source: src }]);
  assert.deepEqual(classCohesion(reg), [{ object: "ZCL_COH", lcom: 0, methods: 2, attributes: 1 }]);
});

test("classCohesion excludes test classes (FOR TESTING) from the cohesion signal", () => {
  // abapGit convention: test classes live in the .clas.testclasses.abap include,
  // not the main .clas.abap (which holds exactly one global class).
  const main = [
    "CLASS zcl_prod DEFINITION PUBLIC.",
    "  PUBLIC SECTION. METHODS a.",
    "  PRIVATE SECTION. DATA mv TYPE i.",
    "ENDCLASS.",
    "CLASS zcl_prod IMPLEMENTATION.",
    "  METHOD a. mv = 1. ENDMETHOD.",
    "ENDCLASS.",
  ].join("\n");
  const testclasses = [
    "CLASS lcl_test DEFINITION FOR TESTING RISK LEVEL HARMLESS DURATION SHORT.",
    "  PRIVATE SECTION. DATA gv TYPE i. METHODS t1 FOR TESTING. METHODS t2 FOR TESTING.",
    "ENDCLASS.",
    "CLASS lcl_test IMPLEMENTATION.",
    "  METHOD t1. gv = 1. ENDMETHOD.",
    "  METHOD t2. gv = 2. ENDMETHOD.",
    "ENDCLASS.",
  ].join("\n");
  const reg = loadRegistry([
    { filename: "zcl_prod.clas.abap", source: main },
    { filename: "zcl_prod.clas.testclasses.abap", source: testclasses },
  ]);
  const coh = classCohesion(reg);
  // Only the production class is reported; the FOR TESTING class is excluded.
  assert.deepEqual(coh.map((c) => c.object), ["ZCL_PROD"]);
});

test("methodCyclomatic excludes FOR TESTING methods (same production population as classCohesion)", () => {
  // Regression guard: without this, adding trivial ABAP Unit tests dilutes the
  // clarity cyclomatic penalty and inflates the health score (adversarial review
  // F-1, 2026-07-09). Both clarity sub-axes must measure production code only.
  const main = [
    "CLASS zcl_prod DEFINITION PUBLIC.",
    "  PUBLIC SECTION. METHODS big.",
    "  PRIVATE SECTION. DATA mv TYPE i.",
    "ENDCLASS.",
    "CLASS zcl_prod IMPLEMENTATION.",
    "  METHOD big. IF mv > 0. mv = 1. ENDIF. ENDMETHOD.",
    "ENDCLASS.",
  ].join("\n");
  const testclasses = [
    "CLASS lcl_test DEFINITION FOR TESTING RISK LEVEL HARMLESS DURATION SHORT.",
    "  PRIVATE SECTION. METHODS t1 FOR TESTING.",
    "ENDCLASS.",
    "CLASS lcl_test IMPLEMENTATION.",
    "  METHOD t1. cl_abap_unit_assert=>assert_equals( act = 1 exp = 1 ). ENDMETHOD.",
    "ENDCLASS.",
  ].join("\n");
  const reg = loadRegistry([
    { filename: "zcl_prod.clas.abap", source: main },
    { filename: "zcl_prod.clas.testclasses.abap", source: testclasses },
  ]);
  assert.deepEqual(methodCyclomatic(reg).map((m) => m.method), ["BIG"], "T1 (FOR TESTING) is excluded");
});

test("metrics are total on a package with no methods/classes (empty arrays, no throw)", () => {
  const reg = loadRegistry([{ filename: "zr_x.prog.abap", source: "REPORT zr_x.\nWRITE 'hi'." }]);
  assert.deepEqual(methodCyclomatic(reg), []);
  assert.deepEqual(classCohesion(reg), []);
});
