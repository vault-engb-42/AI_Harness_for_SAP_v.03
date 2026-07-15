/**
 * gap-2a — the analyser-rule SELF_CHECK gate (offline).
 *
 * Offline SELF_CHECK lints a generated artifact with the greenfield 58-rule linter, which
 * carries syntax + Clean-Core checks but NONE of the analyser's structural RAP-modelling /
 * N+1 rules. So a `MODIFY ENTITIES … in a loop / in a read handler / without a guard` and a
 * `SELECT … in a loop` pass the offline lint untouched. This gate runs the analyser (as a
 * library — `analyzePackage`) over the node's generated artifacts and BLOCKS on those rule_ids,
 * treated like a lint error: no SYNTAX_OK, regenerate at the SYNTAX_OK→GENERATED retry edge,
 * and at the cycle ceiling → BLOCK SYNTAX_CEILING.
 *
 * All four rules are analyser-PRECISE (verified on real generated RAP artifacts, 2026-07-15):
 * `talos-rap-modify-in-loop` and `talos-select-in-loop` fire only on genuine defects;
 * `talos-rap-modify-no-guard` and `talos-rap-modify-entities-in-read-handler` were made precise
 * by an analyser fix (constructor-driver skip so an inline `WITH VALUE #()` is not mis-flagged;
 * read-handler moved to a method-scoped statement rule so it fires only inside a FOR READ
 * handler, not any behaviour pool) after an earlier version false-blocked valid RAP. Proven on
 * the abap_fico demo: the gate blocks its 3 genuine residuals with zero false positives.
 *
 * Gated on the rule's STRUCTURAL `severity`, never the oracle-routed `atc_priority` (which a
 * downgrade can move): a structural RAP/N+1 defect is a defect regardless of the referenced
 * name's grade.
 *
 * Pure. No I/O — the caller (the `lint-rules` CLI verb) owns running `analyzePackage`.
 */

export const GAP2A_RULE_IDS = Object.freeze([
  "talos-rap-modify-in-loop",
  "talos-rap-modify-no-guard",
  "talos-rap-modify-entities-in-read-handler",
  "talos-select-in-loop",
]);

const TARGET = new Set(GAP2A_RULE_IDS);

/**
 * @param {{findings?: Array<{rule_id?: string, severity?: string, file?: string, line?: number, message?: string}>}} doc
 *   an `analyzePackage` output document (only `findings` is read).
 * @returns {{blocked: boolean, hits: Array<{rule_id: string, file?: string, line?: number, message?: string}>}}
 */
export function ruleGate(doc) {
  const hits = (doc?.findings ?? [])
    .filter((f) => f.severity === "priority-1" && TARGET.has(f.rule_id))
    .map((f) => ({ rule_id: f.rule_id, file: f.file, line: f.line, message: f.message }));
  return { blocked: hits.length > 0, hits };
}
