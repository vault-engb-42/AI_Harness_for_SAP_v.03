import { test } from "node:test";
import assert from "node:assert/strict";
import { driveDecision, driveReport } from "../src/sched/drive.js";
import { initRun, applyProgress, applyOutcome } from "../src/sched/loop.js";
import { MAX_PHASE_RETRY_CYCLES, NO_RELEASED_SUCCESSOR } from "../src/state/node-status.js";

// driveDecision is the deterministic stepper (Phase 2, thick-verb): given the durable run state,
// it returns the next action the fulfiller must take — {generate | await_human |
// provisional_complete | complete | blocked}. Pure over (plan, state); the CLI wraps it.

const node = (id, deps = []) => ({ id, object: id.toLowerCase(), wave: deps.length, members: [id], dependencies: deps, conflict_keys: [] });
const PLAN = { plan_hash: "h1", generator_team_size: 8, nodes: [node("N1"), node("N2", ["N1"])] };
const stateWith = (statuses) => ({ ...initRun(PLAN), status: { ...initRun(PLAN).status, ...statuses } });

test("a fresh run returns generate for the ready frontier (roots only; N2 waits on N1)", () => {
  const d = driveDecision(PLAN, initRun(PLAN));
  assert.equal(d.action, "generate");
  assert.deepEqual(d.packets.map((p) => p.sig), ["N1"]);
  assert.equal(d.packets[0].object, "n1");
});

test("all nodes GREEN → complete", () => {
  assert.equal(driveDecision(PLAN, stateWith({ N1: "GREEN", N2: "GREEN" })).action, "complete");
});

test("frontier empty + rested SYNTAX_OK + a starved PENDING dependent → provisional_complete (sweep exit)", () => {
  // N1 rests at SYNTAX_OK offline; N2 is PENDING with indegree 1 (N1 never GREENs offline) — a
  // starved dependent is a SWEEP target, not a wedge.
  assert.equal(driveDecision(PLAN, stateWith({ N1: "SYNTAX_OK" })).action, "provisional_complete");
});

test("a machine-quarantined BLOCK node with rested peers still sweeps (BLOCK is not a human gate)", () => {
  assert.equal(driveDecision(PLAN, stateWith({ N1: "BLOCK", N2: "PENDING" })).action, "provisional_complete");
});

test("a NEEDS_MANUAL_SEAM node → await_human", () => {
  const d = driveDecision(PLAN, stateWith({ N1: "NEEDS_MANUAL_SEAM" }));
  assert.equal(d.action, "await_human");
  assert.ok(d.nodes.includes("N1"));
});

test("a parked node → await_human", () => {
  const s = stateWith({ N1: "PARK" });
  s.park_register = [{ sig: "N1", reason: "NO_RELEASED_SUCCESSOR" }];
  const d = driveDecision(PLAN, s);
  assert.equal(d.action, "await_human");
  assert.ok(d.nodes.includes("N1"));
});

test("a node wedged mid-flight (GROUNDED, not dispatchable, not rested) → blocked (fail-closed surface)", () => {
  const d = driveDecision(PLAN, stateWith({ N1: "GROUNDED" }));
  assert.equal(d.action, "blocked");
  assert.ok(d.nodes.some((n) => n.sig === "N1" && n.status === "GROUNDED"));
});

// ---- driveReport (increment 2, Option A): the driver OWNS retry-vs-ceiling ----
// The fulfiller reports the syntax self-check outcome; driveReport orchestrates the reducer,
// counts the attempts (syntax_attempts — SEPARATE from the FSM post-verdict `cycle`), decides,
// and returns {state, action}. Pure over (plan, state); cli-drive.js persists the state.

test("driveReport syntax_ok advances a fresh frontier node to SYNTAX_OK, then decides", () => {
  const { state, action } = driveReport(PLAN, initRun(PLAN), "N1", "syntax_ok");
  assert.equal(state.status.N1, "SYNTAX_OK");
  // N1 rests at SYNTAX_OK; N2 is a starved PENDING dependent (offline never GREENs) → sweep exit.
  assert.equal(action.action, "provisional_complete");
});

test("driveReport syntax_fail bumps syntax_attempts and re-issues the SAME node to regenerate", () => {
  const { state, action } = driveReport(PLAN, initRun(PLAN), "N1", "syntax_fail");
  assert.equal(state.syntax_attempts.N1, 1);
  assert.equal(state.status.N1, "GENERATED", "the node rests at GENERATED for the retry");
  assert.equal(action.action, "generate");
  assert.deepEqual(action.packets.map((p) => p.sig), ["N1"]);
  assert.equal(action.packets[0].retry, true);
});

test("driveReport generator_error counts as a failed attempt, same as syntax_fail", () => {
  const { state, action } = driveReport(PLAN, initRun(PLAN), "N1", "generator_error");
  assert.equal(state.syntax_attempts.N1, 1);
  assert.equal(action.action, "generate");
  assert.equal(action.packets[0].retry, true);
});

test("driveReport blocks the node at the syntax ceiling (SYNTAX_CEILING)", () => {
  let state = initRun(PLAN);
  for (let i = 1; i < MAX_PHASE_RETRY_CYCLES; i += 1) {
    const r = driveReport(PLAN, state, "N1", "syntax_fail");
    state = r.state;
    assert.equal(r.action.action, "generate", `attempt ${i} still retries`);
    assert.equal(state.syntax_attempts.N1, i);
  }
  const r = driveReport(PLAN, state, "N1", "syntax_fail"); // the ceiling-th attempt
  assert.equal(r.state.syntax_attempts.N1, MAX_PHASE_RETRY_CYCLES);
  assert.equal(r.state.status.N1, "BLOCK");
  assert.ok(r.state.deferral_track.some((d) => d.sig === "N1" && d.reason === "SYNTAX_CEILING"));
  // N1 quarantined, N2 starved — BLOCK is not a human gate, so the offline pass sweeps.
  assert.equal(r.action.action, "provisional_complete");
});

test("driveReport syntax_ok is idempotent on a repeated report (already SYNTAX_OK)", () => {
  const first = driveReport(PLAN, initRun(PLAN), "N1", "syntax_ok");
  const second = driveReport(PLAN, first.state, "N1", "syntax_ok");
  assert.equal(second.state.status.N1, "SYNTAX_OK");
});

test("driveReport rejects an unknown node (fail-closed)", () => {
  assert.throws(() => driveReport(PLAN, initRun(PLAN), "NOPE", "syntax_ok"), /unknown node/i);
});

test("re-entry (PARK → PENDING) clears the syntax_attempts counter", () => {
  // A node accrues a syntax attempt, then parks and re-enters; the counter must reset so the
  // re-walk starts fresh (mirrors the verdict_green/verdict_provisional voiding on re-entry).
  let s = driveReport(PLAN, initRun(PLAN), "N1", "syntax_fail").state; // N1 GENERATED, attempts=1
  s = applyOutcome(PLAN, s, "N1", { status: "BLOCK", reason: NO_RELEASED_SUCCESSOR });
  s = applyOutcome(PLAN, s, "N1", { status: "PARK", reason: NO_RELEASED_SUCCESSOR, signed_by: "j.doe", justification: "no successor" });
  assert.equal(s.syntax_attempts.N1, 1, "the counter survives the park detour");
  s = applyProgress(PLAN, s, "N1", "PENDING"); // successor ships → re-entry
  assert.equal(s.syntax_attempts.N1, undefined, "re-entry resets the syntax counter");
});
