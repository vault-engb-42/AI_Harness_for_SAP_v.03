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
 * Returns a LINEAR representation (no O(k²) clique — a package where hundreds of objects
 * read a standard base table like BSEG would otherwise explode one bucket into millions of
 * edges):
 *   - `keysOf`  — per-node sorted resource keys. Frontier tests DIRECT conflict (§3.1 Stage
 *                 5) by intersecting a candidate's keys with the keys of already-chosen
 *                 nodes; direct sharing, NOT transitive group membership, so two nodes in
 *                 one cluster that share nothing directly may still co-generate.
 *   - `buckets` — node ids per shared resource key (observability + the collapse input).
 *   - `groups`  — TRANSITIVE connected components of size ≥2: the co-tenant clusters that
 *                 must move together. Plan-freeze collapses each into one ordered
 *                 (expand→contract) scheduling super-node (L4) and the per-transport
 *                 activate mutex serialises them; the ordering is applied by the
 *                 migration-safety step, not here.
 *
 * Pure. Resource metadata is injected (absent on the raw analyser CPG → empty graph).
 * Near-linear (union-find + star-union per bucket). Deterministic: every returned
 * collection is canonically sorted, so JSON is byte-stable regardless of node input order.
 *
 * @param {Array<{id: string, program_pool?: string, function_group?: string, ddic?: string[], locks?: string[], number_ranges?: string[], transport?: string}>} nodes
 * @returns {{keysOf: Record<string, string[]>, buckets: Record<string, string[]>, groups: string[][]}}
 */
export function buildConflictGraph(nodes) {
  const ids = [...new Set(nodes.map((n) => n.id))].sort();
  const keyMap = new Map(); // id -> sorted resource keys
  const bucketMap = new Map(); // resourceKey -> Set(nodeId)
  for (const n of nodes) {
    const ks = resourceKeys(n);
    keyMap.set(n.id, ks);
    for (const k of ks) {
      if (!bucketMap.has(k)) bucketMap.set(k, new Set());
      bucketMap.get(k).add(n.id);
    }
  }

  const uf = new UnionFind(ids);
  for (const memberSet of bucketMap.values()) {
    const members = [...memberSet];
    for (let i = 1; i < members.length; i += 1) uf.union(members[0], members[i]); // star-union: O(k), same component
  }

  const keysOf = {};
  for (const id of ids) keysOf[id] = keyMap.get(id) || [];
  const buckets = {};
  for (const k of [...bucketMap.keys()].sort()) buckets[k] = [...bucketMap.get(k)].sort();

  return { keysOf, buckets, groups: components(uf, ids) };
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
