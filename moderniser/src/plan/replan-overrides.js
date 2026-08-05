/**
 * The operator's disposition OVERRIDES, read back out of the audited escalations register (P3, S-a).
 * PURE over (register, run_id) — the read seam that makes `decide <esc> override:<disposition>` mean
 * something. Until this existed the decision was parsed, allowlisted and durably recorded, then read by
 * nobody: the frozen node kept its classified disposition, so a human who said "retire this" watched the
 * driver build it anyway (assemble.js:101 already promised a REPLAN + re-freeze).
 *
 * Scoping is deliberate and fail-closed on all three axes:
 *   - KIND — only DISPOSITION_REVIEW rows; no other gate's decision is a disposition.
 *   - RUN — escalations.json is a SHARED cross-run register, so an unscoped read would let a decision
 *     made against a discarded run silently re-plan this one.
 *   - STATUS — only RESOLVED rows reach the temporally-final reducer. This is the one place the plan-time
 *     gate deliberately DIVERGES from the artifact-time attestation join (cli-attest.js), which feeds the
 *     reducer every row so that a re-raise voids a prior attestation. At plan time there is no artifact to
 *     re-bless, and `disposition` is an idempotent deterministic view of the frozen plan — a re-raise
 *     therefore carries no new information, and letting it void the override would let an innocuous re-run
 *     erase the human's decision and rebuild exactly what they told the harness to drop.
 *
 * The override is NOT applied here — this seam only reports what the human decided. Applying it is
 * `assemblePlan(doc, {dispositionOverrides})`, which re-freezes under a NEW plan_hash (L6 REPLAN gate); a
 * frozen node is never mutated and no disposition override is ever stored at state level, which would put
 * state and plan into the disagreement the ratchet exists to forbid.
 */
import { latestEvent } from "../exception/escalation-bus.js";
import { DISPOSITIONS, isDisposition } from "./disposition-enum.js";

/**
 * @param {{escalations: object[]}} register the §3.4 #6 escalations register
 * @param {string} runId the run whose decisions govern
 * @returns {Record<string, {disposition: string, decided_by: string, decided_at: string}>} sig → the human's final override
 */
export function collectOverrides(register, runId) {
  if (typeof runId !== "string" || runId === "") {
    throw new Error("replan-overrides: a run_id is required — an unscoped collect would import another run's decisions");
  }
  const bySig = new Map();
  for (const e of register?.escalations ?? []) {
    if (e.kind !== "DISPOSITION_REVIEW" || e.status !== "RESOLVED" || e.run_id !== runId) continue;
    for (const sig of e.node_ids ?? []) {
      if (!bySig.has(sig)) bySig.set(sig, []);
      bySig.get(sig).push(e);
    }
  }
  const out = {};
  for (const [sig, rows] of bySig) {
    // The human's temporally FINAL decision governs — a later `approve` supersedes an earlier override
    // (they changed their mind back), and a later override supersedes an earlier one.
    const final = latestEvent(rows);
    if (final?.decision?.verb !== "override") continue;
    const disposition = final.decision.disposition;
    // Allowlisted at write time (disposition-gate.js), re-checked here: the register is durable and
    // hand-editable, and this value becomes a FROZEN plan node the driver routes on.
    if (!isDisposition(disposition)) {
      throw new Error(`replan-overrides: '${sig}' overridden to '${disposition}', which is not a disposition [${DISPOSITIONS}]`);
    }
    out[sig] = { disposition, decided_by: final.resolved_by, decided_at: final.resolved_at };
  }
  return out;
}
