/**
 * The CONFLICT graph (MODERNISER_DESIGN §3.1 Stage 4, L4). Reference-edge independence is
 * insufficient for parallel modernisation: two nodes ALSO conflict — even with no directed
 * code edge between them — if they share a mutable substrate that cannot be half-activated:
 *   - a program pool / function-group (co-tenants recompile as one unit)   → `pool:<x>`
 *   - a DDIC object or its base (append / include)                         → `ddic:<x>`
 *   - a lock object                                                        → `lock:<x>`
 *   - a number-range object                                               → `nr:<x>`
 *   - a transport request                                                  → `tr:<x>`
 * ("or its base" is resolved by SCOPE when it populates `node.ddic` — the base table is
 * listed alongside the append, so appender and base-user land in the same bucket here.)
 *
 * Returns: `adjacency` — DIRECT conflict neighbours, the set frontier tests for both-graph
 * independence (§3.1 Stage 5); `groups` — TRANSITIVE connected components of size ≥2, the
 * co-tenant clusters that must move together (the per-transport activate mutex, L4; their
 * expand→contract ordering is applied later by the migration-safety step, not here);
 * `reasons` — the shared resource key(s) per edge, for the human gate.
 *
 * Pure. Resource metadata is injected (absent on the raw analyser CPG → empty graph).
 * Deterministic: every returned collection is canonically sorted, so JSON is byte-stable
 * regardless of node input order. Union-find is near-linear; direct edges are materialised
 * as per-bucket cliques (real function groups are small — a pathological mega-pool would be
 * O(k²) and should instead be represented by its group, noted for a future scale guard).
 *
 * @param {Array<{id: string, program_pool?: string, function_group?: string, ddic?: string[], locks?: string[], number_ranges?: string[], transport?: string}>} nodes
 * @returns {{edges: Array<[string, string]>, adjacency: Record<string, string[]>, groups: string[][], reasons: Record<string, string[]>}}
 */
export function buildConflictGraph(nodes) {
  const ids = [...new Set(nodes.map((n) => n.id))].sort();
  const buckets = new Map(); // resourceKey -> Set(nodeId)
  for (const n of nodes) {
    for (const k of resourceKeys(n)) {
      if (!buckets.has(k)) buckets.set(k, new Set());
      buckets.get(k).add(n.id);
    }
  }

  const uf = new UnionFind(ids);
  const shared = new Map(); // edgeKey "[a,b]" -> Set(resourceKey)
  for (const [k, memberSet] of buckets) {
    const members = [...memberSet].sort();
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        const a = members[i];
        const b = members[j];
        uf.union(a, b);
        const key = JSON.stringify([a, b]);
        if (!shared.has(key)) shared.set(key, new Set());
        shared.get(key).add(k);
      }
    }
  }

  const edges = [...shared.keys()].map((e) => JSON.parse(e)).sort(cmpEdge);
  const reasons = {};
  const adjacency = Object.fromEntries(ids.map((id) => [id, []]));
  for (const [a, b] of edges) {
    reasons[JSON.stringify([a, b])] = [...shared.get(JSON.stringify([a, b]))].sort();
    adjacency[a].push(b);
    adjacency[b].push(a);
  }
  for (const id of ids) adjacency[id].sort();

  return { edges, adjacency, groups: components(uf, ids), reasons };
}

/** Normalise a node's shared-resource references into namespaced, deduped, sorted keys. */
function resourceKeys(node) {
  const ks = new Set();
  if (node.program_pool) ks.add(`pool:${node.program_pool}`);
  if (node.function_group) ks.add(`pool:${node.function_group}`); // a function group IS a program pool
  for (const d of node.ddic || []) ks.add(`ddic:${d}`);
  for (const l of node.locks || []) ks.add(`lock:${l}`);
  for (const r of node.number_ranges || []) ks.add(`nr:${r}`);
  if (node.transport) ks.add(`tr:${node.transport}`);
  return [...ks].sort();
}

/** Connected components of size ≥2 (the co-tenant clusters), each sorted, groups sorted. */
function components(uf, ids) {
  const byRoot = new Map();
  for (const id of ids) {
    const r = uf.find(id);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(id);
  }
  return [...byRoot.values()].filter((g) => g.length > 1).map((g) => [...g].sort()).sort((x, y) => cmp(x[0], y[0]));
}

/** Union-find with iterative path compression; the smaller id is always the root (determinism). */
class UnionFind {
  constructor(ids) {
    this.parent = new Map(ids.map((id) => [id, id]));
  }

  find(x) {
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    let cur = x;
    while (this.parent.get(cur) !== cur) {
      const nxt = this.parent.get(cur);
      this.parent.set(cur, root);
      cur = nxt;
    }
    return root;
  }

  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    this.parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const cmpEdge = (x, y) => (x[0] !== y[0] ? cmp(x[0], y[0]) : cmp(x[1], y[1]));
