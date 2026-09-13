import { test } from "node:test";
import assert from "node:assert/strict";
import { riskEvidence } from "../src/node/risk-evidence.js";
import { levelDisposition } from "../src/exception/risk-gate.js";

// The evidence RISK_LEVEL_REVIEW scores (§3.4 #2, L2).
//
// `levelDisposition` was built, unit-tested and callerless for the whole arc. MEASURED 2026-09-13: five of
// its eight inputs — all four touches_* flags and blast_total — had NO producer anywhere in src. It is
// FAIL-CLOSED (missing evidence is FLAGGED, never assumed clear), so wiring it against those absences would
// have flagged EVERY wave and made the human the volume gate §3.4 forbids.
//
// Operator-ratified 2026-09-13: derive strictly from the DIFF. Every flag answers "did this CHANGE?", never
// "does this EXIST?" — a node that read a table before and after touches no new data source.

const bundle = (o = {}) => ({ statement_kinds: {}, money_operands: [], ...o });
const f = (...names) => names.map((filename) => ({ filename }));

test("an unchanged node touches NOTHING — the gate must not fire on a node that did not move", () => {
  const same = bundle({ statement_kinds: { select: 2 }, money_operands: [{ field: "NETWR", type: "CURR" }] });
  const ev = riskEvidence({
    before: same, after: same,
    beforeFiles: f("z.tabl.xml", "z.clas.abap"), afterFiles: f("z.tabl.xml", "z.clas.abap"),
    invariants: { auth_delta: false, intact: true },
    analysis: { blast_radius: [] },
  });
  assert.deepEqual(ev, {
    touches_ddic: false, touches_invariant: false, touches_data_source: false, touches_money: false, blast_total: 0,
  });
  assert.equal(levelDisposition([{ sig: "A", atc_p1: 0, atc_p2: 0, parity: "equivalent", ...ev }], { blastThreshold: 10 }).disposition, "AUTO",
    "a clean unchanged node must auto-advance, or the gate is the storm it exists to prevent");
});

test("a DDIC artifact appearing is a dictionary change", () => {
  const ev = riskEvidence({
    before: bundle(), after: bundle(),
    beforeFiles: f("z.clas.abap"), afterFiles: f("z.clas.abap", "ztab.tabl.xml"),
    invariants: { auth_delta: false, intact: true },
  });
  assert.equal(ev.touches_ddic, true);
});

test("a RENAMED DDIC artifact is a change too — names are the identity", () => {
  const ev = riskEvidence({
    before: bundle(), after: bundle(),
    beforeFiles: f("zold.tabl.xml"), afterFiles: f("znew.tabl.xml"),
    invariants: {},
  });
  assert.equal(ev.touches_ddic, true, "same count, different object — a transport-relevant change");
});

test("a moved authorization footprint or a broken invariant is a touch, exactly", () => {
  const base = { before: bundle(), after: bundle(), beforeFiles: [], afterFiles: [] };
  assert.equal(riskEvidence({ ...base, invariants: { auth_delta: true, intact: true } }).touches_invariant, true);
  assert.equal(riskEvidence({ ...base, invariants: { auth_delta: false, intact: false } }).touches_invariant, true);
  assert.equal(riskEvidence({ ...base, invariants: { auth_delta: false, intact: true } }).touches_invariant, false);
});

test("data-source touch counts STATEMENTS, not mere presence — one SELECT to four is a change", () => {
  const ev = riskEvidence({
    before: bundle({ statement_kinds: { select: 1, write: 3 } }),
    after: bundle({ statement_kinds: { select: 4, write: 3 } }),
    invariants: {},
  });
  assert.equal(ev.touches_data_source, true, "it reads differently even though it selected both before and after");
});

test("a non-data statement changing is NOT a data-source touch", () => {
  // The discipline that keeps this from flagging everything: WRITE is not data access, so refactoring
  // output must not pause a wave for a data-risk review.
  const ev = riskEvidence({
    before: bundle({ statement_kinds: { select: 1, write: 3 } }),
    after: bundle({ statement_kinds: { select: 1, write: 9 } }),
    invariants: {},
  });
  assert.equal(ev.touches_data_source, false);
});

test("a money operand appearing, or changing TYPE, is a money touch", () => {
  const before = bundle({ money_operands: [{ field: "NETWR", type: "CURR" }] });
  assert.equal(riskEvidence({ before, after: bundle({ money_operands: [] }), invariants: {} }).touches_money, true, "removed");
  assert.equal(
    riskEvidence({ before, after: bundle({ money_operands: [{ field: "NETWR", type: "DEC" }] }), invariants: {} }).touches_money,
    true, "same field, different type — a rounding-behaviour change is exactly the money risk",
  );
  assert.equal(riskEvidence({ before, after: before, invariants: {} }).touches_money, false);
});

test("blast_total is NULL when nobody looked — absence must FLAG, never read as zero", () => {
  // The fail direction that matters, and the inversion the F5 --findings guard exists to prevent.
  // levelDisposition clears a finite value within threshold, so reporting 0 for "no analysis was supplied"
  // would launder missing evidence into a clean bill of health.
  const noAnalysis = riskEvidence({ before: bundle(), after: bundle(), invariants: {} });
  assert.equal(noAnalysis.blast_total, null);
  const scored = levelDisposition([{ sig: "A", atc_p1: 0, atc_p2: 0, parity: "equivalent", ...noAnalysis }], { blastThreshold: 10 });
  assert.equal(scored.disposition, "REVIEW", "a node whose blast radius nobody measured must reach a human");
  assert.ok(scored.flagged[0].reasons.some((r) => r.startsWith("blast:")), JSON.stringify(scored.flagged[0].reasons));

  const measured = riskEvidence({ before: bundle(), after: bundle(), invariants: {}, analysis: { blast_radius: [{ object: "X" }, { object: "Y" }] } });
  assert.equal(measured.blast_total, 2, "and a real measurement is a real number");
});
