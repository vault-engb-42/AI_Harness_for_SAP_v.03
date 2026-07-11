import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { initRun, nextDispatch, dispatch, applyProgress, applyOutcome, acquireActivation, releaseActivation, renderVerdict, runComplete } from "../src/sched/loop.js";
import { assemblePlan } from "../src/sched/assemble.js";
import { freezePlan } from "../src/sched/plan.js";
import { NO_RELEASED_SUCCESSOR } from "../src/state/node-status.js";

// The scheduler LOOP (§3.1 Stage 5/6, §3.3) — a pure, resumable, sig-space reducer over the
// frozen plan alone: FSM-guarded status moves (L9), live-decrementing in-degree counter (L2),
// BLOCK quarantine (only own dependents wait), PARK register (L7), per-transport activate
// mutex (L4), and renderVerdict — the ratchetGate → nodeVerdict wiring with the SIGNED delta.
// Copy-on-write: every function returns a new state; persistence is the shell's job.

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = JSON.parse(readFileSync(join(HERE, "fixtures", "analyser-findings.json"), "utf8"));

/** synthetic frozen plan from bare node specs */
const mkPlan = (nodes) =>
  freezePlan({ nodes: nodes.map((n) => ({ wave: 0, dependencies: [], members: [n.id], member_meta: {}, conflict_keys: [], ...n })) });

const FORWARD = ["GROUNDED", "GENERATED", "SYNTAX_OK", "PUSHED", "ACTIVATED", "GATED"];
/** drive one dispatched node through its whole per-node FSM to GREEN */
function walkGreen(plan, state, sig) {
  for (const s of FORWARD.slice(1)) state = applyProgress(plan, state, sig, s);
  return applyOutcome(plan, state, sig, { status: "GREEN" });
}

test("the golden ZFICO plan runs bottom-up to completion: SCR → TOP → GL", () => {
  const { plan } = assemblePlan(DOC);
  let st = initRun(plan);
  assert.equal(st.plan_hash, plan.plan_hash, "state is bound to the plan");

  const sigOf = (o) => plan.nodes.find((n) => n.object === o).id;
  const r1 = nextDispatch(plan, st);
  assert.deepEqual(r1, [sigOf("ZFICO_BTC_CSV_SCR")], "SCR first (TOP co-tenant-deferred); no manual discount needed — deps are in-plan-transitive");
  st = dispatch(plan, st, r1);
  assert.deepEqual(nextDispatch(plan, st), [sigOf("ZFICO_BTC_CSV_TOP")], "a dispatched node is not re-dispatched; TOP no longer conflicts");
  st = walkGreen(plan, st, r1[0]);

  st = dispatch(plan, st, [sigOf("ZFICO_BTC_CSV_TOP")]);
  st = walkGreen(plan, st, sigOf("ZFICO_BTC_CSV_TOP"));

  const r3 = nextDispatch(plan, st);
  assert.deepEqual(r3, [sigOf("ZFICO_BTC_CSV_GL")], "the entry report schedules LAST, whole closure green");
  st = dispatch(plan, st, r3);
  st = walkGreen(plan, st, r3[0]);

  assert.deepEqual(nextDispatch(plan, st), []);
  assert.equal(runComplete(plan, st), true);
});

test("initRun fails closed on a dependency referencing an unknown sig", () => {
  const bad = mkPlan([{ id: "a".repeat(64), dependencies: ["f".repeat(64)] }]);
  assert.throws(() => initRun(bad), /unknown|dependency/i);
});

test("state/plan binding fails closed: a state from another plan is rejected", () => {
  const p1 = mkPlan([{ id: "a".repeat(64) }]);
  const p2 = mkPlan([{ id: "b".repeat(64) }]);
  const st = initRun(p1);
  assert.throws(() => nextDispatch(p2, st), /plan_hash/i);
  assert.throws(() => dispatch(p2, st, ["b".repeat(64)]), /plan_hash/i);
});

test("BLOCK quarantines ONLY its own dependents; independent nodes keep scheduling (L2)", () => {
  const A = "a".repeat(64), B = "b".repeat(64), C = "c".repeat(64);
  const plan = mkPlan([{ id: A }, { id: B, dependencies: [A] }, { id: C }]);
  let st = initRun(plan);
  st = dispatch(plan, st, [A, C]);
  st = applyOutcome(plan, st, A, { status: "BLOCK", reason: "unit-red" });
  assert.deepEqual(st.deferral_track, [{ sig: A, reason: "unit-red" }], "quarantined with its reason");
  assert.deepEqual(nextDispatch(plan, st), [], "B never frees (its dep is blocked), C already in flight");
  st = walkGreen(plan, st, C);
  assert.equal(runComplete(plan, st), false, "B is still unreachable — the run is NOT complete");
});

test("PARK is FSM-gated: only a NO_RELEASED_SUCCESSOR block can park; re-entry → PENDING", () => {
  const A = "a".repeat(64);
  const plan = mkPlan([{ id: A }]);
  let st = initRun(plan);
  st = dispatch(plan, st, [A]);
  st = applyOutcome(plan, st, A, { status: "BLOCK", reason: NO_RELEASED_SUCCESSOR });
  st = applyOutcome(plan, st, A, { status: "PARK", reason: NO_RELEASED_SUCCESSOR });
  assert.deepEqual(st.park_register, [{ sig: A, reason: NO_RELEASED_SUCCESSOR }]);
  assert.deepEqual(nextDispatch(plan, st), [], "parked node is not ready");
  st = applyProgress(plan, st, A, "PENDING"); // successor ships → re-entry
  assert.deepEqual(nextDispatch(plan, st), [A], "re-enters scheduling");
  // a defect BLOCK can never park
  let st2 = dispatch(plan, initRun(plan), [A]);
  st2 = applyOutcome(plan, st2, A, { status: "BLOCK", reason: "P4_VIOLATION" });
  assert.throws(() => applyOutcome(plan, st2, A, { status: "PARK", reason: "P4_VIOLATION" }), /illegal/i);
});

