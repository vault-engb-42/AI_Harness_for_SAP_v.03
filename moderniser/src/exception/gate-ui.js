/**
 * Gate UI contract (MODERNISER_DESIGN §3.4 #8). Each GatePacket carries: kind + a
 * one-line cause; the DETERMINISTIC evidence (ATC-P1 list, parity verdict, P4-diff,
 * analyser blast radius); the plan fields from analyser-findings.json; and a TYPED
 * decision set — never free ordering. Every decision writes an audited row and NOTHING
 * lets a human grant a machine PASS (7.5 asymmetry): the decisions route work, attest, or
 * hold — the machine conjunction alone renders GREEN. Pure copy-on-write.
 *
 * The §3.4 #8 text enumerates decisions for five kinds; PARITY_REVIEW and
 * REPLAN_WAVE_MOVE are derived from their governing sections (§6.1: the gray band needs a
 * human ATTESTATION recorded as evidence — not a PASS; §6.3: a committed wave move needs
 * sign-off or the old plan stands). The two plan-time gates DISPOSITION_REVIEW (B3/S2) and
 * ARCH_REVIEW (B3.5a/S12) are PARAMETRIZED — their dedicated recorders (disposition-gate.js /
 * arch-gate.js) parse the `verb:param` form; the generic recordDecision below is for the fixed sets.
 */
import { resolveEscalation, ESCALATION_KINDS } from "./escalation-bus.js";

export const DECISIONS = Object.freeze({
  BREAK_CYCLE: ["CUT", "COGEN_RAP_BO", "SPROUT_DEFER"], //     §3.4 CycleResolution
  AUTH_EQUIVALENCE: ["ATTEST", "REJECT"], //                   security-reviewer attest / reject
  NO_RELEASED_SUCCESSOR: ["PARK_JUSTIFY", "DENY"], //          park + justify / deny
  OSCILLATION: ["RESEED_GENERATOR", "MANUAL_SEAM", "DEFER"],
  RISK_LEVEL_REVIEW: ["ADVANCE", "HOLD_FLAGGED"],
  PARITY_REVIEW: ["ATTEST_EQUIVALENT", "REJECT"], //           attestation is evidence, never a machine PASS
  REPLAN_WAVE_MOVE: ["APPROVE_REPLAN", "KEEP_PLAN"],
  DISPOSITION_REVIEW: ["approve", "override", "other"], //     plan-time disposition gate (B3/S2) — PARAMETRIZED (override:<disposition>, other:<freeform>); use plan/disposition-gate.js recordDispositionDecision, not the generic recorder
  ARCH_REVIEW: ["approve", "refine", "reject"], //             plan-time architecture gate (B3.5a/S12) — PARAMETRIZED (refine:<notes>); use plan/arch-gate.js recordArchDecision, not the generic recorder
  DROPPED_DEPENDENCY: ["ACCEPT_DROP", "REVISE_DISPOSITION"], // §7.4 — accept building the dependents against a dropped object, or go revise a disposition and `replan`
  // S14 unplaceable gate — PARAMETRIZED (override:<disposition>, other:<freeform>); use plan/arch-gate.js
  // recordNoTargetShapeDecision, not the generic recorder. Deliberately NO `approve`: there is no shape and
  // no contract to approve, so approving would resolve the gate, leave the node exactly as unbuildable as it
  // was, and put a human's name on the deadlock. The two decisions are the two real moves — re-disposition
  // the object, or say the patterns corpus is missing a shape (a human act outside this run).
  NO_TARGET_SHAPE: ["override", "other"],
  // R5 offline gate. ATTESTATION, never a machine PASS (7.5) — exactly PARITY_REVIEW's asymmetry: a named
  // human reads the artifact the analyser could not, and that reading is recorded as EVIDENCE which the
  // machine conjunction is then re-evaluated with. `REJECT` leaves the reason standing, so the node stays
  // blocked. There is deliberately no "retry": the whole point of R5 was that regeneration cannot fix an
  // engine crash, and offering it would spend the cycle budget for nothing.
  UNANALYSABLE_ARTIFACT: ["ATTEST_REVIEWED", "REJECT"],
});

