import { test } from "node:test";
import assert from "node:assert/strict";
import { driveOfflineVerdict, driveDecision } from "../src/sched/drive.js";
import { initRun, dispatch, applyProgress } from "../src/sched/loop.js";

// gap-2b B6.5 remediation — F8. THE OWED ATTESTATION EVAPORATED.
//
// `driveOfflineVerdict` correctly returned `await_human` with the escalation, but nothing recorded
// that the gate was still open: `PROVISIONAL_GATED` is unconditionally in RESTED, `driveDecision`
// reads only `park_register` and `NEEDS_MANUAL_SEAM`, and `verdict_provisional` had no reader at
// all. So the VERY NEXT drive step reported `provisional_complete` — the run declared itself done
// with an unattested authorization-footprint change sitting in it. That is a false pass at the RUN
// level, which is worse than a false pass at the node level: the proof bundle says complete.
//
// A node that rests at PROVISIONAL_GATED with a FALSE verdict is not rested. It is waiting.

const PLAN = { plan_hash: "h1", nodes: [{ id: "N1", object: "ZCL_X", wave: 0, dependencies: [] }] };
const pass = { provisional: true, reasons: [] };
const block = (...reasons) => ({ provisional: false, reasons });

function atSyntaxOk() {
  let s = initRun(PLAN);
  s = dispatch(PLAN, s, ["N1"]);
  s = applyProgress(PLAN, s, "N1", "GENERATED");
  return applyProgress(PLAN, s, "N1", "SYNTAX_OK");
}

test("F8: an unattested node keeps awaiting the human on EVERY subsequent drive step", () => {
  const out = driveOfflineVerdict(PLAN, atSyntaxOk(), "N1", block("auth-delta-unattested"));
  assert.equal(out.action.action, "await_human");
  const next = driveDecision(PLAN, out.state);
  assert.equal(next.action, "await_human", "this reported provisional_complete before");
  assert.deepEqual(next.nodes, ["N1"]);
});

test("F8: a node awaiting PARITY_REVIEW likewise does not complete the run", () => {
  const out = driveOfflineVerdict(PLAN, atSyntaxOk(), "N1", block("parity-not-equivalent:needs_review"));
  assert.equal(driveDecision(PLAN, out.state).action, "await_human");
});

test("F8: once the attestation lands and the verdict passes, the run completes", () => {
  let s = driveOfflineVerdict(PLAN, atSyntaxOk(), "N1", block("auth-delta-unattested")).state;
  assert.equal(driveDecision(PLAN, s).action, "await_human");
  // The human signs; the CLI re-renders the verdict with the attestation joined in.
  s = driveOfflineVerdict(PLAN, s, "N1", pass).state;
  assert.equal(s.verdict_provisional.N1, true);
  assert.equal(driveDecision(PLAN, s).action, "provisional_complete");
});

test("F8: a PASSING node rests and completes exactly as before (no blanket regression)", () => {
  const out = driveOfflineVerdict(PLAN, atSyntaxOk(), "N1", pass);
  assert.equal(out.action.action, "provisional_complete");
  assert.equal(driveDecision(PLAN, out.state).action, "provisional_complete");
});

test("F8: a node that never reached the offline verdict at all still rests (SYNTAX_OK is a rest state)", () => {
  assert.equal(driveDecision(PLAN, atSyntaxOk()).action, "provisional_complete",
    "an untouched SYNTAX_OK node is the live-lane rest state, not an unattested offline node");
});

test("F8: a quarantined BLOCK node is rested, not awaiting a human", () => {
  let s = atSyntaxOk();
  for (let i = 0; i < 3; i++) {
    s = driveOfflineVerdict(PLAN, s, "N1", block("atc-p1-nonzero")).state;
    s = applyProgress(PLAN, s, "N1", "SYNTAX_OK");
  }
  const out = driveOfflineVerdict(PLAN, s, "N1", block("atc-p1-nonzero"));
  assert.equal(out.state.status.N1, "BLOCK");
  assert.equal(driveDecision(PLAN, out.state).action, "provisional_complete");
});

test("F8: regenerating clears the awaiting state (the stale verdict is voided with it)", () => {
  const s = driveOfflineVerdict(PLAN, atSyntaxOk(), "N1", block("auth-delta-unattested")).state;
  assert.equal(driveDecision(PLAN, s).action, "await_human");
  const regenerated = applyProgress(PLAN, s, "N1", "GENERATED");
  assert.equal(regenerated.verdict_provisional.N1, undefined, "the stale verdict is voided on re-entry");
  assert.notEqual(driveDecision(PLAN, regenerated).action, "await_human",
    "a regenerated artifact owes a FRESH verdict — it is not still awaiting the old one");
});
