import { test } from "node:test";
import assert from "node:assert/strict";
import { driveDecision } from "../src/sched/drive.js";
import { initRun, dispatch } from "../src/sched/loop.js";
import { bindArchContract } from "../src/plan/arch-contract.js";

// C / BUILD_PLAN S5 — "Transform routing placement (resolves packetOf-only-on-generate)": move disposition
// partitioning INTO driveDecision, ABOVE the frontier, before emitting `generate`. S4 (the RETIRED /
// REBUILT_HANDOFF terminals) shipped in B4; S5 did not, so EVERY dispatchable node became a `generate`
// packet whatever its disposition. Two live consequences:
//   - a `retire` node would be handed to the generator as ordinary build work (the FSM terminal existed but
//     nothing routed to it), and it wedged at GROUNDED reading as `blocked`;
//   - a `seal` node — which the classifier DOES emit today ("no clear disposition signal — manual review")
//     — was generated instead of being sent to the human seam gate. That one is a live fail-open: the
//     harness builds exactly what it flagged for manual review.
// Per S5: retire → {action:"retire"} (ledger, no generation); seal → the manual seam; only
// refactor / re_architect / rebuild / replace become generate packets, carrying a `transform` discriminator
// and the ratified contract ref.

const node = (id, disposition, extra = {}) => ({
  id, object: `Z${id}`, dependencies: [], members: [`Z${id}`], wave: 0, conflict_keys: [],
  member_meta: { [`Z${id}`]: { grade: "C", complexity: 2, blast: 1 } }, ...(disposition ? { disposition } : {}), ...extra,
});
const planOf = (...nodes) => ({ plan_hash: "h", nodes });
const ratified = (plan, state, sig) => bindArchContract(state, sig, { ref: `run/arch-contract-${sig}.json`, hash: "h1", ratified_by: "eng" });

// ---- retire: its own action, above the frontier, never a generate packet ----

test("S5 a retire node returns {action:'retire'} — never a generate packet", () => {
  const plan = planOf(node("N1", "retire"));
  const d = driveDecision(plan, initRun(plan));
  assert.equal(d.action, "retire");
  assert.deepEqual(d.packets.map((p) => p.sig), ["N1"]);
  assert.equal(d.packets[0].disposition, "retire");
});

test("S5 a retire node still routes at GROUNDED — the transit state is not a wedge", () => {
  const plan = planOf(node("N1", "retire"));
  const grounded = dispatch(plan, initRun(plan), ["N1"]); // PENDING → GROUNDED, en route to RETIRED
  const d = driveDecision(plan, grounded);
  assert.equal(d.action, "retire", "before S5 this read as {action:'blocked'} — a bug the fulfiller must stop on");
});

test("S5 retire is partitioned ABOVE the frontier: it is offered before build work", () => {
  const plan = planOf(node("N1", "retire"), node("N2", "refactor"));
  assert.equal(driveDecision(plan, initRun(plan)).action, "retire");
});

// ---- seal: the human seam, never the generator ----

test("S5 a seal node goes to the human seam gate, never to `generate` (live fail-open before S5)", () => {
  const plan = planOf(node("N1", "seal"));
  const d = driveDecision(plan, initRun(plan));
  assert.equal(d.action, "await_human");
  assert.deepEqual(d.nodes, ["N1"]);
});

test("S5 a seal node does not starve a sibling that CAN be built", () => {
  const plan = planOf(node("N1", "seal"), node("N2", "refactor"));
  const d = driveDecision(plan, initRun(plan));
  assert.equal(d.action, "generate");
  assert.deepEqual(d.packets.map((p) => p.sig), ["N2"], "the sealed node is excluded, the buildable one runs");
});

// ---- the build dispositions: a transform discriminator + the ratified contract ref ----

test("S5 a build packet carries the transform discriminator its disposition implies", () => {
  const plan = planOf(node("N1", "refactor"));
  assert.equal(driveDecision(plan, initRun(plan)).packets[0].transform, "port_in_place");
});

test("S5 a ratified re_architect packet carries transform + the contract ref the fulfiller must load", () => {
  const plan = planOf(node("N1", "re_architect"));
  const d = driveDecision(plan, ratified(plan, initRun(plan), "N1"));
  assert.equal(d.action, "generate");
  assert.equal(d.packets[0].transform, "greenfield_rap");
  assert.equal(d.packets[0].arch_contract_ref, "run/arch-contract-N1.json");
  assert.equal(d.packets[0].disposition, "re_architect");
});

test("S5 a rebuild packet generates AND is marked for the handoff spec (S4: metadata generated+gated, handoff emitted)", () => {
  const plan = planOf(node("N1", "rebuild"));
  const d = driveDecision(plan, ratified(plan, initRun(plan), "N1"));
  assert.equal(d.action, "generate");
  assert.equal(d.packets[0].transform, "greenfield_rap_plus_handoff");
});

test("S5 a node with NO disposition still generates (legacy driver-mechanics path unaffected)", () => {
  const plan = planOf(node("N1"));
  const d = driveDecision(plan, initRun(plan));
  assert.equal(d.action, "generate");
  assert.equal(d.packets[0].transform, undefined, "nothing to discriminate without a disposition");
});
