import { test } from "node:test";
import assert from "node:assert/strict";
import { initRun, dispatch, applyProgress, applyOutcome, runComplete } from "../src/sched/loop.js";
import { recordVerdict, recordProvisionalVerdict } from "../src/sched/verdict-ops.js";
import { driveDecision } from "../src/sched/drive.js";
import { bindArchContract } from "../src/plan/arch-contract.js";

// B4 (§4c): the disposition-route terminals end to end through the loop reducer + driver. A retire/rebuild
// node grounds then terminates at RETIRED / REBUILT_HANDOFF via applyOutcome (a TERMINAL_OUTCOMES member),
// runComplete accepts it as a completion (not just GREEN), and it RESTS in the driver — a retired node must
// never wedge the run. Real reducer, no mocks.
//
// H2 (Rule-11 review, CONFIRMED by live probe): these terminals complete a run with NO verdict, so they carry
// their own fail-closed gate. Before it, ANY grounded node — including a re_architect node that was never
// built or gated — could be declared RETIRED and the run reported complete: a ratchet fail-open. The gate
// binds the terminal to the node's frozen disposition AND demands a named human sign-off + justification.

const planOf = (disposition) => ({
  plan_hash: "h",
  nodes: [{ id: "N1", object: "ZOBJ", dependencies: [], members: ["ZOBJ"], wave: 0, conflict_keys: [], disposition }],
});
const RETIRE_PLAN = planOf("retire");
const REBUILD_PLAN = planOf("rebuild");
const ARCH_PLAN = planOf("re_architect");

// PENDING → GROUNDED. An arch-gated disposition (re_architect/rebuild) may not enter the lifecycle before
// its Architecture Contract is ratified (M1), so those plans are handed a ratified binding first — the
// subject under test here is the TERMINAL gate, not the arch gate.
const grounded = (plan) => {
  const base = initRun(plan);
  const archGated = ["re_architect", "rebuild"].includes(plan.nodes[0].disposition);
  const state = archGated ? bindArchContract(base, "N1", { ref: "r", hash: "h1", ratified_by: "eng" }) : base;
  return dispatch(plan, state, ["N1"]);
};
const signoff = { signed_by: "eng", justification: "no released successor; the capability is dropped" };

test("a retire node grounds then terminates at RETIRED with a named sign-off (no generation)", () => {
  const s = applyOutcome(RETIRE_PLAN, grounded(RETIRE_PLAN), "N1", { status: "RETIRED", reason: "no released successor", ...signoff });
  assert.equal(s.status.N1, "RETIRED");
});

test("REBUILT_HANDOFF is reachable from GROUNDED as a terminal for a rebuild node", () => {
  const s = applyOutcome(REBUILD_PLAN, grounded(REBUILD_PLAN), "N1", { status: "REBUILT_HANDOFF", ...signoff });
  assert.equal(s.status.N1, "REBUILT_HANDOFF");
});

// V2 (adversarial pass #3, CONFIRMED): the FSM admitted REBUILT_HANDOFF only from GROUNDED, but drive.js
// routes `rebuild` through FULL generation (transform `greenfield_rap_plus_handoff`). So the driver's own
// prescribed action and the terminal were mutually exclusive: follow `drive`, land at SYNTAX_OK or
// PROVISIONAL_GATED, and the terminal became permanently unreachable for that node.
//
// BUILD_PLAN S4 is unambiguous about which side is wrong — REBUILT_HANDOFF is "ABAP/OData/Fiori-metadata
// generated+gated, JS handoff-spec emitted", i.e. entered AFTER generation. The pre-generation edge stays
// legal too: a rebuild that is entirely off-stack has nothing to generate first.
test("V2 a rebuild node hands off AFTER generation — the route the driver actually prescribes", () => {
  const plan = REBUILD_PLAN;
  let s = grounded(plan);
  for (const st of ["GENERATED", "SYNTAX_OK", "PROVISIONAL_GATED"]) s = applyProgress(plan, s, "N1", st);
  const out = applyOutcome(plan, s, "N1", { status: "REBUILT_HANDOFF", ...signoff });
  assert.equal(out.status.N1, "REBUILT_HANDOFF");
  assert.equal(runComplete(plan, out), true, "and the run completes on the designed lifecycle");
});

test("V2 the live path lands it too (GATED), and the gate still binds", () => {
  const plan = REBUILD_PLAN;
  let s = grounded(plan);
  for (const st of ["GENERATED", "SYNTAX_OK", "PUSHED", "ACTIVATED", "GATED"]) s = applyProgress(plan, s, "N1", st);
  assert.equal(applyOutcome(plan, s, "N1", { status: "REBUILT_HANDOFF", ...signoff }).status.N1, "REBUILT_HANDOFF");
  assert.throws(() => applyOutcome(plan, s, "N1", { status: "REBUILT_HANDOFF" }), /sign-off|signed_by/i, "the named-human gate is unchanged");
  assert.throws(() => applyOutcome(RETIRE_PLAN, grounded(RETIRE_PLAN), "N1", { status: "REBUILT_HANDOFF", ...signoff }), /only legal for a 'rebuild' node/);
});