test("illegal FSM moves and unknown sigs fail closed everywhere", () => {
  const A = "a".repeat(64);
  const plan = mkPlan([{ id: A }]);
  const st = initRun(plan);
  assert.throws(() => applyOutcome(plan, st, A, { status: "GREEN" }), /illegal/i, "PENDING→GREEN skips the chain");
  assert.throws(() => dispatch(plan, st, ["9".repeat(64)]), /unknown/i);
  assert.throws(() => applyProgress(plan, st, A, "bogus"), /illegal/i);
});

test("the retry loop is cycle-capped through the loop API (MAX_PHASE_RETRY_CYCLES = 3)", () => {
  const A = "a".repeat(64);
  const plan = mkPlan([{ id: A }]);
  let st = dispatch(plan, initRun(plan), [A]);
  st = applyProgress(plan, st, A, "GENERATED"); // first generation
  for (let i = 0; i < 3; i += 1) {
    st = applyProgress(plan, st, A, "SYNTAX_OK");
    st = applyProgress(plan, st, A, "GENERATED"); // retries 1..3 legal (cycle 0,1,2 at check time)
  }
  st = applyProgress(plan, st, A, "SYNTAX_OK");
  assert.equal(st.cycle[A], 3, "retries counted in state");
  // the 4th retry hits the ceiling — the only move left is BLOCK
  assert.throws(() => applyProgress(plan, st, A, "GENERATED"), /illegal|cycle/i);
});

test("per-transport activate mutex serializes co-transport activation (L4)", () => {
  const A = "a".repeat(64), B = "b".repeat(64), C = "c".repeat(64);
  const plan = mkPlan([{ id: A, transport_id: "TR1" }, { id: B, transport_id: "TR1" }, { id: C, transport_id: "TR2" }]);
  let st = initRun(plan);
  let r = acquireActivation(plan, st, A);
  assert.equal(r.acquired, true);
  st = r.state;
  assert.equal(acquireActivation(plan, st, B).acquired, false, "TR1 is owned by A");
  assert.equal(acquireActivation(plan, st, A).acquired, true, "re-acquire by the owner is idempotent");
  assert.equal(acquireActivation(plan, st, C).acquired, true, "TR2 is free");
  st = releaseActivation(plan, st, A);
  assert.equal(acquireActivation(plan, st, B).acquired, true, "released → B may activate");
});

test("GREEN releases a held activation mutex automatically", () => {
  const A = "a".repeat(64), B = "b".repeat(64);
  const plan = mkPlan([{ id: A, transport_id: "TR1" }, { id: B, transport_id: "TR1" }]);
  let st = dispatch(plan, initRun(plan), [A]);
  st = acquireActivation(plan, st, A).state;
  st = walkGreen(plan, st, A);
  assert.equal(acquireActivation(plan, st, B).acquired, true, "A's terminal outcome released TR1");
});

test("renderVerdict wires ratchetGate's SIGNED delta into nodeVerdict — one coherent answer", () => {
  const node = { canonical_sig: "s".repeat(64), parity_required: false, diff_changed_lines: [{ file: "z.abap", lines: [1] }] };
  const checkpoint = {
    activated: true, reconciled: true, atc_p1: 0, unit: { green: true },
    invariants: { intact: true }, auth_coverage: { lost: false }, parity: { verdict: "PASS_STRUCTURAL" },
  };
  const evidence = { atc_p1: 0, atc_warns: [{ file: "z.abap", line: 1 }], coverage: { pct: 0.5, bite_proven: false } };
  const baselines = { atcBaseline: { per_object: {} }, covBaseline: { per_object: {} } };
  const r = renderVerdict(node, checkpoint, evidence, baselines);
  assert.equal(r.gate.verdict, "PASS", "establish-pass (seed ∞) despite 1 introduced warn");
  assert.equal(r.verdict.verdict, "GREEN", "the signed delta (0) satisfies the verdict conjunct");
  assert.equal(r.green, true);
  // and a regression blocks BOTH coherently
  const worse = { ...baselines, atcBaseline: { per_object: { ["s".repeat(64)]: 0 } } };
  const r2 = renderVerdict(node, checkpoint, evidence, worse);
  assert.equal(r2.gate.verdict, "BLOCK");
  assert.equal(r2.verdict.verdict, "BLOCK");
  assert.equal(r2.green, false);
});

test("every loop function is copy-on-write — the input state is never mutated", () => {
  const A = "a".repeat(64);
  const plan = mkPlan([{ id: A }]);
  const st0 = initRun(plan);
  const snapshot = JSON.stringify(st0);
  const st1 = dispatch(plan, st0, [A]);
  applyProgress(plan, st1, A, "GENERATED");
  acquireActivation(plan, st1, A);
  assert.equal(JSON.stringify(st0), snapshot, "st0 untouched");
  assert.notEqual(st1.status[A], st0.status[A]);
});

test("state is JSON-durable: a serialize/revive round-trip resumes identically", () => {
  const { plan } = assemblePlan(DOC);
  let st = initRun(plan);
  const r1 = nextDispatch(plan, st);
  st = dispatch(plan, st, r1);
  const revived = JSON.parse(JSON.stringify(st));
  assert.deepEqual(nextDispatch(plan, revived), nextDispatch(plan, st), "same frontier after revival");
});
