import { test } from "node:test";
import assert from "node:assert/strict";
import { driveDecision } from "../src/sched/drive.js";
import { initRun, dispatch } from "../src/sched/loop.js";
import { bindArchContract } from "../src/plan/arch-contract.js";

// B4 (§4c): the fail-closed drive precondition — driveDecision REFUSES to dispatch a re_architect/rebuild
// node until its Architecture Contract is human-ratified (isArchRatified). This is the load-bearing proof
// that the arch gate (arch-contract.js + state.arch_contracts) is WIRED into the driver, not an orphan: an
// unratified re_architect node can never be generated (its target_shape is unknown until ratified). A
// non-arch disposition (refactor) and a dispositionless node dispatch unchanged — the gate is targeted.

const planWith = (disposition) => ({
  plan_hash: "h",
  nodes: [{ id: "N1", object: "ZFOO", dependencies: [], members: ["ZFOO"], wave: 0, conflict_keys: [], ...(disposition ? { disposition } : {}) }],
});

test("driveDecision REFUSES an unratified re_architect node — await_human (arch_ratification), never generate", () => {
  const plan = planWith("re_architect");
  const d = driveDecision(plan, initRun(plan));
  assert.equal(d.action, "await_human");
  assert.equal(d.reason, "arch_ratification");
  assert.deepEqual(d.nodes, ["N1"]);
});

test("driveDecision dispatches a re_architect node ONCE its contract is ratified", () => {
  const plan = planWith("re_architect");
  const ratified = bindArchContract(initRun(plan), "N1", { ref: "r", hash: "h1", ratified_by: "eng" });
  const d = driveDecision(plan, ratified);
  assert.equal(d.action, "generate");
  assert.equal(d.packets[0].sig, "N1");
});

test("a bound-but-unratified contract still REFUSES (ratification, not mere binding, unlocks generation)", () => {
  const plan = planWith("re_architect");
  const bound = bindArchContract(initRun(plan), "N1", { ref: "r", hash: "h1", ratified_by: null });
  assert.equal(driveDecision(plan, bound).action, "await_human");
});

test("rebuild is gated like re_architect", () => {
  const plan = planWith("rebuild");
  assert.equal(driveDecision(plan, initRun(plan)).action, "await_human");
});

test("a non-arch disposition (refactor) dispatches without ratification (control — the gate is targeted)", () => {
  const plan = planWith("refactor");
  assert.equal(driveDecision(plan, initRun(plan)).action, "generate");
});

test("a node with NO disposition dispatches (legacy driver-mechanics path unaffected)", () => {
  const plan = planWith(null);
  assert.equal(driveDecision(plan, initRun(plan)).action, "generate");
});

// M5 (Rule-11 review, CONFIRMED): the arch gate must apply BEFORE the team-size cap. nextFrontier sorts the
// ready set worst-debt-first and then breaks at the cap with no knowledge of arch-gating, so a downstream
// filter lets an unratified node CONSUME a cap slot and then vanish — starving genuinely dispatchable work
// and stalling the run for a reason no gate explains.

// The meta is chosen (probe-verified) so that A sorts AHEAD of B in the ready set: with one team slot, A
// takes it. A is arch-gated and unratified; B is dispatchable right now.
const cappedPlan = () => ({
  plan_hash: "h",
  generator_team_size: 1, // one slot: whoever sorts first takes it
  nodes: [
    { id: "A", object: "ZA", dependencies: [], members: ["ZA"], wave: 0, conflict_keys: [], disposition: "re_architect", member_meta: { ZA: { grade: "A", complexity: 1, blast: 0 } } },
    { id: "B", object: "ZB", dependencies: [], members: ["ZB"], wave: 0, conflict_keys: [], disposition: "refactor", member_meta: { ZB: { grade: "F", complexity: 99, blast: 99 } } },
  ],
});

test("M5 an unratified arch node must not CONSUME a team-size slot and starve ready work", () => {
  const plan = cappedPlan();
  const d = driveDecision(plan, initRun(plan));
  assert.equal(d.action, "generate", "the ready refactor node is dispatchable — the run must not stall");
  assert.deepEqual(d.packets.map((p) => p.sig), ["B"], "the cap slot goes to the node that can actually run");
});

test("M5 once the arch node is ratified it competes for the slot again (worst-debt-first restored)", () => {
  const plan = cappedPlan();
  const ratified = bindArchContract(initRun(plan), "A", { ref: "r", hash: "h1", ratified_by: "eng" });
  assert.deepEqual(driveDecision(plan, ratified).packets.map((p) => p.sig), ["A"], "worst debt takes the slot");
});

// M1 (Rule-11 review, CONFIRMED by live probe): the veto must live in the REDUCER, not only in the driver's
// frontier filter. cli.js exposes `dispatch` and `progress` as first-class verbs that call the reducer
// directly, so a driveDecision-only guard is bypassable — an unratified re_architect node could be walked
// to GENERATED through a different verb. dispatch() is the single chokepoint into the build lifecycle.

test("M1 dispatch() REFUSES an unratified arch-gated node (the veto is not bypassable via the reducer verbs)", () => {
  for (const d of ["re_architect", "rebuild"]) {
    const plan = planWith(d);
    assert.throws(() => dispatch(plan, initRun(plan), ["N1"]), /arch-gated|not human-ratified/i, d);
  }
});

test("M1 dispatch() admits a RATIFIED arch node, and any non-arch node, unchanged", () => {
  const plan = planWith("re_architect");
  const ratified = bindArchContract(initRun(plan), "N1", { ref: "r", hash: "h1", ratified_by: "eng" });
  assert.equal(dispatch(plan, ratified, ["N1"]).status.N1, "GROUNDED", "a ratified arch node grounds");
  const refactor = planWith("refactor");
  assert.equal(dispatch(refactor, initRun(refactor), ["N1"]).status.N1, "GROUNDED", "a non-arch node is untouched");
});
