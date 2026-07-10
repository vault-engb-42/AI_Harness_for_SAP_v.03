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
 * uses/depends-on target. The scheduler treats an in-degree-0 object as a root (§3.1 Stage 3,
 * top-down: "never a fan-in 'foundational' override"), so the entry report — which nothing
 * depends on — lands at level 0. NB this is the OPPOSITE order to the analyser's bottom-up
 * `modernization_plan.wave`; the scheduler re-derives its own level and does not use `wave`.
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
  for (const n of nodes) note(n.object, n.kind, n.namespace, n.rank, n.id === n.object);

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

const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