const CAUSE = {
  BREAK_CYCLE: (e) => `cycle super-node over budget (${e.node_ids.length} member(s)) — approve a CUT, not an ordering`,
  AUTH_EQUIVALENCE: () => "auth footprint changed — AUTHORITY-CHECK→DCL coverage move needs attestation",
  NO_RELEASED_SUCCESSOR: () => "no released successor exists — park with justification or deny",
  OSCILLATION: (e) => `generator thrash cluster ${e.root_signature ?? ""} (${e.node_ids.length} instance(s))`,
  RISK_LEVEL_REVIEW: () => "level contains flagged node(s) — advance or hold the flagged",
  PARITY_REVIEW: () => "parity score in the [0.30, 0.70) gray band — offline never auto-passes",
  REPLAN_WAVE_MOVE: () => "a re-parse moved a committed node's wave — approve or keep the frozen plan",
  DISPOSITION_REVIEW: (e) => `disposition review for ${e.node_ids.length} node(s) — recommended disposition + alternatives in the manifest`,
  ARCH_REVIEW: (e) => `architecture review for ${e.node_ids.length} node(s) — recommended target_shape + reviewer verdict in the architecture manifest`,
  // The dropped object is named, not merely counted: the human is being asked about THIS drop, and the
  // dropped sig rides node_ids too (so two drops sharing a dependent get distinct ids), hence the -1.
  // Both are GUARDED, matching OSCILLATION eight lines above: a row raised through the generic `escalate`
  // verb carries no root_signature, and rendering the literal "undefined" plus an off-by-one count is a
  // worse failure than saying plainly that the dropped object is unnamed.
  NO_TARGET_SHAPE: (e) =>
    `no target shape fits ${e.node_ids.length} object(s) — re-disposition (override:<disposition>) rather than inventing a shape, or say the corpus is missing one`,
  UNANALYSABLE_ARTIFACT: (e) =>
    `the analyser crashed on ${e.node_ids.length} node(s)' generated artifacts — no rewrite fixes an engine `
    + "error, so a named human reads them and attests, or rejects",
  DROPPED_DEPENDENCY: (e) => {
    const dropped = e.root_signature ?? null;
    const dependents = e.node_ids.length - (dropped && e.node_ids.includes(dropped) ? 1 : 0);
    return `${dropped ?? "an unnamed object"} is being dropped but ${dependents} in-plan node(s) still depend on it — accept the drop, or revise a disposition and replan`;
  },
};

/**
 * @param {object} escalation an escalations-register row
 * @param {{evidence?: object, plan_fields?: object}} context deterministic evidence + analyser plan fields
 * @returns {object} the GatePacket
 */
export function renderPacket(escalation, context = {}) {
  if (!DECISIONS[escalation.kind]) throw new Error(`gate-ui: unknown escalation kind '${escalation.kind}'`);
  return {
    id: escalation.id,
    kind: escalation.kind,
    cause: CAUSE[escalation.kind](escalation),
    node_ids: escalation.node_ids,
    evidence: context.evidence ?? {},
    plan_fields: context.plan_fields ?? {},
    ...(escalation.seam_candidates !== undefined ? { seam_candidates: escalation.seam_candidates } : {}),
    decisions: DECISIONS[escalation.kind],
  };
}

/**
 * Record a human decision: validated against the kind's TYPED set (free-form refused),
 * stamped with the named decider, resolved exactly once.
 * @returns {{escalations: object[]}} the new register
 */
export function recordDecision(register, id, decision, { decided_by, ts, run_id, decided_generations, decided_epoch }) {
  if (typeof decided_by !== "string" || decided_by.length === 0) throw new Error("gate-ui: decided_by (a named human) is required");
  const e = register.escalations.find((x) => x.id === id);
  if (!e) throw new Error(`gate-ui: unknown escalation '${id}'`);
  if (!DECISIONS[e.kind]) throw new Error(`gate-ui: unknown escalation kind '${e.kind}' — hand-loaded row? the §3.4 taxonomy is closed`);
  if (!DECISIONS[e.kind].includes(decision)) {
    throw new Error(`gate-ui: decision '${decision}' is not in ${e.kind}'s typed set [${DECISIONS[e.kind]}] — free-form decisions are refused`);
  }
  return resolveEscalation(register, id, { resolved_by: decided_by, ts, decision, run_id, decided_generations, decided_epoch });
}

export { ESCALATION_KINDS };
