/**
 * Tarjan strongly-connected-components, condensed into a guaranteed DAG
 * (MODERNISER_DESIGN §3.1 Stage 2, L5). Each SCC becomes ONE super-node; a
 * multi-member SCC is a cycle super-node flagged `break_gate` (it needs an L5 seam
 * cut before it can checkpoint). The super-node's id is its smallest member (members
 * are disjoint, so this is a unique, stable representative).
 *
 * ITERATIVE (explicit work stack) — a recursive Tarjan RangeErrors on the deep call
 * chains a 100K+-LOC brownfield package produces (the scale NFR). Deterministic:
 * nodes and adjacency are visited in sorted order and every emitted list is sorted,
 * so the condensation is byte-stable across runs.
 *
 * @param {string[]} nodeIds
 * @param {Array<[string, string]>} edges directed `[from, to]`
 * @returns {{superNodes: Array<{id: string, members: string[], break_gate: boolean}>, edges: Array<[string, string]>, superOf: Record<string, string>}}
 */
export function tarjanCondense(nodeIds, edges) {
  const nodes = [...new Set(nodeIds)].sort();
  const adj = new Map(nodes.map((n) => [n, []]));
  for (const [u, v] of edges) {
    if (adj.has(u) && adj.has(v)) adj.get(u).push(v);
  }
  for (const list of adj.values()) list.sort();

  const comps = tarjanSccs(nodes, adj); // array of sorted member-lists
  return condense(comps, edges);
}

/** Iterative Tarjan. @returns {string[][]} each SCC's members, sorted. */
function tarjanSccs(nodes, adj) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const comps = [];
  let idx = 0;

  for (const root of nodes) {
    if (index.has(root)) continue;
    open(root);
    const work = [{ v: root, i: 0 }]; // explicit DFS frames
    while (work.length) {
      const frame = work[work.length - 1];
      const neighbors = adj.get(frame.v);
      if (frame.i < neighbors.length) {
        const w = neighbors[frame.i++];
        if (!index.has(w)) {
          open(w);
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(frame.v, Math.min(low.get(frame.v), index.get(w)));
        }
      } else {
        const v = frame.v;
        if (low.get(v) === index.get(v)) {
          const members = [];
          let w;
          do {
            w = stack.pop();
            onStack.delete(w);
            members.push(w);
          } while (w !== v);
          comps.push(members.sort());
        }
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1].v;
          low.set(parent, Math.min(low.get(parent), low.get(v)));
        }
      }
    }
  }
  return comps;

  function open(v) {
    index.set(v, idx);
    low.set(v, idx);
    idx += 1;
    stack.push(v);
    onStack.add(v);
  }
}

/** Build super-nodes + the condensed (deduped, self-loop-free, sorted) edge set. */
function condense(comps, edges) {
  const superOf = {};
  const superNodes = comps
    .map((members) => {
      const id = members[0];
      for (const m of members) superOf[m] = id;
      return { id, members, break_gate: members.length > 1 };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const seen = new Set();
  const condensed = [];
  for (const [u, v] of edges) {
    const su = superOf[u];
    const sv = superOf[v];
    if (su === undefined || sv === undefined || su === sv) continue;
    const key = JSON.stringify([su, sv]); // separator-safe for arbitrary ids
    if (!seen.has(key)) {
      seen.add(key);
      condensed.push([su, sv]);
    }
  }
  condensed.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  return { superNodes, edges: condensed, superOf };
}
