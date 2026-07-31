import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { initRun, nextDispatch, dispatch, applyProgress, applyOutcome, acquireActivation, releaseActivation, runComplete } from "../src/sched/loop.js";
import { renderVerdict, recordVerdict } from "../src/sched/verdict-ops.js";
import { assemblePlan } from "../src/sched/assemble.js";
import { freezePlan } from "../src/sched/plan.js";
import { NO_RELEASED_SUCCESSOR } from "../src/state/node-status.js";
import { bindArchContract } from "../src/plan/arch-contract.js";

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

/**
 * initRun + a ratified Architecture Contract for every arch-gated node. The reducer refuses to dispatch an
 * unratified re_architect/rebuild node (M1), and the golden abap_fico plan is entirely re_architect; these
 * tests exercise the SCHEDULER (frontier, in-degree, FSM), not the arch gate, so they enter past it.
 */
const initRatified = (plan) =>
  plan.nodes.reduce(
    (st, n) => (["re_architect", "rebuild"].includes(n.disposition)
      ? bindArchContract(st, n.id, { ref: "r", hash: `h-${n.id}`, ratified_by: "test" })
      : st),
    initRun(plan),
  );

const FORWARD = ["GROUNDED", "GENERATED", "SYNTAX_OK", "PUSHED", "ACTIVATED", "GATED"];
/** drive one dispatched node through its whole per-node FSM — verdict recorded at GATED — to GREEN */
function walkGreen(plan, state, sig) {
  for (const s of FORWARD.slice(1)) state = applyProgress(plan, state, sig, s);
  state = recordVerdict(plan, state, sig, { green: true }); // the reducer, not prose, gates GREEN
  return applyOutcome(plan, state, sig, { status: "GREEN" });
}

