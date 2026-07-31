import { test } from "node:test";
import assert from "node:assert/strict";
import { initRun, dispatch, applyProgress, applyOutcome, runComplete } from "../src/sched/loop.js";
import { driveDecision } from "../src/sched/drive.js";

// B4 (§4c): the disposition-route terminals end to end through the loop reducer + driver. A retire/rebuild
// node grounds then terminates at RETIRED / REBUILT_HANDOFF via applyOutcome (a TERMINAL_OUTCOMES member),
// runComplete accepts it as a completion (not just GREEN), and it RESTS in the driver — a retired node must
// never wedge the run. Real reducer, no mocks.

const PLAN = { plan_hash: "h", nodes: [{ id: "N1", object: "ZRETIRE", dependencies: [], members: ["ZRETIRE"], wave: 0, disposition: "retire" }] };
const grounded = () => dispatch(PLAN, initRun(PLAN), ["N1"]); // PENDING → GROUNDED

test("a retire node grounds then terminates at RETIRED (no generation)", () => {
  const s = applyOutcome(PLAN, grounded(), "N1", { status: "RETIRED", reason: "no released successor" });
  assert.equal(s.status.N1, "RETIRED");
});

test("REBUILT_HANDOFF is reachable from GROUNDED as a terminal", () => {
  const s = applyOutcome(PLAN, grounded(), "N1", { status: "REBUILT_HANDOFF" });
  assert.equal(s.status.N1, "REBUILT_HANDOFF");
});

test("applyProgress REFUSES the disposition terminals (they route through applyOutcome, not phase moves)", () => {
  assert.throws(() => applyProgress(PLAN, grounded(), "N1", "RETIRED"), /terminal outcome/i);
});

test("runComplete accepts RETIRED / REBUILT_HANDOFF as terminal completions (not just GREEN)", () => {
  const s = applyOutcome(PLAN, grounded(), "N1", { status: "RETIRED" });
  assert.equal(runComplete(PLAN, s), true);
});

test("a RETIRED node is RESTED — driveDecision completes the run, never wedges", () => {
  const s = applyOutcome(PLAN, grounded(), "N1", { status: "RETIRED" });
  assert.deepEqual(driveDecision(PLAN, s), { action: "complete" });
});