// C2 (closeout pass, CONFIRMED): assertDispositionTerminal's guard rests on the premise that these
// terminals "complete a run with NO verdict" — true by construction while REBUILT_HANDOFF was reachable
// only from GROUNDED, i.e. before any gate could have run. V2 widened the edge to the GATED states, where a
// verdict may already have RUN AND FAILED. A signature must not be able to carry a node past its own failed
// gate: "quality only tightens; a failed gate is a FAIL, never a pass".
test("C2 a node whose live verdict RAN AND FAILED cannot complete the run through REBUILT_HANDOFF", () => {
  const plan = REBUILD_PLAN;
  let s = grounded(plan);
  for (const st of ["GENERATED", "SYNTAX_OK", "PUSHED", "ACTIVATED", "GATED"]) s = applyProgress(plan, s, "N1", st);
  s = recordVerdict(plan, s, "N1", { green: false });
  assert.throws(() => applyOutcome(plan, s, "N1", { status: "REBUILT_HANDOFF", ...signoff }), /verdict/i);
});

test("C2 the OFFLINE sibling is gated the same way (a failed provisional verdict blocks the handoff)", () => {
  const plan = REBUILD_PLAN;
  let s = grounded(plan);
  for (const st of ["GENERATED", "SYNTAX_OK", "PROVISIONAL_GATED"]) s = applyProgress(plan, s, "N1", st);
  s = recordProvisionalVerdict(plan, s, "N1", { provisional: false });
  assert.throws(() => applyOutcome(plan, s, "N1", { status: "REBUILT_HANDOFF", ...signoff }), /verdict/i);
});

test("C2 a PASSING verdict, and the no-verdict route V2 was built for, both still complete", () => {
  const plan = REBUILD_PLAN;
  let passed = grounded(plan);
  for (const st of ["GENERATED", "SYNTAX_OK", "PROVISIONAL_GATED"]) passed = applyProgress(plan, passed, "N1", st);
  passed = recordProvisionalVerdict(plan, passed, "N1", { provisional: true });
  assert.equal(applyOutcome(plan, passed, "N1", { status: "REBUILT_HANDOFF", ...signoff }).status.N1, "REBUILT_HANDOFF");
  // and the pre-generation route, where no gate has run at all, is untouched
  assert.equal(applyOutcome(plan, grounded(plan), "N1", { status: "REBUILT_HANDOFF", ...signoff }).status.N1, "REBUILT_HANDOFF");
});

test("applyProgress REFUSES the disposition terminals (they route through applyOutcome, not phase moves)", () => {
  assert.throws(() => applyProgress(RETIRE_PLAN, grounded(RETIRE_PLAN), "N1", "RETIRED"), /terminal outcome/i);
});

test("runComplete accepts RETIRED / REBUILT_HANDOFF as terminal completions (not just GREEN)", () => {
  const s = applyOutcome(RETIRE_PLAN, grounded(RETIRE_PLAN), "N1", { status: "RETIRED", ...signoff });
  assert.equal(runComplete(RETIRE_PLAN, s), true);
});

test("a RETIRED node is RESTED — driveDecision completes the run, never wedges", () => {
  const s = applyOutcome(RETIRE_PLAN, grounded(RETIRE_PLAN), "N1", { status: "RETIRED", ...signoff });
  assert.deepEqual(driveDecision(RETIRE_PLAN, s), { action: "complete" });
});

// ---- H2: the fail-closed gate on the disposition terminals ----

test("H2 RETIRED is REFUSED for a node whose disposition is not 'retire' (a re_architect node cannot be dropped)", () => {
  assert.throws(
    () => applyOutcome(ARCH_PLAN, grounded(ARCH_PLAN), "N1", { status: "RETIRED", ...signoff }),
    /only legal for a 'retire' node|disposition/i,
    "an un-built, un-gated re_architect node must never reach a run-completing terminal",
  );
});

test("H2 REBUILT_HANDOFF is REFUSED for a node whose disposition is not 'rebuild'", () => {
  assert.throws(
    () => applyOutcome(RETIRE_PLAN, grounded(RETIRE_PLAN), "N1", { status: "REBUILT_HANDOFF", ...signoff }),
    /only legal for a 'rebuild' node|disposition/i,
  );
});

