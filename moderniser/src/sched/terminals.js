/**
 * The TERMINAL vocabulary of the scheduler — which statuses end a node, which of those complete a run, and
 * the fail-closed gate on the two disposition-route terminals. Extracted from loop.js so the reducer stays
 * within the file-size limit and this one question — "what does it take to end a node?" — reads in one place.
 *
 * Pure: no state, no I/O. loop.js owns the moves; this module owns the rules those moves are checked against.
 */

/**
 * Dispositions that never become build work: `retire` has no generation at all (driveDecision routes it to
 * its own action), and `seal` is the classifier asking for manual review — generating it is the fail-open the
 * human seam exists to prevent (S5).
 */
export const NON_BUILD_DISPOSITIONS = new Set(["retire", "seal"]);

/**
 * Terminal outcomes carry semantics applyProgress cannot honour: the earned-GREEN verdict guard, the
 * dependent indegree decrement, quarantine/park bookkeeping, and the mutex release all live in applyOutcome
 * — an FSM-legal GATED→GREEN through the phase channel would bypass every one of them (branch review F2).
 */
export const TERMINAL_OUTCOMES = new Set(["GREEN", "BLOCK", "PARK", "NEEDS_MANUAL_SEAM", "RETIRED", "REBUILT_HANDOFF"]);

/**
 * The terminals that COMPLETE a run: a successful build (GREEN) or a resolved non-build disposition (a
 * dropped object / an off-stack rebuild handoff). BLOCK / PARK / NEEDS_MANUAL_SEAM leave the run incomplete.
 */
export const RUN_COMPLETE_TERMINALS = new Set(["GREEN", "RETIRED", "REBUILT_HANDOFF"]);

/**
 * The disposition-route terminals and the frozen disposition each one REQUIRES. They complete a run without
 * any verdict (nothing is built, so nothing can be gated), which makes them the one place the ratchet could
 * be talked out of a verdict entirely — so each is bound to its classification and to a named human.
 */
export const DISPOSITION_TERMINALS = new Map([["RETIRED", "retire"], ["REBUILT_HANDOFF", "rebuild"]]);

/**
 * The fail-closed gate on a disposition-route terminal (H2). RETIRED / REBUILT_HANDOFF complete a run with
 * NO verdict — nothing is generated, so the ATC/ABAP-Unit ratchet never runs — which makes them the one
 * channel where a run could be declared done without anything being gated. Two guards close it: the node's
 * FROZEN disposition must actually be the matching non-build one (a re_architect node can never be dropped),
 * and a NAMED human must sign off with a justification (mirroring PARK, L7). The disposition comes from the
 * hashed plan, so an agent cannot talk its way past it — P4's agent-proof requirement.
 */
export function assertDispositionTerminal(plan, sig, outcome) {
  const required = DISPOSITION_TERMINALS.get(outcome.status);
  const disposition = plan.nodes.find((n) => n.id === sig)?.disposition;
  if (disposition !== required) {
    throw new Error(
      `loop: ${outcome.status} for ${sig} refused — only legal for a '${required}' node (its frozen disposition is '${disposition ?? "none"}'); a node that was never built must not complete the run`,
    );
  }
  if (typeof outcome.signed_by !== "string" || outcome.signed_by.length === 0) {
    throw new Error(`loop: ${outcome.status} for ${sig} refused — a NAMED human sign-off is required (it completes the run with no verdict)`);
  }
  if (typeof outcome.justification !== "string" || outcome.justification.length === 0) {
    throw new Error(`loop: ${outcome.status} for ${sig} refused — a justification is required (it completes the run with no verdict)`);
  }
}
