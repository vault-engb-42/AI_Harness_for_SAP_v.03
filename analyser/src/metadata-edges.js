/**
 * Metadata edge extraction — CPG relationships read from abaplint's parsed
 * object metadata rather than the statement/reference stream:
 *   - inherits    : class superclass + implemented interfaces
 *   - consumes-cds : CDS view FROM/JOIN sources + associations
 *
 * Descriptors match statement-edges.js: `{ kind, target, targetKind, evidence }`.
 * Attribution is object-level (caller sets source = object name).
 */

/**
 * @param {import("@abaplint/core").IObject} obj a class (CLAS) object
 * @returns {import("./statement-edges.js").EdgeDescriptor[]}
 */
export function collectInheritEdges(obj) {
  const def = obj.getClassDefinition?.();
  if (!def) return [];
  const evidence = obj.getName();
  const edges = [];
  if (def.superClassName) {
    edges.push({
      kind: "inherits",
      target: def.superClassName.toUpperCase(),
      targetKind: "class",
      evidence,
    });
  }
  for (const intf of def.interfaces ?? []) {
    if (intf?.name) {
      edges.push({
        kind: "inherits",
        target: intf.name.toUpperCase(),
        targetKind: "interface",
        evidence,
      });
    }
  }
  return edges;
}

/**
 * @param {import("@abaplint/core").IObject} obj a CDS DDL source (DDLS) object
 * @returns {import("./statement-edges.js").EdgeDescriptor[]}
 */
export function collectCdsEdges(obj) {
  const pd = obj.getParsedData?.();
  if (!pd) return [];
  const evidence = obj.getName();
  const edges = [];
  // sources = FROM/JOIN entities; associations = declared associations.
  // Both are edge-only: table-vs-view disambiguation is left to the target's
  // own node (if present in the bundle), not guessed here.
  for (const s of pd.sources ?? []) {
    if (s?.name) {
      edges.push({ kind: "consumes-cds", target: s.name.toUpperCase(), targetKind: null, evidence });
    }
  }
  for (const a of pd.associations ?? []) {
    if (a?.name) {
      edges.push({ kind: "consumes-cds", target: a.name.toUpperCase(), targetKind: null, evidence });
    }
  }
  return edges;
}