test("H2 both terminals REQUIRE a named human sign-off + a justification (they complete a run with no verdict)", () => {
  for (const [plan, status] of [[RETIRE_PLAN, "RETIRED"], [REBUILD_PLAN, "REBUILT_HANDOFF"]]) {
    assert.throws(() => applyOutcome(plan, grounded(plan), "N1", { status }), /sign-off|signed_by/i, `${status} without a signer`);
    assert.throws(() => applyOutcome(plan, grounded(plan), "N1", { status, signed_by: "eng" }), /justification/i, `${status} without a justification`);
    assert.throws(() => applyOutcome(plan, grounded(plan), "N1", { status, justification: "x" }), /sign-off|signed_by/i, `${status} with a justification but no signer`);
  }
});

// H2-followup (adversarial pass #2): the sign-off was VALIDATED and then discarded. PARK persists its
// audited row (signer + justification) into the run state; these terminals complete a run with no verdict
// at all, so their justification is the ONLY record of why an object was dropped or handed off — losing it
// leaves the proof bundle unable to say who authorised it.

test("H2-followup the terminal's sign-off is PERSISTED as an audit row, like PARK's register", () => {
  const s = applyOutcome(RETIRE_PLAN, grounded(RETIRE_PLAN), "N1", { status: "RETIRED", reason: "no released successor", ...signoff });
  assert.deepEqual(s.disposition_register, [{
    sig: "N1", status: "RETIRED", reason: "no released successor",
    signed_by: "eng", justification: "no released successor; the capability is dropped",
  }]);
});

test("H2-followup initRun seeds the register, and REBUILT_HANDOFF records its own row", () => {
  assert.deepEqual(initRun(RETIRE_PLAN).disposition_register, []);
  const s = applyOutcome(REBUILD_PLAN, grounded(REBUILD_PLAN), "N1", { status: "REBUILT_HANDOFF", ...signoff });
  assert.equal(s.disposition_register.length, 1);
  assert.equal(s.disposition_register[0].status, "REBUILT_HANDOFF");
  assert.equal(s.disposition_register[0].signed_by, "eng");
});

// P3: a dependency that RESOLVES stops blocking its dependents. Only GREEN used to decrement the readiness
// counter, which was invisible while no plan could contain a `retire` node — the B2 classifier deliberately
// never emits one (§186). The operator-override path creates the first, and with it the deadlock: a node
// whose dependency was dropped waited at indegree > 0 forever, `dispatch` refused it ("its closure is not
// green"), the retire route skipped it (it requires indegree 0), and the run could never complete.

const CHAIN = (disposition) => ({
  plan_hash: "h",
  nodes: [
    { id: "N1", object: "ZDEP", dependencies: [], members: ["ZDEP"], wave: 0, conflict_keys: [], disposition },
    { id: "N2", object: "ZUSE", dependencies: ["N1"], members: ["ZUSE"], wave: 1, conflict_keys: [], disposition },
  ],
});

test("P3 a RETIRED dependency releases its dependents — a dropped object must not deadlock the run", () => {
  const plan = CHAIN("retire");
  const state = dispatch(plan, initRun(plan), ["N1"]);
  assert.equal(state.indegree.N2, 1, "N2 waits on N1 while N1 is unresolved");
  const s = applyOutcome(plan, state, "N1", { status: "RETIRED", ...signoff });
  assert.equal(s.indegree.N2, 0, "N1 is resolved — it is not coming, so N2 stops waiting for it");
  assert.equal(driveDecision(plan, s).action, "retire", "and the driver can now route N2");
});

test("P3 a REBUILT_HANDOFF dependency releases its dependents too (the capability moved off-stack)", () => {
  const plan = CHAIN("rebuild");
  const ratifiedState = ["N1", "N2"].reduce((st, sig) => bindArchContract(st, sig, { ref: "r", hash: "h1", ratified_by: "eng" }), initRun(plan));
  const s = applyOutcome(plan, dispatch(plan, ratifiedState, ["N1"]), "N1", { status: "REBUILT_HANDOFF", ...signoff });
  assert.equal(s.indegree.N2, 0);
});

test("P3 a non-completing terminal still blocks: a BLOCKed dependency leaves the dependent waiting", () => {
  // The rule is 'a RESOLVED dependency stops blocking', not 'any terminal'. A quarantined dependency is
  // unresolved — its dependents must keep waiting, which is what quarantine means (L2). PARK is not
  // reachable from GROUNDED at all (its own FSM gate), so BLOCK is the case that could have regressed.
  const plan = CHAIN("refactor");
  const state = dispatch(plan, initRun(plan), ["N1"]);
  assert.equal(applyOutcome(plan, state, "N1", { status: "BLOCK", reason: "r" }).indegree.N2, 1);
});

