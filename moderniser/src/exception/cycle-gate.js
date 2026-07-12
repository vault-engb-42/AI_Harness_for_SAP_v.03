/**
 * Break-the-cycle gate (MODERNISER_DESIGN §3.4 #4, L5). Wraps graph/feedback's
 * `minFeedbackArcSet` as the seam proposer; resolved cycles are LEARNED keyed by the
 * member-signature-set (§3.4 #6 `seam-memory.json`), so an identical cycle in a later run
 * auto-proposes the prior resolution with RAISED (never certain) confidence. The human
 * approves a CUT / COGEN_RAP_BO / SPROUT_DEFER — never an ordering. Pure copy-on-write
 * over the seam-memory; timestamps injected.
 */
import { createHash } from "node:crypto";
import { minFeedbackArcSet } from "../graph/feedback.js";

const FIRST_CONFIDENCE = 0.6; //  a once-confirmed seam is a strong prior, not a certainty
const CONFIDENCE_STEP = 0.15; //  each re-confirmation raises it…
const CONFIDENCE_CAP = 0.95; //   …but it never reaches 1 (the human always decides)

/** Canonical member-signature-set key — order-independent, content-derived (§3.4 #6). */
export function memberSigSetKey(sigs) {
  return createHash("sha256").update(JSON.stringify([...new Set(sigs)].sort())).digest("hex");
}

/** @returns {{resolution: object, confidence: number, resolved_at: string}|null} */
export function lookupLearnedSeam(memory, sigs) {
  return memory.learned?.[memberSigSetKey(sigs)] ?? null;
}

/**
 * Propose seams for an over-budget cycle super-node: the learned prior (if any) leads,
 * fresh minFeedbackArcSet candidates follow.
 * @param {{members: string[], edges: Array<[string, string]>}} scc
 * @param {number} budget SESSION_BUDGET
 * @param {{learned: Record<string, object>}} memory
 * @returns {{learned: object|null, seams: object[], sub_components: string[][]}}
 */
export function proposeSeams(scc, budget, memory) {
  const { seams, sub_components } = minFeedbackArcSet(scc, budget);
  return { learned: lookupLearnedSeam(memory, scc.members), seams, sub_components };
}

const REQUIRED_FIELD = {
  CUT: ["edge", (r) => Array.isArray(r.edge) && r.edge.length === 2], //          the seam a released BAdI/RAP-extension replaces
  COGEN_RAP_BO: ["members", (r) => Array.isArray(r.members) && r.members.length > 0], // dissolve the cycle into one BO
  SPROUT_DEFER: ["member", (r) => typeof r.member === "string" && r.member.length > 0], // new tested unit; legacy deferred
};

/**
 * Record a human-approved resolution into the seam memory (copy-on-write). Re-confirming
 * the same cycle raises the stored confidence toward — never to — certainty.
 * @returns {{learned: Record<string, object>}} the new memory
 */
export function applyResolution(memory, sigs, resolution, { ts }) {
  const spec = REQUIRED_FIELD[resolution?.kind];
  if (!spec) throw new Error(`cycle-gate: unknown resolution kind '${resolution?.kind}' — CUT | COGEN_RAP_BO | SPROUT_DEFER`);
  if (!spec[1](resolution)) throw new Error(`cycle-gate: resolution '${resolution.kind}' needs a valid '${spec[0]}' field`);
  const key = memberSigSetKey(sigs);
  const prior = memory.learned?.[key];
  const confidence = prior ? Math.min(CONFIDENCE_CAP, Math.round((prior.confidence + CONFIDENCE_STEP) * 100) / 100) : FIRST_CONFIDENCE;
  return {
    ...memory,
    learned: { ...(memory.learned ?? {}), [key]: { resolution: structuredClone(resolution), confidence, resolved_at: ts } },
  };
}
