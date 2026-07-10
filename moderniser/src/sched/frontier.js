/**
 * Frontier selection — the scheduling loop (MODERNISER_DESIGN §3.1 Stage 5, L2 + L4).
 *
 * A super-node is READY iff its status is PENDING, its dependency closure is green (the
 * live in-degree counter has reached 0 — the loop decrements it as each predecessor goes
 * GREEN, L2), it is not dynamic-sealed (NEEDS_MANUAL_SEAM blocks until a human confirms
 * the caller set), and it is not in the PARK register (L7). Ready nodes are ordered
 * worst-debt-first (shared risk comparator) so the hard-checkpoint budget lands on the
 * riskiest work, then picked greedily while INDEPENDENT in BOTH graphs:
 *   - the reference DAG (no directed code edge to an already-picked node), AND
 *   - the conflict graph (no shared program-pool / DDIC / lock / number-range / transport, L4),
 * up to the generator team-size cap (a resource knob, not a correctness bound).
 *
 * Scheduling is decoupled from human cadence (L2): a straggler blocks only its own
 * dependents (their in-degree never reaches 0), never unrelated same-level nodes.
 * Reference-independence is technically implied by counter-based readiness (two PENDING
 * in-degree-0 nodes cannot have a code edge between them), but is enforced defensively so
 * an inconsistent counter can never produce a non-independent batch.
 *
 * Pure function of the scheduler state. Deterministic (ready set sorted before greedy pick).
 *
 * @param {{
 *   condensation: {superNodes: Array<{id: string, members?: string[], dynamic_seal?: string}>, edges: Array<[string, string]>},
 *   conflict: {adjacency: Record<string, string[]>},
 *   status: Record<string, string>,
 *   indegree: Record<string, number>,
 *   park?: string[],
 *   meta?: Record<string, {grade?: string, complexity?: number, blast?: number}>,
 *   teamSize?: number,
 * }} state
 * @returns {string[]} the selected frontier, worst-first
 */
import { superNodeKeys, riskComparator } from "./risk.js";

const NEEDS_MANUAL_SEAM = "NEEDS_MANUAL_SEAM";

export function nextFrontier(state) {
  const { condensation, status, indegree } = state;
  const parked = new Set(state.park || []);
  const confAdj = state.conflict?.adjacency || {};
  const refAdj = undirectedRefAdjacency(condensation.edges);

  const ready = condensation.superNodes
    .filter(
      (s) =>
        status[s.id] === "PENDING" &&
        (indegree[s.id] || 0) === 0 &&
        s.dynamic_seal !== NEEDS_MANUAL_SEAM &&
        !parked.has(s.id),
    )
    .map((s) => s.id);

  ready.sort(riskComparator(superNodeKeys(condensation.superNodes, state.meta || {})));

  const cap = state.teamSize ?? Infinity;
  const frontier = [];
  const chosen = new Set();
  for (const id of ready) {
    if (frontier.length >= cap) break;
    const conflictsRef = (refAdj.get(id) || EMPTY).some((x) => chosen.has(x));
    const conflictsConf = (confAdj[id] || EMPTY).some((x) => chosen.has(x));
    if (!conflictsRef && !conflictsConf) {
      frontier.push(id);
      chosen.add(id);
    }
  }
  return frontier;
}

const EMPTY = [];

/** Undirected neighbour map over the reference edges (independence ignores edge direction). */
function undirectedRefAdjacency(edges) {
  const adj = new Map();
  const add = (a, b) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push(b);
  };
  for (const [u, v] of edges) {
    add(u, v);
    add(v, u);
  }
  return adj;
}
