import { test } from "node:test";
import assert from "node:assert/strict";
import { STATUSES, canTransition } from "../src/state/node-status.js";
import { DISPOSITION_TERMINALS, NON_BUILD_DISPOSITIONS } from "../src/sched/terminals.js";
import { initRun, dispatch, applyProgress, applyOutcome } from "../src/sched/loop.js";
import { bindArchContract } from "../src/plan/arch-contract.js";

// LIFECYCLE INVARIANTS — property tests over the REAL edge sets, not over chosen examples.
//
// Twice in Arc B, widening one edge falsified a guard elsewhere that nothing re-checked:
//   V2 widened FORWARD to admit REBUILT_HANDOFF from the GATED states. assertDispositionTerminal's
//   guard rested on "these terminals complete a run with NO verdict" — true only because the terminal
//   had been reachable solely from GROUNDED. The premise silently became false (C2).
//   V3 guarded the phase channel against non-build dispositions but not the entry edge (C4).
//
// Example-based tests could not catch either, because the defect IS the case nobody thought to write.
// These enumerate what the code actually admits — via the public `canTransition`, so they cover the
// special-cased edges too — and therefore cover the NEXT widening automatically, with no one having to
// remember. A new edge that violates an invariant fails here, at the moment it is added.

const planOf = (disposition, extra = {}) => ({
  plan_hash: "h",
  nodes: [{ id: "N1", object: "ZOBJ", dependencies: [], members: ["ZOBJ"], wave: 0, conflict_keys: [], disposition, ...extra }],
});
/** A state parked at an arbitrary status — a fixture for a position the FSM genuinely admits. */
const at = (plan, status, over = {}) => ({ ...initRun(plan), status: { N1: status }, ...over });
const signoff = { signed_by: "eng", justification: "authorised" };

/** Every (from → terminal) edge the FSM ACTUALLY admits, derived from the public API. */
function dispositionEdges() {
  const edges = [];
  for (const to of DISPOSITION_TERMINALS.keys()) {
    for (const from of STATUSES) {
      if (canTransition(from, to)) edges.push([from, to]);
    }
  }
  return edges;
}

test("INV every disposition terminal is reachable from at least one state (nobody has orphaned one)", () => {
  for (const to of DISPOSITION_TERMINALS.keys()) {
    assert.ok(dispositionEdges().some(([, t]) => t === to), `${to} is reachable from no state at all`);
  }
});

test("INV on EVERY admitted edge, a recorded-and-FAILED verdict blocks the terminal", () => {
  // The C2 class. A named signature must never carry a node past its own failed gate, from ANY position
  // the FSM allows the terminal to be entered — including positions added after this test was written.
  for (const [from, to] of dispositionEdges()) {
    const plan = planOf(DISPOSITION_TERMINALS.get(to));
    for (const book of ["verdict_green", "verdict_provisional"]) {
      assert.throws(
        () => applyOutcome(plan, at(plan, from, { [book]: { N1: false } }), "N1", { status: to, ...signoff }),
        /verdict/i,
        `${from} → ${to} with a failed ${book}`,
      );
    }
  }
});

test("INV on EVERY admitted edge, the terminal demands a named human AND a justification", () => {
  for (const [from, to] of dispositionEdges()) {
    const plan = planOf(DISPOSITION_TERMINALS.get(to));
    assert.throws(() => applyOutcome(plan, at(plan, from), "N1", { status: to }), /sign-off|signed_by/i, `${from} → ${to} unsigned`);
    assert.throws(() => applyOutcome(plan, at(plan, from), "N1", { status: to, signed_by: "eng" }), /justification/i, `${from} → ${to} unjustified`);
  }
});

test("INV on EVERY admitted edge, the terminal is bound to the node's FROZEN disposition", () => {
  // A node that was never built must not complete the run by borrowing another disposition's terminal.
  for (const [from, to] of dispositionEdges()) {
    for (const wrong of ["refactor", "re_architect", "replace", "seal"]) {
      const plan = planOf(wrong);
      assert.throws(
        () => applyOutcome(plan, at(plan, from), "N1", { status: to, ...signoff }),
        /only legal for/i,
        `${from} → ${to} on a '${wrong}' node`,
      );
    }
  }
});

test("INV a clean node on every admitted edge DOES reach its terminal (the invariants are not vacuous)", () => {
  // Without this, every assertion above could pass because the terminal is unreachable for other reasons.
  for (const [from, to] of dispositionEdges()) {
    const plan = planOf(DISPOSITION_TERMINALS.get(to));
    assert.equal(applyOutcome(plan, at(plan, from), "N1", { status: to, ...signoff }).status.N1, to, `${from} → ${to}`);
  }
});

// ---- the C4 class: a non-build disposition must be refused at EVERY entry into the build lifecycle ----

test("INV no reducer entry point admits a non-build disposition into the build lifecycle", () => {
  // `retire` is the one exception, and only for GROUNDING: it must ground to reach RETIRED, and its own
  // terminal gate (asserted above) is what keeps that safe. Everything else — every disposition, every
  // verb — is refused. `dispatch` and `applyProgress` are both first-class CLI verbs that reach the
  // reducer directly, which is why guarding only one of them was not enough (C4).
  for (const disposition of NON_BUILD_DISPOSITIONS) {
    const plan = planOf(disposition);
    if (disposition !== "retire") {
      assert.throws(() => dispatch(plan, initRun(plan), ["N1"]), /never enters the build lifecycle/, `dispatch ${disposition}`);
    }
    const grounded = disposition === "retire" ? dispatch(plan, initRun(plan), ["N1"]) : at(plan, "GROUNDED");
    assert.throws(() => applyProgress(plan, grounded, "N1", "GENERATED"), /never enters the build lifecycle/, `progress ${disposition}`);
  }
});

test("INV a BUILD disposition is still admitted (the guard above is not blanket)", () => {
  const plan = planOf("re_architect");
  const ratified = bindArchContract(initRun(plan), "N1", { ref: "r", hash: "h1", ratified_by: "eng" });
  assert.equal(applyProgress(plan, dispatch(plan, ratified, ["N1"]), "N1", "GENERATED").status.N1, "GENERATED");
});
