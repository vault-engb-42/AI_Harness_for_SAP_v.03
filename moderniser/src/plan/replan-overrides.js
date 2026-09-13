/**
 * The operator's disposition OVERRIDES, read back out of the audited escalations register (P3, S-a).
 * PURE over (register, run_id) — the read seam that makes `decide <esc> override:<disposition>` mean
 * something. Until this existed the decision was parsed, allowlisted and durably recorded, then read by
 * nobody: the frozen node kept its classified disposition, so a human who said "retire this" watched the
 * driver build it anyway (assemble.js:101 already promised a REPLAN + re-freeze).
 *
 * Scoping is deliberate and fail-closed on all three axes:
 *   - KIND — only the two gates whose decision IS a disposition. DISPOSITION_REVIEW is the classifier's
 *     recommendation being reviewed; NO_TARGET_SHAPE (S14) is an arch-gated object no target shape fits,
 *     whose ONLY remedy is to re-disposition it — the escalation exists precisely so that decision can be
 *     made, and reading only the first kind would leave it recorded and applied by nobody, which is the
 *     failure this whole file was built to close. Both are parsed by `parseDispositionDecision`, so both
 *     carry the same `{verb: "override", disposition}` shape. No OTHER gate's decision is a disposition:
 *     ARCH_REVIEW ratifies a contract and DROPPED_DEPENDENCY accepts a consequence.
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
 * The gates whose `override:<disposition>` decision re-dispositions a node (see the KIND axis above). Both
 * raise one row per node, so a node gated by both has two rows and `latestEvent` picks the human's LAST word
 * across both — which is the right rule: they are two ways of asking the same question about the same object.
 */
const DISPOSITION_DECIDING_KINDS = new Set(["DISPOSITION_REVIEW", "NO_TARGET_SHAPE"]);

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
    if (!DISPOSITION_DECIDING_KINDS.has(e.kind) || e.status !== "RESOLVED" || e.run_id !== runId) continue;
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

/**
 * The overrides a human RECORDED and a later decision DISCARDED — the other half of the same read.
 *
 * Found in the first real GAP 5 run (2026-09-13, abap_fico): six objects were decided `override:refactor`
 * at the NO_TARGET_SHAPE gate and then `approve` at DISPOSITION_REVIEW for the same nodes. The
 * temporally-final rule above is correct and deliberate — a later approve means "they changed their mind
 * back" — but all six overrides died and `replan` reported `changed: []`, a clean diff. The operator was
 * never told that six of their decisions had been thrown away.
 *
 * The ordering that causes it is now the NATURAL one: GAP 6 made blocking gates sort FIRST, so any batch
 * walking the surfaced list records overrides before approvals, and the ratified surfacing plan (batch the
 * gate-1 prompts, decide the unplaceable ones individually) produces exactly that batch.
 *
 * REPORTING, not refusing. The precedence stays untouched — changing which decision wins would break a
 * ratified rule to fix a silence. What changes is that the silence ends: `replan` can now say which
 * decisions it discarded and which gate took them, so a human sees the loss instead of an empty diff.
 *
 * @returns {Array<{sig: string, disposition: string, decided_by: string, decided_at: string,
 *                  superseded_by: string, superseded_at: string}>} sorted by sig
 */
export function supersededOverrides(register, runId) {
  if (typeof runId !== "string" || runId === "") {
    throw new Error("replan-overrides: a run_id is required — an unscoped read would report another run's decisions");
  }
  const bySig = new Map();
  for (const e of register?.escalations ?? []) {
    if (!DISPOSITION_DECIDING_KINDS.has(e.kind) || e.status !== "RESOLVED" || e.run_id !== runId) continue;
    for (const sig of e.node_ids ?? []) {
      if (!bySig.has(sig)) bySig.set(sig, []);
      bySig.get(sig).push(e);
    }
  }
  const lost = [];
  for (const [sig, rows] of bySig) {
    const final = latestEvent(rows);
    if (final?.decision?.verb === "override") continue; // it stands — do not cry wolf
    // Every override this node carried that the final word displaced. Reported per DECISION, not per node:
    // a human who overrode twice and then approved discarded two decisions, and both are theirs to see.
    for (const r of rows) {
      if (r === final || r.decision?.verb !== "override") continue;
      lost.push({
        sig,
        disposition: r.decision.disposition,
        decided_by: r.resolved_by,
        decided_at: r.resolved_at,
        superseded_by: final?.kind ?? "(unknown)",
        superseded_at: final?.resolved_at ?? null,
      });
    }
  }
  return lost.sort((a, b) => (a.sig < b.sig ? -1 : a.sig > b.sig ? 1 : 0));
}
