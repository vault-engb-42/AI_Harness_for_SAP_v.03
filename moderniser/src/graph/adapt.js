/**
 * Stage-1 seam ADAPTER (MODERNISER_DESIGN §3.1; operator-ratified 2026-07-13 — D5, closes
 * review F9 + F12): collapses `overApproximateEdges`' NODE-level output into the OBJECT-level
 * `opts.augment` shape `{edges, seals}` that `assemblePlan` consumes. Without this collapse
 * the two id spaces never meet — node-keyed seals and raw target tokens silently no-op
 * through condense (under-approximation, the direction L5 forbids).
 *
 * Token normalisation into object-id space:
 *   - `ZCL_X=>METH` (class-method handler)  → owning class `ZCL_X`
 *   - `OBJ.MEMBER` (dot-qualified)          → owning object `OBJ`
 *   - bare form name                         → resolved against the EMITTING object's own
 *     member set (program-local late call → intra-object, no object edge)
 *   - anything unresolvable / unknown object → `dynamic_seal` the SOURCE object instead of
 *     emitting a dangling edge (L5: fail toward "human decides", never a silent drop)
 *
 * Pure. Deterministic (edges deduped + sorted). The source-extraction step that POPULATES
 * `sources` (offline corpus / ADT get_source) remains the recorded §3.1 residual — this
 * module closes the CONTRACT so a wired extractor cannot silently no-op.
 *
 * @param {{graph?: {nodes?: Array<{id: string, object?: string, source?: string}>}}} doc analyser-findings doc (read-only, P8)
 * @param {Record<string, string>} [sources] node-id (or object-id) → ABAP source
 * @returns {{edges: Array<{source: string, target: string, kind: string, synthetic: true}>, seals: Record<string, true>}}
 */
import { overApproximateEdges } from "./augment.js";

export function augmentFromCpg(doc, sources = {}) {
  const cpgNodes = doc.graph?.nodes ?? [];
  const objectOf = (n) => String(n.object ?? String(n.id).split(".")[0]).toUpperCase();
  const membersOf = new Map(); // OBJ → Set<MEMBER> for bare-form resolution
  for (const n of cpgNodes) {
    const obj = objectOf(n);
    if (!membersOf.has(obj)) membersOf.set(obj, new Set());
    const id = String(n.id).toUpperCase();
    if (id.startsWith(`${obj}.`)) membersOf.get(obj).add(id.slice(obj.length + 1));
  }

  const withSources = cpgNodes.map((n) => ({ ...n, source: sources[n.id] ?? sources[objectOf(n)] ?? n.source }));
  const scanned = overApproximateEdges({ nodes: withSources, edges: [] });
  const objectByNodeId = new Map(cpgNodes.map((n) => [n.id, objectOf(n)]));

  const seals = {};
  for (const n of scanned.nodes) if (n.dynamic_seal) seals[objectByNodeId.get(n.id)] = true;

  const edgeSet = new Map();
  for (const e of scanned.edges) {
    if (e.synthetic !== true) continue;
    const srcObj = objectByNodeId.get(e.source);
    const t = e.target; // upper-cased by augment
    let targetObj = null;
    if (t.includes("=>")) targetObj = t.split("=>")[0];
    else if (t.includes(".")) targetObj = t.split(".")[0];
    else if (membersOf.get(srcObj)?.has(t)) targetObj = srcObj; // program-local form
    if (targetObj === null || !membersOf.has(targetObj)) {
      seals[srcObj] = true; // unresolvable → seal the source, never a dangling edge (L5)
      continue;
    }
    if (targetObj === srcObj) continue; // intra-object: no object-level dependency
    edgeSet.set(JSON.stringify([srcObj, targetObj, e.kind]), { source: srcObj, target: targetObj, kind: e.kind, synthetic: true });
  }
  const edges = [...edgeSet.values()].sort((a, b) =>
    a.source !== b.source ? cmp(a.source, b.source) : a.target !== b.target ? cmp(a.target, b.target) : cmp(a.kind, b.kind),
  );
  return { edges, seals };
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
