/**
 * Object-level graph build (MODERNISER_DESIGN §6.2 / §3.1). The analyser CPG
 * (`graph.nodes`/`graph.edges`) is method/form/statement-level; the scheduler operates on
 * OBJECTS (a "node" is a CPG object; a RAP artifact-set is one super-node, L1). Collapse
 * each node into its owning `object`, drop intra-object (self-loop) edges, and dedupe.
 *
 * Mirrors the analyser's `html-graph.js` objectLevelGraph, with two differences the
 * scheduler needs: it PRESERVES edge kinds (SCOPE derives program pools from `includes` and
 * blast/DDIC from `uses-table`, not just a dependency count), and it includes EVERY object
 * (nodes + edge endpoints), not only edge-connected ones.
 *
 * Edge direction is the analyser's native convention: `source → target` means source
 * uses/depends-on target. The SCHEDULER consumes the reversed PRECEDENCE orientation via
 * `precedenceEdges()` below (ratified 2026-07-11): in-degree then counts unmet dependencies,
 * so leaves schedule first and the entry report lands in the LAST wave — the same direction
 * as the analyser's bottom-up `modernization_plan.wave` and `topoWaves` (its
 * moderniser-annotated SCC primitive; the entry-first `computeLayers` is the Graph tab's
 * VISUAL convention only). scope.js keeps native edges (pool/blast derivation walks uses-edges).
 *
 * Pure. Deterministic (nodes + edges sorted).
 *
 * @param {{graph?: {nodes?: Array<{id: string, object: string, kind?: string, namespace?: string, rank?: number|string}>, edges?: Array<{source: string, target: string, kind?: string}>}}} doc analyser-findings.json
 * @returns {{nodes: Array<{id: string, kind: string, namespace: string, rank: number}>, edges: Array<{source: string, target: string, kind: string}>}}
 */
export function buildObjectGraph(doc) {
  const nodes = doc.graph?.nodes ?? [];
  const edgesIn = doc.graph?.edges ?? [];
  const objOf = new Map(nodes.map((n) => [n.id, n.object]));

  const attrs = new Map(); // object -> {kind, namespace, rank}
  const note = (object, kind, namespace, rank, isOwn) => {
    if (!attrs.has(object)) attrs.set(object, { kind: kind ?? "unknown", namespace: namespace ?? "unknown", rank: 0 });
    const a = attrs.get(object);
    a.rank = Math.max(a.rank, num(rank));
    if (isOwn) {
      a.kind = kind ?? a.kind; // the object's own top node (id === object) is authoritative for kind/ns
      a.namespace = namespace ?? a.namespace;
    }
  };
  // sorted by id → for an object with no id===object node, the min-by-id sub-node's attrs
  // win deterministically (an own node always overrides via isOwn).
  for (const n of [...nodes].sort((a, b) => cmp(a.id, b.id))) note(n.object, n.kind, n.namespace, n.rank, n.id === n.object);

  const seen = new Set();
  const edges = [];
  for (const e of edgesIn) {
    const s = objOf.get(e.source) ?? e.source;
    const t = objOf.get(e.target) ?? e.target;
    if (s === t) continue; // intra-object edge
    if (!attrs.has(s)) note(s, undefined, undefined, 0, false); // edge endpoint with no node of its own
    if (!attrs.has(t)) note(t, undefined, undefined, 0, false);
    const key = JSON.stringify([s, t, e.kind]);
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ source: s, target: t, kind: e.kind });
  }

  const nodeList = [...attrs.keys()].sort().map((id) => ({ id, ...attrs.get(id) }));
  edges.sort((a, b) => cmp(a.source, b.source) || cmp(a.target, b.target) || cmp(a.kind, b.kind));
  return { nodes: nodeList, edges };
}

/**
 * Scheduler orientation (ratified 2026-07-11): PRECEDENCE edges run dependency → dependent —
 * the REVERSE of the CPG's native `source → target` (= source uses target). Kahn in-degree
 * then counts unmet dependencies: an in-degree-0 root has nothing left to wait for, leaves
 * schedule first, and the entry object lands in the last wave. A caller is therefore always
 * rewritten against an already-modernised, ACTIVATED callee interface (§3.1 closure_green,
 * L2) — the reason top-down was rejected: a dependent gated GREEN against unmodernised
 * dependencies is re-opened when those dependencies' interfaces change.
 *
 * @param {Array<{source: string, target: string}>} edges native CPG or object-graph edges
 * @returns {Array<[string, string]>} [dependency, dependent] pairs for condense/levels/frontier
 */
export function precedenceEdges(edges) {
  return edges.map((e) => [e.target, e.source]);
}

const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
