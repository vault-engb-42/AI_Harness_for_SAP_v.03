import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRegistry } from "../src/abaplint-loader.js";
import { modernizationMetrics } from "../src/modernization-metrics.js";

// §3.D per-object AST inputs for the modernization plan: statement count, dynamic
// CALL FUNCTION ratio, max control-flow nesting depth. Pure functions of a real
// abaplint parse (no mocks). Probe-grounded: opening control structures add a
// nesting level; branch continuations (ELSE/WHEN/CATCH) do not; a CALL FUNCTION
// with a string-literal name is static, a bare identifier is dynamic.

const one = (reg) => modernizationMetrics(reg)[0];

test("dyn_call_ratio: one literal + one variable CALL FUNCTION = 0.5", () => {
  const src = [
    "REPORT zr.",
    "DATA lv_fm TYPE funcname.",
    "START-OF-SELECTION.",
    "  CALL FUNCTION 'STATIC_FM'.",
    "  CALL FUNCTION lv_fm.",
  ].join("\n");
  const reg = loadRegistry([{ filename: "zr.prog.abap", source: src }]);
  assert.equal(one(reg).dyn_call_ratio, 0.5);
});

test("dyn_call_ratio is 0 when there are no CALL FUNCTION statements", () => {
  const reg = loadRegistry([{ filename: "zr.prog.abap", source: "REPORT zr.\nWRITE 'x'." }]);
  assert.equal(one(reg).dyn_call_ratio, 0);
});

test("maxNesting counts opening structures only (IF>LOOP>IF>WHILE = 4)", () => {
  const src = [
    "REPORT zr.",
    "START-OF-SELECTION.",
    "  IF 1 = 1.",
    "    LOOP AT itab INTO wa.",
    "      IF wa-x = 2.",
    "        WHILE sy-index < 3.",
    "          WRITE 'deep'.",
    "        ENDWHILE.",
    "      ENDIF.",
    "    ENDLOOP.",
    "  ENDIF.",
  ].join("\n");
  const reg = loadRegistry([{ filename: "zr.prog.abap", source: src }]);
  assert.equal(one(reg).nesting, 4);
});

test("maxNesting: branch continuations (ELSE) do not add a level", () => {
  const src = ["REPORT zr.", "START-OF-SELECTION.", "  IF x = 1.", "    WRITE 'a'.", "  ELSE.", "    WRITE 'b'.", "  ENDIF."].join("\n");
  const reg = loadRegistry([{ filename: "zr.prog.abap", source: src }]);
  assert.equal(one(reg).nesting, 1);
});

test("stmts is a positive integer, deterministic, and monotonic in code size", () => {
  const small = loadRegistry([{ filename: "zr.prog.abap", source: "REPORT zr." }]);
  const big = loadRegistry([{ filename: "zr.prog.abap", source: "REPORT zr.\nSTART-OF-SELECTION.\n  WRITE 'a'.\n  WRITE 'b'." }]);
  const s = one(small).stmts;
  assert.ok(Number.isInteger(s) && s >= 1, `stmts positive int: ${s}`);
  assert.ok(one(big).stmts > s, "more code => more statements");
  assert.equal(JSON.stringify(modernizationMetrics(big)), JSON.stringify(modernizationMetrics(big)), "deterministic");
});

test("production only: a FOR TESTING include does not inflate stmts/nesting", () => {
  const prod = [
    "CLASS zcl_x DEFINITION PUBLIC. PUBLIC SECTION. METHODS m. ENDCLASS.",
    "CLASS zcl_x IMPLEMENTATION. METHOD m. WRITE 'p'. ENDMETHOD. ENDCLASS.",
  ].join("\n");
  const testInc = [
    "CLASS ltcl_x DEFINITION FOR TESTING RISK LEVEL HARMLESS DURATION SHORT.",
    "  PRIVATE SECTION. METHODS t FOR TESTING.",
    "ENDCLASS.",
    "CLASS ltcl_x IMPLEMENTATION. METHOD t.",
    "  IF 1 = 1. LOOP AT itab INTO wa. IF wa = 1. WHILE x < 2. WRITE 'x'. ENDWHILE. ENDIF. ENDLOOP. ENDIF.",
    "ENDMETHOD. ENDCLASS.",
  ].join("\n");
  const reg = loadRegistry([
    { filename: "zcl_x.clas.abap", source: prod },
    { filename: "zcl_x.clas.testclasses.abap", source: testInc },
  ]);
  const m = one(reg);
  // The deep nesting lives only in the test include; production nesting is 0.
  assert.equal(m.nesting, 0, "test-include nesting excluded");
});

test("modernizationMetrics is total on an empty registry", () => {
  const reg = loadRegistry([]);
  assert.deepEqual(modernizationMetrics(reg), []);
});