test("the golden ZFICO plan runs bottom-up to completion: SCR → TOP → GL", () => {
  const { plan } = assemblePlan(DOC);
  let st = initRatified(plan);
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
  st = applyOutcome(plan, st, A, { status: "PARK", reason: NO_RELEASED_SUCCESSOR, signed_by: "j.doe", justification: "no successor" });
  assert.deepEqual(st.park_register, [{ sig: A, reason: NO_RELEASED_SUCCESSOR, signed_by: "j.doe", justification: "no successor" }]);
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
  assert.throws(() => applyOutcome(plan, st, A, { status: "GREEN" }), /illegal|verdict/i, "PENDING→GREEN refused (no verdict, chain skipped)");
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
    activated: true, reconciled: true, atc_p1: 0, atc_p2: 0, unit: { green: true },
    invariants: { intact: true }, auth_coverage: { lost: false }, parity: { verdict: "PASS_STRUCTURAL" },
  };
  const evidence = { atc_p1: 0, atc_p2: 0, atc_warns: [{ file: "z.abap", line: 1 }], coverage: { pct: 0.5, bite_proven: false } };
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

test("PARK re-entry also clears the node's deferral_track quarantine (no stale live state)", () => {
  const A = "a".repeat(64);
  const plan = mkPlan([{ id: A }]);
  let st = dispatch(plan, initRun(plan), [A]);
  st = applyOutcome(plan, st, A, { status: "BLOCK", reason: NO_RELEASED_SUCCESSOR });
  st = applyOutcome(plan, st, A, { status: "PARK", reason: NO_RELEASED_SUCCESSOR, signed_by: "j.doe", justification: "no successor" });
  st = applyProgress(plan, st, A, "PENDING"); // successor ships
  assert.deepEqual(st.deferral_track, [], "quarantine record left with the park record");
  st = dispatch(plan, st, [A]);
  st = walkGreen(plan, st, A);
  assert.equal(runComplete(plan, st), true, "a re-entered node can complete the run");
});

test("dispatch enforces readiness — a dep-blocked or parked node cannot be handed out", () => {
  const A = "a".repeat(64), B = "b".repeat(64);
  const plan = mkPlan([{ id: A }, { id: B, dependencies: [A] }]);
  const st = initRun(plan);
  assert.throws(() => dispatch(plan, st, [B]), /ready|indegree|closure/i, "B's closure is not green");
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

// --- Rule-11 (CLI/skill review) remediations at the reducer level ---

test("GREEN is REFUSED without a recorded green verdict — the reducer, not prose, decides (GAN)", () => {
  const A = "a".repeat(64);
  const plan = mkPlan([{ id: A }]);
  let st = dispatch(plan, initRun(plan), [A]);
  for (const s of FORWARD.slice(1)) st = applyProgress(plan, st, A, s); // at GATED, NO verdict
  assert.throws(() => applyOutcome(plan, st, A, { status: "GREEN" }), /verdict/i);
  // a NON-green recorded verdict also refuses
  const st2 = recordVerdict(plan, st, A, { green: false });
  assert.throws(() => applyOutcome(plan, st2, A, { status: "GREEN" }), /verdict/i);
  // BLOCK never needs a verdict (fail direction is free)
  assert.equal(applyOutcome(plan, st, A, { status: "BLOCK", reason: "unit-red" }).status[A], "BLOCK");
});

test("recordVerdict is GATED-gated and copy-on-write", () => {
  const A = "a".repeat(64);
  const plan = mkPlan([{ id: A }]);
  const st = initRun(plan);
  assert.throws(() => recordVerdict(plan, st, A, { green: true }), /GATED/i, "a PENDING node has no checkpoint to verdict");
  let st2 = dispatch(plan, st, [A]);
  for (const s of FORWARD.slice(1)) st2 = applyProgress(plan, st2, A, s);
  const st3 = recordVerdict(plan, st2, A, { green: true });
  assert.equal(st3.verdict_green[A], true);
  assert.equal(st2.verdict_green[A], undefined, "input untouched");
});

test("a re-generated node's stale verdict is cleared on the retry edge (no verdict reuse)", () => {
  const A = "a".repeat(64);
  const plan = mkPlan([{ id: A }]);
  let st = dispatch(plan, initRun(plan), [A]);
  for (const s of FORWARD.slice(1)) st = applyProgress(plan, st, A, s);
  st = recordVerdict(plan, st, A, { green: true });
  st = applyProgress(plan, st, A, "GENERATED"); // checkpoint machine-BLOCK → regenerate
  assert.equal(st.verdict_green[A], undefined, "the old verdict cannot bless the NEW artifact");
});

test("PARK records the named human signer + justification (L7 audited register)", () => {
  const A = "a".repeat(64);
  const plan = mkPlan([{ id: A }]);
  let st = dispatch(plan, initRun(plan), [A]);
  st = applyOutcome(plan, st, A, { status: "BLOCK", reason: NO_RELEASED_SUCCESSOR });
  st = applyOutcome(plan, st, A, { status: "PARK", reason: NO_RELEASED_SUCCESSOR, signed_by: "j.doe", justification: "no released successor for BKPF write" });
  assert.deepEqual(st.park_register, [
    { sig: A, reason: NO_RELEASED_SUCCESSOR, signed_by: "j.doe", justification: "no released successor for BKPF write" },
  ]);
});

test("PARK is REFUSED without a named signer or justification — the EXECUTABLE path enforces L7", () => {
  const A = "a".repeat(64);
  const plan = mkPlan([{ id: A }]);
  let st = dispatch(plan, initRun(plan), [A]);
  st = applyOutcome(plan, st, A, { status: "BLOCK", reason: NO_RELEASED_SUCCESSOR });
  assert.throws(() => applyOutcome(plan, st, A, { status: "PARK", reason: NO_RELEASED_SUCCESSOR }), /sign/i);
  assert.throws(
    () => applyOutcome(plan, st, A, { status: "PARK", reason: NO_RELEASED_SUCCESSOR, signed_by: "j.doe" }),
    /justif/i,
  );
});

// --- Whole-branch review remediations (branch-review-2026-07-13: F2 / F3 / F4 cluster A1) ---

test("applyProgress REFUSES terminal statuses — outcomes must go through applyOutcome (F2)", () => {
  const A = "a".repeat(64);
  const plan = mkPlan([{ id: A }]);
  let st = dispatch(plan, initRun(plan), [A]);
  for (const s of FORWARD.slice(1)) st = applyProgress(plan, st, A, s); // at GATED
  for (const terminal of ["GREEN", "BLOCK", "NEEDS_MANUAL_SEAM"]) {
    assert.throws(() => applyProgress(plan, st, A, terminal), /applyOutcome|terminal/i, `${terminal} via progress refused`);
  }
  // PARK via progress refused too (even from a legal BLOCK/NO_RELEASED_SUCCESSOR position)
  const st2 = applyOutcome(plan, st, A, { status: "BLOCK", reason: NO_RELEASED_SUCCESSOR });
  assert.throws(() => applyProgress(plan, st2, A, "PARK"), /applyOutcome|terminal/i);
});

test("the artifact GENERATION counter increments on EVERY entry to GENERATED — retry AND re-entry regen (F4)", () => {
  const A = "a".repeat(64);
  const plan = mkPlan([{ id: A }]);
  let st = dispatch(plan, initRun(plan), [A]);
  assert.deepEqual(st.generation ?? {}, {}, "no artifact yet");
  st = applyProgress(plan, st, A, "GENERATED");
  assert.equal(st.generation[A], 1, "first artifact");
  st = applyProgress(plan, st, A, "SYNTAX_OK");
  st = applyProgress(plan, st, A, "GENERATED"); // retry edge
  assert.equal(st.generation[A], 2, "a retry regenerates");
  for (const s of ["SYNTAX_OK", "PUSHED", "ACTIVATED", "GATED"]) st = applyProgress(plan, st, A, s);
  st = applyOutcome(plan, st, A, { status: "NEEDS_MANUAL_SEAM" });
  st = applyProgress(plan, st, A, "PENDING"); // human confirms the caller set → re-entry
  st = dispatch(plan, st, [A]);
  st = applyProgress(plan, st, A, "GENERATED"); // GROUNDED→GENERATED: NOT a retry edge
  assert.equal(st.generation[A], 3, "re-entry regeneration moves the generation");
  assert.equal(st.cycle[A], 1, "…while the retry-cycle counter does NOT — the two are distinct");
});

test("generation is resume-tolerant: a legacy persisted state without the key seeds from 0", () => {
  const A = "a".repeat(64);
  const plan = mkPlan([{ id: A }]);
  const st = dispatch(plan, initRun(plan), [A]);
  delete st.generation; // a state file written before the counter existed
  const next = applyProgress(plan, st, A, "GENERATED");
  assert.equal(next.generation[A], 1);
});

test("re-entry regeneration voids the stale verdict — GREEN must be re-earned on the NEW artifact (F3)", () => {
  const A = "a".repeat(64);
  const plan = mkPlan([{ id: A }]);
  // seam detour: GATED (verdicted green) → NEEDS_MANUAL_SEAM → PENDING → re-walk
  let st = dispatch(plan, initRun(plan), [A]);
  for (const s of FORWARD.slice(1)) st = applyProgress(plan, st, A, s);
  st = recordVerdict(plan, st, A, { green: true });
  st = applyOutcome(plan, st, A, { status: "NEEDS_MANUAL_SEAM" });
  st = applyProgress(plan, st, A, "PENDING");
  st = dispatch(plan, st, [A]);
  for (const s of FORWARD.slice(1)) st = applyProgress(plan, st, A, s); // regenerated, NEVER verdicted
  assert.throws(() => applyOutcome(plan, st, A, { status: "GREEN" }), /verdict/i, "seam re-entry cannot reuse the old verdict");
  // park detour: same leak through BLOCK(NO_RELEASED_SUCCESSOR) → PARK → PENDING
  let sp = dispatch(plan, initRun(plan), [A]);
  for (const s of FORWARD.slice(1)) sp = applyProgress(plan, sp, A, s);
  sp = recordVerdict(plan, sp, A, { green: true });
  sp = applyOutcome(plan, sp, A, { status: "BLOCK", reason: NO_RELEASED_SUCCESSOR });
  sp = applyOutcome(plan, sp, A, { status: "PARK", reason: NO_RELEASED_SUCCESSOR, signed_by: "j.doe", justification: "no successor" });
  sp = applyProgress(plan, sp, A, "PENDING");
  sp = dispatch(plan, sp, [A]);
  for (const s of FORWARD.slice(1)) sp = applyProgress(plan, sp, A, s);
  assert.throws(() => applyOutcome(plan, sp, A, { status: "GREEN" }), /verdict/i, "park re-entry cannot reuse the old verdict");
});

test("applyProgress refuses GROUNDED and applyOutcome refuses non-terminals — verb symmetry (F11 escape)", () => {
  const A = "a".repeat(64), B = "b".repeat(64);
  const plan = mkPlan([{ id: A, dynamic_seal: "NEEDS_MANUAL_SEAM" }, { id: B, dependencies: [A] }]);
  const st = initRun(plan);
  // grounding through progress would bypass ALL THREE dispatch vetoes (seal probed here;
  // readiness and park ride the same guard)
  assert.throws(() => applyProgress(plan, st, A, "GROUNDED"), /dispatch/i, "sealed node cannot be grounded via progress");
  assert.throws(() => applyProgress(plan, st, B, "GROUNDED"), /dispatch/i, "unready node cannot be grounded via progress");
  // and the mirror: a phase move cannot sneak through outcome (skipping re-entry cleanup)
  const p2 = mkPlan([{ id: A }]);
  let sp = dispatch(p2, initRun(p2), [A]);
  sp = applyOutcome(p2, sp, A, { status: "NEEDS_MANUAL_SEAM" });
  assert.throws(() => applyOutcome(p2, sp, A, { status: "PENDING" }), /applyProgress|terminal/i, "re-entry goes through applyProgress (register cleanup)");
  assert.equal(applyProgress(p2, sp, A, "PENDING").status[A], "PENDING", "the legitimate re-entry verb still works");
});

test("dispatch refuses a dynamic-sealed node — the L5 seam gate holds on direct dispatch too (F11)", () => {
  const A = "a".repeat(64), B = "b".repeat(64);
  const plan = mkPlan([{ id: A, dynamic_seal: "NEEDS_MANUAL_SEAM" }, { id: B }]);
  const st = initRun(plan);
  assert.deepEqual(nextDispatch(plan, st), [B], "the frontier veto already excludes the sealed node");
  assert.throws(() => dispatch(plan, st, [A]), /seal|caller|L5/i, "direct dispatch must re-check the veto, like it re-checks park and readiness");
  assert.equal(dispatch(plan, st, [B]).status[B], "GROUNDED", "unsealed nodes dispatch normally");
});

test("state is JSON-durable: a serialize/revive round-trip resumes identically", () => {
  const { plan } = assemblePlan(DOC);
  let st = initRatified(plan);
  const r1 = nextDispatch(plan, st);
  st = dispatch(plan, st, r1);
  const revived = JSON.parse(JSON.stringify(st));
  assert.deepEqual(nextDispatch(plan, revived), nextDispatch(plan, st), "same frontier after revival");
});
