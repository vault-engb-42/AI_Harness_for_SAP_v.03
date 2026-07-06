/**
 * Namespace classification for ABAP object names.
 * Maps an object name to the analyser-findings schema's `namespace` enum:
 *   Z | Y | registered | sap
 *
 * - Z / Y prefix     -> customer objects
 * - /NS/ slash form  -> registered vendor namespace (e.g. /ABC/CL_FOO)
 * - anything else    -> SAP standard
 * Nullish / blank names default to `sap` (conservative: never treat an
 * unknown object as customer-owned).
 */

/** @typedef {"Z"|"Y"|"registered"|"sap"} Namespace */

/**
 * @param {string|null|undefined} name
 * @returns {Namespace}
 */
export function classifyNamespace(name) {
  if (typeof name !== "string" || name.trim() === "") {
    return "sap";
  }
  const n = name.trim().toUpperCase();
  if (n.startsWith("/")) {
    return "registered";
  }
  if (n.startsWith("Z")) {
    return "Z";
  }
  if (n.startsWith("Y")) {
    return "Y";
  }
  return "sap";
}
