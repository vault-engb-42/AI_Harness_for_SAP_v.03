import { test } from "node:test";
import assert from "node:assert/strict";
import { driveDecision } from "../src/sched/drive.js";
import { initRun } from "../src/sched/loop.js";
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
