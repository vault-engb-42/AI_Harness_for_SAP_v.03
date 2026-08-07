/**
 * The DROPPED-FEATURES ledger (BUILD_PLAN B4) — the proof-bundle artifact for everything this run removed
 * from the in-stack estate: objects RETIRED outright, and objects handed off side-by-side at
 * REBUILT_HANDOFF. Both terminals complete a run with NO verdict behind them — nothing is generated, so the
 * ATC/ABAP-Unit ratchet never runs — which makes this the only place a human reading the evidence can learn
 * that an object went away, on whose authority, and on what basis.
 *
 * DERIVED, never a second source of truth. `state.disposition_register` already holds the audited sign-off
 * (assertDispositionTerminal refuses the terminal without a named human and a justification), and the FROZEN
 * plan node holds P1's registry-grounded evidence. This joins them, so the reader does not have to correlate
 * two artifacts to answer one question — and so the ledger can never drift from either, because it is
 * recomputed rather than accumulated.
 *
 * It exists because the /modernise retire step instructed the fulfiller to "record the drop in the run's
 * dropped-features ledger with the grounded no-released-successor basis" while no verb, file or function
 * could record it. An instruction the lane cannot perform is exactly the inert-mechanism defect this arc has
 * shipped three times.
 *
 * Pure + deterministic (rows sorted by sig).
 */
import { DISPOSITION_TERMINALS } from "../sched/terminals.js";

/**
 * @param {{plan_hash: string, nodes: Array<object>}} plan the frozen plan
 * @param {{disposition_register?: Array<{sig: string, status: string, reason?: string, signed_by: string, justification: string}>}} state run state
 * @param {{run_id: string}} opts
 * @returns {{run_id: string, plan_hash: string, rows: object[]}}
 */
export function buildDroppedFeatures(plan, state, { run_id }) {
  const bySig = new Map(plan.nodes.map((n) => [n.id, n]));
  const rows = [...(state.disposition_register ?? [])]
    .map((entry) => {
      const node = bySig.get(entry.sig);
      // Fail closed on the WHOLE row, not just its sig. The register is durable run state and this builds
      // the evidence a human reads, so every field the reader will trust is re-checked here — a row is
      // written only by applyOutcome behind assertDispositionTerminal, so anything failing these checks did
      // not come from that path.
      if (!node) throw new Error(`dropped-features: '${entry.sig}' is in the disposition register but is not a plan node of this run`);
      const required = DISPOSITION_TERMINALS.get(entry.status);
      if (!required) throw new Error(`dropped-features: '${entry.sig}' has status '${entry.status}', which is not a disposition terminal`);
      if (node.disposition !== required) {
        throw new Error(`dropped-features: '${entry.sig}' is recorded ${entry.status} but its frozen disposition is '${node.disposition}' — only a '${required}' node reaches that terminal`);
      }
      for (const field of ["signed_by", "justification"]) {
        if (typeof entry[field] !== "string" || entry[field] === "") {
          throw new Error(`dropped-features: '${entry.sig}' has no ${field} — these terminals complete a run with no verdict, so the ledger must never report one unsigned`);
        }
      }
      return {
        sig: entry.sig,
        object: node.object,
        status: entry.status,
        disposition: node.disposition,
        reason: entry.reason,
        signed_by: entry.signed_by,
        justification: entry.justification,
        // Provenance of the DECISION (was this a human's call or the classifier's?) beside the sign-off for
        // the ACT. For a retire they are both human today, but the ledger must not assume that.
        decided_by: node.disposition_decided_by ?? null,
        disposition_source: node.disposition_source ?? null,
        // The grounded basis, reported even when EMPTY: a drop resting on the operator's judgement rather
        // than on a registry fact is a legitimate outcome, and the evidence pack should say so plainly
        // rather than leave a reader to infer it from a missing field.
        grounded_basis: {
          no_successor_refs: [...(node.disposition_evidence?.no_successor_refs ?? [])],
          standard_domains: [...(node.disposition_evidence?.standard_domains ?? [])],
        },
      };
    })
    .sort((a, b) => (a.sig < b.sig ? -1 : a.sig > b.sig ? 1 : 0));

  return { run_id, plan_hash: plan.plan_hash, rows };
}