// R3 (adversarial pass, CONFIRMED): the operator override is the only way a node can be BOTH dynamic-sealed
// and `retire` — the classifier sends a sealed node to `seal`. That combination froze an unexecutable plan:
// driveDecision offers the retire route (it partitions above the frontier), `outcome RETIRED` is only legal
// from GROUNDED, and `dispatch` — the only way to reach GROUNDED — hard-refused the sealed node. The driver
// emitted `retire` forever and no verb could execute it.
//
// The veto's own rationale is why the narrow exception is right: it exists so "a sealed node must never
// reach a node driver — signature-changing modernisation waits for the human caller-set confirmation". A
// retire reaches no generator at all, and its terminal already demands a named human plus a justification.

const sealed = (disposition) => ({
  plan_hash: "h",
  nodes: [{ id: "N1", object: "ZOBJ", dependencies: [], members: ["ZOBJ"], wave: 0, conflict_keys: [], disposition, dynamic_seal: "NEEDS_MANUAL_SEAM" }],
});

test("R3 a dynamic-sealed node the operator chose to RETIRE can reach its terminal", () => {
  const plan = sealed("retire");
  const state = initRun(plan);
  assert.equal(driveDecision(plan, state).action, "retire", "the driver offers it");
  const s = applyOutcome(plan, dispatch(plan, state, ["N1"]), "N1", { status: "RETIRED", ...signoff });
  assert.equal(s.status.N1, "RETIRED");
  assert.equal(runComplete(plan, s), true, "and the run can actually complete");
});

// V3 (adversarial pass #3, CONFIRMED by probe): R3 let a sealed `retire` node ground, justified by the
// claim that "a retire reaches no generator at all". That was an assumption about driveDecision's routing,
// not a property anything enforced — `progress` and `drive --report` reach the reducer directly and walked
// the node GROUNDED → GENERATED, handing back a `generate` packet for a dynamic-sealed object.
//
// The verifier's sharpest correction: an UNSEALED retire node behaved identically, so R3's marginal delta
// was nil and the real hole is older — NON_BUILD_DISPOSITIONS was only ever a frontier hint, never a gate.
test("V3 a non-build disposition cannot be walked into the build lifecycle by the granular verbs", () => {
  for (const d of ["retire", "seal"]) {
    const plan = { plan_hash: "h", nodes: [{ id: "N1", object: "ZOBJ", dependencies: [], members: ["ZOBJ"], wave: 0, conflict_keys: [], disposition: d }] };
    const grounded = d === "retire" ? dispatch(plan, initRun(plan), ["N1"]) : initRun(plan);
    assert.throws(() => applyProgress(plan, grounded, "N1", "GENERATED"), /never enters the build lifecycle/, d);
  }
});

test("V3 the same guard holds for the SEALED retire node R3 admitted, and its terminal still works", () => {
  const plan = sealed("retire");
  const grounded = dispatch(plan, initRun(plan), ["N1"]);
  assert.throws(() => applyProgress(plan, grounded, "N1", "GENERATED"), /never enters the build lifecycle/);
  const s = applyOutcome(plan, grounded, "N1", { status: "RETIRED", ...signoff });
  assert.equal(s.status.N1, "RETIRED", "the route R3 opened still reaches its terminal");
});

test("V3 re-entry to PENDING stays legal — that is how a sealed node returns to be re-dispositioned", () => {
  const plan = sealed("seal");
  const state = { ...initRun(plan), status: { N1: "NEEDS_MANUAL_SEAM" } };
  assert.equal(applyProgress(plan, state, "N1", "PENDING").status.N1, "PENDING");
});

test("R3 the seal veto still refuses a sealed node that could become BUILD work", () => {
  for (const d of ["refactor", "replace"]) {
    assert.throws(() => dispatch(sealed(d), initRun(sealed(d)), ["N1"]), /dynamic-sealed/, d);
  }
});

test("R3 a sealed node with NO disposition is still refused (fail-closed on an absent classification)", () => {
  const plan = { plan_hash: "h", nodes: [{ id: "N1", object: "ZOBJ", dependencies: [], members: ["ZOBJ"], wave: 0, conflict_keys: [], dynamic_seal: "NEEDS_MANUAL_SEAM" }] };
  assert.throws(() => dispatch(plan, initRun(plan), ["N1"]), /dynamic-sealed/);
});

test("H2 a node with NO disposition can reach neither terminal (fail-closed on an absent classification)", () => {
  const bare = { plan_hash: "h", nodes: [{ id: "N1", object: "ZOBJ", dependencies: [], members: ["ZOBJ"], wave: 0, conflict_keys: [] }] };
  for (const status of ["RETIRED", "REBUILT_HANDOFF"]) {
    assert.throws(() => applyOutcome(bare, grounded(bare), "N1", { status, ...signoff }), /disposition|only legal/i, status);
  }
});
