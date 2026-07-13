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
 * sign-off or the old plan stands).
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
});

const CAUSE = {
  BREAK_CYCLE: (e) => `cycle super-node over budget (${e.node_ids.length} member(s)) — approve a CUT, not an ordering`,
  AUTH_EQUIVALENCE: () => "auth footprint changed — AUTHORITY-CHECK→DCL coverage move needs attestation",
  NO_RELEASED_SUCCESSOR: () => "no released successor exists — park with justification or deny",
  OSCILLATION: (e) => `generator thrash cluster ${e.root_signature ?? ""} (${e.node_ids.length} instance(s))`,
  RISK_LEVEL_REVIEW: () => "level contains flagged node(s) — advance or hold the flagged",
  PARITY_REVIEW: () => "parity score in the [0.30, 0.70) gray band — offline never auto-passes",
  REPLAN_WAVE_MOVE: () => "a re-parse moved a committed node's wave — approve or keep the frozen plan",
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
export function recordDecision(register, id, decision, { decided_by, ts, run_id, decided_generations }) {
  if (typeof decided_by !== "string" || decided_by.length === 0) throw new Error("gate-ui: decided_by (a named human) is required");
  const e = register.escalations.find((x) => x.id === id);
  if (!e) throw new Error(`gate-ui: unknown escalation '${id}'`);
  if (!DECISIONS[e.kind]) throw new Error(`gate-ui: unknown escalation kind '${e.kind}' — hand-loaded row? the §3.4 taxonomy is closed`);
  if (!DECISIONS[e.kind].includes(decision)) {
    throw new Error(`gate-ui: decision '${decision}' is not in ${e.kind}'s typed set [${DECISIONS[e.kind]}] — free-form decisions are refused`);
  }
  return resolveEscalation(register, id, { resolved_by: decided_by, ts, decision, run_id, decided_generations });
}

export { ESCALATION_KINDS };
