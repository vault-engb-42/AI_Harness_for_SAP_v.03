/**
 * RAP behavior-definition edge extraction.
 *
 * abaplint parses BDEF objects as opaque (getType/getDescription only), so the
 * behavior's structural dependencies are recovered with a lightweight scan of
 * the raw `.asbdef` source for the two core relationships:
 *   - `define behavior for <ENTITY>`     -> consumes-cds (behavior augments the CDS entity)
 *   - `... implementation in class <CLS>` -> calls (framework dispatches to the handler pool class)
 *
 * Determinations / validations / actions are a deeper RAP concern left for a
 * later refinement; entity + handler are the load-bearing dependencies.
 *
 * Descriptors match statement-edges.js: `{ kind, target, targetKind, evidence }`.
 */

const BEHAVIOR_FOR = /define\s+behavior\s+for\s+([A-Za-z0-9_/]+)/gi;
const IMPL_IN_CLASS = /implementation\s+in\s+class\s+([A-Za-z0-9_/]+)/gi;

/**
 * @param {import("@abaplint/core").IObject} obj a BDEF object
 * @returns {import("./statement-edges.js").EdgeDescriptor[]}
 */
export function collectRapEdges(obj) {
  if (obj.getType?.() !== "BDEF") return [];
  const file = obj.getFiles?.()[0];
  const raw = file?.getRaw?.();
  if (!raw) return [];
  const evidence = file.getFilename?.() ?? obj.getName();

  const edges = [];
  for (const m of raw.matchAll(BEHAVIOR_FOR)) {
    edges.push({ kind: "consumes-cds", target: m[1].toUpperCase(), targetKind: null, evidence });
  }
  for (const m of raw.matchAll(IMPL_IN_CLASS)) {
    edges.push({ kind: "calls", target: m[1].toUpperCase(), targetKind: "class", evidence });
  }
  return edges;
}
