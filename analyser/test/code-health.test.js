import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRegistry } from "../src/abaplint-loader.js";
import { codeHealth } from "../src/code-health.js";
import { analyzePackage } from "../src/orchestrator.js";
import { validateFindings } from "../src/validate-findings.js";

// code_health dimension (arch spec §3.C). Real abaplint parse, no mocks.
// clarity = mean of (100 - mean cyclomatic penalty over methods, anchored 10..20)
//   and (100 - 100*mean LCOM* over classes);
// stability = 100*(1 - mean Martin instability Ce/(Ca+Ce)) over compilation units;
// performance = % of compilation-unit objects free of performance-family findings;
// compound = mean(clarity, stability, performance);
// clean_core_grade = weakest node grade (§2 weakest-wins).

const FIXED = "2026-01-01T00:00:00.000Z";

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

test("clarity = mean(cyclomatic sub, lcom sub): both methods cc<=10 -> cyclo 100; LCOM*=0.5 -> lcom 50; clarity 75", () => {
  const reg = loadRegistry([{ filename: "zcl_calc.clas.abap", source: CALC }]);
  // one isolated class: no coupling edges -> stability defaults to 100;
  // no performance findings on the only object -> performance 100.
  const ch = codeHealth({ nodes: [{ id: "ZCL_CALC", kind: "class", object: "ZCL_CALC" }], edges: [] }, [], reg);
  assert.equal(ch.clarity, 75, "mean(100 cyclo, 50 lcom)");
  assert.equal(ch.stability, 100, "no coupling -> maximally stable");
  assert.equal(ch.performance, 100, "no performance findings");
  assert.equal(ch.compound, Math.round((75 + 100 + 100) / 3), "compound = mean of the three");
});

test("performance = share of compilation-unit objects free of performance-family findings", () => {
  const g = {
    nodes: [
      { id: "ZCL_A", kind: "class", object: "ZCL_A" },
      { id: "ZCL_B", kind: "class", object: "ZCL_B" },
      { id: "KNA1", kind: "table", object: "KNA1" }, // tables are not compilation units
    ],
    edges: [],
  };
  const findings = [{ rule_id: "r", severity: "priority-3", object: "ZCL_A", message: "m", family: "performance" }];
  const reg = loadRegistry([{ filename: "zr_x.prog.abap", source: "REPORT zr_x." }]);
  // 2 compilation units (ZCL_A, ZCL_B); ZCL_A has a perf finding -> 1/2 clean -> 50.
  assert.equal(codeHealth(g, findings, reg).performance, 50);
});

test("stability = 100*(1 - mean Martin instability); a pure consumer (I=1) drags it to 0", () => {
  // ZCL_APP depends on ZCL_LIB (Ce=1, Ca=0 -> I=1); ZCL_LIB is depended-on
  // (Ce=0, Ca=1 -> I=0). mean I = 0.5 -> stability 50.
  const g = {
    nodes: [
      { id: "ZCL_APP", kind: "class", object: "ZCL_APP" },
      { id: "ZCL_LIB", kind: "class", object: "ZCL_LIB" },
    ],
    edges: [{ source: "ZCL_APP", target: "ZCL_LIB", kind: "call-method" }],
  };
  const reg = loadRegistry([{ filename: "zr_x.prog.abap", source: "REPORT zr_x." }]);
  assert.equal(codeHealth(g, [], reg).stability, 50);
});

test("clean_core_grade = weakest node grade (D beats C beats B beats A); unknown only if nothing known", () => {
  const reg = loadRegistry([{ filename: "zr_x.prog.abap", source: "REPORT zr_x." }]);
  const g = (grades) => ({ nodes: grades.map((gr, i) => ({ id: `N${i}`, kind: "class", object: `N${i}`, clean_core_grade: gr })), edges: [] });
  assert.equal(codeHealth(g(["A", "C", "B"]), [], reg).clean_core_grade, "C");
  assert.equal(codeHealth(g(["D", "A"]), [], reg).clean_core_grade, "D");
  assert.equal(codeHealth(g(["unknown", "A"]), [], reg).clean_core_grade, "A", "a known grade wins over unknown");
  assert.equal(codeHealth(g(["unknown", "unknown"]), [], reg).clean_core_grade, "unknown");
});

test("all scores are integers in [0,100]", () => {
  const reg = loadRegistry([{ filename: "zcl_calc.clas.abap", source: CALC }]);
  const ch = codeHealth({ nodes: [{ id: "ZCL_CALC", kind: "class", object: "ZCL_CALC" }], edges: [] }, [], reg);
  for (const k of ["clarity", "stability", "performance", "compound"]) {
    assert.ok(Number.isInteger(ch[k]) && ch[k] >= 0 && ch[k] <= 100, `${k}=${ch[k]} must be an int in [0,100]`);
  }
});

test("clarity does not inflate when ABAP Unit tests are added (test code excluded from both sub-axes)", () => {
  // Adversarial review F-1 (2026-07-09): a complex production method must not have
  // its cyclomatic penalty diluted by trivial FOR TESTING methods. Same production
  // code + a testclasses include -> identical clarity.
  const branches = Array.from({ length: 14 }, (_, i) => `    IF mv = ${i}. mv = ${i + 1}. ENDIF.`).join("\n");
  const heavy = [
    "CLASS zcl_heavy DEFINITION PUBLIC.",
    "  PUBLIC SECTION. METHODS big.",
    "  PRIVATE SECTION. DATA mv TYPE i.",
    "ENDCLASS.",
    "CLASS zcl_heavy IMPLEMENTATION.",
    "  METHOD big.",
    branches,
    "  ENDMETHOD.",
    "ENDCLASS.",
  ].join("\n");
  const testclasses = [
    "CLASS lcl_test DEFINITION FOR TESTING RISK LEVEL HARMLESS DURATION SHORT.",
    "  PRIVATE SECTION.",
    Array.from({ length: 9 }, (_, i) => `    METHODS t${i} FOR TESTING.`).join("\n"),
    "ENDCLASS.",
    "CLASS lcl_test IMPLEMENTATION.",
    Array.from({ length: 9 }, (_, i) => `  METHOD t${i}. cl_abap_unit_assert=>assert_true( abap_true ). ENDMETHOD.`).join("\n"),
    "ENDCLASS.",
  ].join("\n");
  const g = { nodes: [{ id: "ZCL_HEAVY", kind: "class", object: "ZCL_HEAVY" }], edges: [] };
  const noTests = codeHealth(g, [], loadRegistry([{ filename: "zcl_heavy.clas.abap", source: heavy }]));
  const withTests = codeHealth(
    g,
    [],
    loadRegistry([
      { filename: "zcl_heavy.clas.abap", source: heavy },
      { filename: "zcl_heavy.clas.testclasses.abap", source: testclasses },
    ]),
  );
  assert.ok(noTests.clarity < 100, "the heavy production method genuinely lowers clarity");
  assert.equal(withTests.clarity, noTests.clarity, "adding tests must not change clarity");
});

test("analyzePackage emits a schema-valid code_health block (real end-to-end wiring)", () => {
  const doc = analyzePackage([{ filename: "zcl_calc.clas.abap", source: CALC }], { package: "ZX", generated_at: FIXED });
  assert.ok(doc.code_health, "code_health is present on the emitted document");
  assert.ok(["A", "B", "C", "D", "unknown"].includes(doc.code_health.clean_core_grade));
  for (const k of ["clarity", "stability", "performance", "compound"]) {
    assert.ok(Number.isInteger(doc.code_health[k]), `${k} is an integer`);
  }
  assert.equal(validateFindings(doc).valid, true, "the emitted document is schema-valid");
});
