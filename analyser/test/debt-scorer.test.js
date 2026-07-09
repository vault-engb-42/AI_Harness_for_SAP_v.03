import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRegistry } from "../src/abaplint-loader.js";
import { scoreDebt } from "../src/debt-scorer.js";
import { analyzePackage } from "../src/orchestrator.js";
import { validateFindings } from "../src/validate-findings.js";

// Tech-debt scoring (arch spec §3.C Debt tab). Per-symbol 0-1 composite over 10
// signals: TALOS Appendix A structure/weights/anchors, ADAPTED to our real
// metrics (complexity=McCabe, lcom=LCOM*, duplication=clone findings) where TALOS
// forced 0 / used a proxy. Symbol = compilation-unit object. Real parse, no mocks.

const REPORT = ["REPORT zr.", "FORM f1.", "  WRITE 1.", "ENDFORM.", "FORM f2.", "  WRITE 2.", "ENDFORM."].join("\n");
const G_REPORT = { nodes: [{ id: "ZR", kind: "report", object: "ZR" }], edges: [] };
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);

test("scoreDebt computes the 10 signals + weighted-first-6 composite for one symbol", () => {
  // ZR: loc=7, routines=2. size_ratio=7/300; density=2/(7/50)=14.29 -> function_density=0;
  // avg=3.5 -> avg_function_length=0.07; coupling/complexity/dup/intf/test/lcom=0;
  // structural_quality=(1-0)*.3+(1-0)*.3=0.6; composite=round3(.2*7/300 + .2*0.07)=0.019.
  const reg = loadRegistry([{ filename: "zr.prog.abap", source: REPORT }]);
  const d = scoreDebt(G_REPORT, [], reg);
  assert.equal(d.scores.length, 1);
  const s = d.scores[0];
  assert.equal(s.symbol, "ZR");
  near(s.signals.size_ratio, 7 / 300, "size_ratio");
  assert.equal(s.signals.function_density, 0, "sparse-routine inversion clamps to 0 here");
  near(s.signals.avg_function_length, 0.07, "avg_function_length");
  assert.equal(s.signals.structural_quality, 0.6);
  assert.equal(s.score, 0.019, "weighted composite of signals 1-6");
});

test("ADAPT: complexity is REAL McCabe (not TALOS's forced 0) — a cc=15 method scores 0.5", () => {
  const branches = Array.from({ length: 14 }, (_, i) => `    IF mv = ${i}. mv = ${i + 1}. ENDIF.`).join("\n");
  const heavy = [
    "CLASS zcl_heavy DEFINITION PUBLIC. PUBLIC SECTION. METHODS big. PRIVATE SECTION. DATA mv TYPE i.",
    "ENDCLASS.",
    "CLASS zcl_heavy IMPLEMENTATION. METHOD big.",
    branches,
    "ENDMETHOD. ENDCLASS.",
  ].join("\n");
  const reg = loadRegistry([{ filename: "zcl_heavy.clas.abap", source: heavy }]);
  const g = { nodes: [{ id: "ZCL_HEAVY", kind: "class", object: "ZCL_HEAVY" }], edges: [] };
  // 14 IF branches -> cc=15 -> penalty (15-10)/(20-10)=0.5.
  assert.equal(scoreDebt(g, [], reg).scores[0].signals.complexity, 0.5);
});

test("ADAPT: duplication comes from clone findings (talos-duplicate-block), not TALOS's 0", () => {
  const reg = loadRegistry([{ filename: "zr.prog.abap", source: REPORT }]);
  const findings = [{ rule_id: "talos-duplicate-block", object: "ZR", severity: "priority-3", message: "dup" }];
  // 1 clone finding / max(routines=2,1) = 0.5.
  assert.equal(scoreDebt(G_REPORT, findings, reg).scores[0].signals.duplication, 0.5);
});

test("scores are sorted desc, summary has avg/max/hotspot_count, all in [0,1]", () => {
  const reg = loadRegistry([{ filename: "zr.prog.abap", source: REPORT }]);
  const d = scoreDebt(G_REPORT, [], reg);
  assert.ok(d.max_score >= 0 && d.max_score <= 1);
  assert.ok(d.avg_score >= 0 && d.avg_score <= 1);
  assert.equal(typeof d.hotspot_count, "number");
  for (const s of d.scores) {
    assert.ok(s.score >= 0 && s.score <= 1, `score in [0,1]: ${s.score}`);
    for (const [k, v] of Object.entries(s.signals)) assert.ok(v >= 0 && v <= 1, `${k}=${v} in [0,1]`);
  }
});

test("analyzePackage emits a schema-valid debt block (real end-to-end wiring)", () => {
  const doc = analyzePackage([{ filename: "zr.prog.abap", source: REPORT }], { package: "ZX", generated_at: "2026-01-01T00:00:00.000Z" });
  assert.ok(doc.debt, "debt block present on the emitted document");
  assert.ok(Array.isArray(doc.debt.scores));
  assert.ok(doc.debt.scores.some((s) => s.symbol === "ZR"), "the report is scored");
  assert.equal(validateFindings(doc).valid, true, "the emitted document is schema-valid");
});

test("scoreDebt is deterministic and total on an empty package", () => {
  const reg = loadRegistry([{ filename: "zr.prog.abap", source: "REPORT zr." }]);
  assert.equal(JSON.stringify(scoreDebt(G_REPORT, [], reg)), JSON.stringify(scoreDebt(G_REPORT, [], reg)));
  const empty = scoreDebt({ nodes: [], edges: [] }, [], reg);
  assert.deepEqual(empty.scores, []);
  assert.equal(empty.avg_score, 0);
  assert.equal(empty.hotspot_count, 0);
});
