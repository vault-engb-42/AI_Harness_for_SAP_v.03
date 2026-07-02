/**
 * Maps an abaplint object type (as returned by `IObject.getType()`) to the
 * analyser-findings schema's CPG `NodeKind` enum. Unmapped types return null
 * so the caller skips them rather than inventing a kind the schema forbids.
 *
 * @typedef {"class"|"method"|"function"|"report"|"cds"|"behavior"|"table"|"form"|"interface"} NodeKind
 */

/** @type {Record<string, NodeKind>} */
const OBJECT_TYPE_TO_NODE = {
  CLAS: "class",
  INTF: "interface",
  PROG: "report",
  FUGR: "function",
  FUNC: "function",
  DDLS: "cds",
  TABL: "table",
  BDEF: "behavior",
};

/**
 * @param {string|undefined} objectType abaplint object type (e.g. "CLAS")
 * @returns {NodeKind|null}
 */
export function nodeKindForObjectType(objectType) {
  if (typeof objectType !== "string" || objectType === "") {
    return null;
  }
  return OBJECT_TYPE_TO_NODE[objectType.toUpperCase()] ?? null;
}
