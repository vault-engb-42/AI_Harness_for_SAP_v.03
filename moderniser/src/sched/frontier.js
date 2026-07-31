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
 * Conflict independence is DIRECT (§3.1 Stage 4): a candidate conflicts with the batch iff
 * it shares a resource key with an already-chosen node — tracked by accumulating chosen
 * nodes' `keysOf` into a running set, so it stays O(keys) even for a huge co-tenant bucket
 * (never the O(k²) clique). Two nodes in one transitive cluster that share nothing directly
 * may still co-generate; the per-transport activate mutex (L4) guards their activation.
 *
 * @param {{
 *   condensation: {superNodes: Array<{id: string, members?: string[], dynamic_seal?: string}>, edges: Array<[string, string]>},
 *   conflict: {keysOf: Record<string, string[]>},
 *   status: Record<string, string>,
 *   indegree: Record<string, number>,
 *   park?: string[],
 *   ineligible?: string[],
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
  const keysOf = state.conflict?.keysOf || {};
  const refAdj = undirectedRefAdjacency(condensation.edges);

  // `ineligible` nodes are excluded HERE — before the sort and before the team-size break — so a node that
  // cannot run (e.g. an arch-gated node awaiting human ratification) can never consume a cap slot and starve
  // work that is dispatchable right now (M5). A downstream filter cannot fix this: the cap has already
  // truncated the ready list by then.
  const ineligible = new Set(state.ineligible || []);

  const ready = condensation.superNodes
    .filter(
      (s) =>
        status[s.id] === "PENDING" &&
        indegree[s.id] === 0 && // fail-closed: a missing counter entry is NOT ready
        s.dynamic_seal !== NEEDS_MANUAL_SEAM &&
        !parked.has(s.id) &&
        !ineligible.has(s.id),
    )
    .map((s) => s.id);

  ready.sort(riskComparator(superNodeKeys(condensation.superNodes, state.meta || {})));

  const cap = state.teamSize ?? Infinity;
  const frontier = [];
  const chosen = new Set();
  const chosenKeys = new Set();
  for (const id of ready) {
    if (frontier.length >= cap) break;
    const conflictsRef = (refAdj.get(id) || EMPTY).some((x) => chosen.has(x));
    const conflictsConf = (keysOf[id] || EMPTY).some((k) => chosenKeys.has(k));
    if (!conflictsRef && !conflictsConf) {
      frontier.push(id);
      chosen.add(id);
      for (const k of keysOf[id] || EMPTY) chosenKeys.add(k);
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
