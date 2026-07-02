/**
 * Maps abaplint `ReferenceType` value strings (as emitted on a resolved
 * reference's `.referenceType`) to the analyser-findings schema's CPG
 * `EdgeKind` enum. Only relationships that belong in the dependency graph
 * are mapped; type/definition/builtin bookkeeping references return null.
 *
 * The remaining EdgeKinds in the schema — call-function, get-badi,
 * authority-check, inherits, consumes-cds, includes — are NOT derivable
 * from the spaghetti reference stream; they come from statement-level and
 * DDIC extraction (the C1 gap-fillers). This map covers only what the
 * SyntaxLogic reference walk yields.
 *
 * @typedef {"calls"|"call-function"|"call-method"|"get-badi"|"uses-table"|"authority-check"|"inherits"|"consumes-cds"|"includes"|"data-flow-def"|"data-flow-use"} EdgeKind
 */

/** @type {Record<string, EdgeKind>} */
const REFERENCE_TYPE_TO_EDGE = {
  Method: "call-method",
  Form: "calls",
  Table: "uses-table",
  "Table (Void)": "uses-table",
  "Read From": "data-flow-use",
  "Write To": "data-flow-def",
};

/**
 * @param {string|undefined} referenceType abaplint ReferenceType value string
 * @returns {EdgeKind|null} the CPG edge kind, or null if not a graph edge
 */
export function edgeKindForReference(referenceType) {
  if (typeof referenceType !== "string") {
    return null;
  }
  return REFERENCE_TYPE_TO_EDGE[referenceType] ?? null;
}
