/**
 * Mega-SCC seam computation (MODERNISER_DESIGN §3.1 Stage 2 / §3.4 #4, L5). A cycle
 * super-node above SESSION_BUDGET is never "atomic": compute an approximate minimum
 * feedback-arc-set — greedy Eades–Lin–Smyth linear arrangement, back-edges = cut
 * candidates — and choose the FEWEST cuts such that every residual sub-component fits the
 * budget. Each seam carries an evidence-based confidence (how much the cut shrank the
 * largest blob). The human approves a CUT, not an ordering (the CUT/COGEN_RAP_BO/
 * SPROUT_DEFER gate and the learned seam-memory live in the exception module, §3.4 #7).
 *
 * Pure. ITERATIVE throughout (the scale NFR — mega-SCCs are exactly where recursion
 * dies). Deterministic: inputs are normalised (sorted, deduped, self-loop/foreign-edge
 * free) before any traversal, so the result is byte-stable regardless of discovery order.
 */
import { tarjanCondense } from "./condense.js";

const CANDIDATES_PER_CUT = 16; // top-K back-edges (by span) evaluated per cut — bounded work

/**
 * Greedy Eades–Lin–Smyth arrangement: repeatedly peel sinks (to the right), sources (to
 * the left), else the max-(out−in) node — discovered incrementally via queues (no O(V²)
 * rescans). Removing the order-violating edges of the result always yields a DAG.
 * @param {string[]} nodeIds @param {Array<[string, string]>} edgesIn
 * @returns {string[]} the arrangement
 */
export function elsOrder(nodeIds, edgesIn) {
  const nodes = [...new Set(nodeIds)].sort();
  const { out, inn } = adjacency(nodes, edgesIn);
  const remaining = new Set(nodes);
  const s1 = [];
  const s2 = []; // built in removal order; ELS prepends sinks, so reversed at the end
  const sinkQ = [];
  const sourceQ = [];
  for (const n of nodes) {
    if (out.get(n).size === 0) sinkQ.push(n);
    else if (inn.get(n).size === 0) sourceQ.push(n);
  }
  const removeNode = (n) => {
    remaining.delete(n);
    for (const v of out.get(n)) {
      inn.get(v).delete(n);
      if (inn.get(v).size === 0 && remaining.has(v)) sourceQ.push(v);
    }
    for (const u of inn.get(n)) {
      out.get(u).delete(n);
      if (out.get(u).size === 0 && remaining.has(u)) sinkQ.push(u);
    }
  };
  let si = 0;
  let so = 0;
  while (remaining.size > 0) {
    while (si < sinkQ.length || so < sourceQ.length) {
      while (si < sinkQ.length) {
        const n = sinkQ[si++];
        if (remaining.has(n) && out.get(n).size === 0) {
          s2.push(n);
          removeNode(n);
        }
      }
      while (so < sourceQ.length) {
        const n = sourceQ[so++];
        if (remaining.has(n) && inn.get(n).size === 0) {
          s1.push(n);
          removeNode(n);
        }
      }
    }
    if (remaining.size > 0) {
      let best = null;
      let bestD = -Infinity;
      for (const n of remaining) {
        const d = out.get(n).size - inn.get(n).size;
        if (d > bestD || (d === bestD && n < best)) {
          best = n;
          bestD = d;
        }
      }
      s1.push(best);
      removeNode(best);
    }
  }
  return [...s1, ...s2.reverse()];
}

/**
 * The edges violating an arrangement (source placed after target) — the FAS candidates.
 * @returns {Array<[string, string]>} sorted; foreign/self edges skipped
 */
export function backEdges(order, edges) {
  const pos = new Map(order.map((n, i) => [n, i]));
  return edges
    .filter(([u, v]) => pos.has(u) && pos.has(v) && pos.get(u) > pos.get(v))
    .sort(cmpEdge);
}

/**
 * @param {{members: string[], edges: Array<[string, string]>}} scc the cycle super-node
 * @param {number} budget SESSION_BUDGET — the max residual sub-component size
 * @returns {{seams: Array<{source: string, target: string, rank: number, confidence: number}>, sub_components: string[][], order: string[]}}
 */
export function minFeedbackArcSet(scc, budget) {
  if (!Number.isInteger(budget) || budget < 1) {
    throw new Error(`feedback: budget must be an integer >= 1 (got ${budget})`);
  }
  if (!Array.isArray(scc?.members) || scc.members.length === 0) {
    throw new Error("feedback: scc.members must be a non-empty array");
  }
  const members = [...new Set(scc.members)].sort();
  const memberSet = new Set(members);
  let work = dedupe(
    (scc.edges ?? []).filter(([u, v]) => u !== v && memberSet.has(u) && memberSet.has(v)),
  );
  const order = elsOrder(members, work);
  const seams = [];

  for (;;) {
    const cond = tarjanCondense(members, work);
    const oversized = cond.superNodes
      .filter((s) => s.members.length > budget)
      .sort((a, b) => b.members.length - a.members.length || cmp(a.id, b.id));
    if (oversized.length === 0) {
      return { seams, sub_components: cond.superNodes.map((s) => s.members), order };
    }
    const target = oversized[0];
    const inComp = new Set(target.members);
    const compEdges = work.filter(([u, v]) => inComp.has(u) && inComp.has(v));
    const cut = bestCut(target.members, compEdges);
    seams.push({
      source: cut.edge[0],
      target: cut.edge[1],
      rank: seams.length + 1,
      // evidence: how much this cut shrank the largest blob; floored so the field stays in
      // (0,1] even for a dense blob where one cut cannot shrink the SCC yet.
      confidence: Math.max(0.01, Math.round(((target.members.length - cut.largestAfter) / target.members.length) * 100) / 100),
    });
    work = work.filter(([u, v]) => !(u === cut.edge[0] && v === cut.edge[1]));
  }
}

/**
 * Pick ONE back-edge to cut from an oversized component: evaluate the top-K candidates by
 * arrangement span and keep the one minimising the largest residual SCC (tiebreak span
 * desc, then edge order). An SCC with >= 2 members always has a back-edge under any total
 * order, so a candidate always exists.
 */
function bestCut(compMembers, compEdges) {
  const order = elsOrder(compMembers, compEdges);
  const pos = new Map(order.map((n, i) => [n, i]));
  const candidates = backEdges(order, compEdges)
    .map((e) => ({ e, span: pos.get(e[0]) - pos.get(e[1]) }))
    .sort((a, b) => b.span - a.span || cmpEdge(a.e, b.e))
    .slice(0, CANDIDATES_PER_CUT);
  let best = null;
  for (const c of candidates) {
    const kept = compEdges.filter(([u, v]) => !(u === c.e[0] && v === c.e[1]));
    const cc = tarjanCondense(compMembers, kept);
    const largest = Math.max(...cc.superNodes.map((s) => s.members.length));
    if (
      best === null ||
      largest < best.largestAfter ||
      (largest === best.largestAfter && (c.span > best.span || (c.span === best.span && cmpEdge(c.e, best.edge) < 0)))
    ) {
      best = { edge: c.e, largestAfter: largest, span: c.span };
    }
  }
  return best;
}

function adjacency(nodes, edgesIn) {
  const nodeSet = new Set(nodes);
  const out = new Map(nodes.map((n) => [n, new Set()]));
  const inn = new Map(nodes.map((n) => [n, new Set()]));
  for (const [u, v] of dedupe(edgesIn.filter(([a, b]) => a !== b && nodeSet.has(a) && nodeSet.has(b)))) {
    out.get(u).add(v);
    inn.get(v).add(u);
  }
  return { out, inn };
}

/** sorted + deduped edge list — normalisation makes every later choice input-order free. */
function dedupe(edges) {
  const seen = new Set();
  const outList = [];
  for (const e of [...edges].sort(cmpEdge)) {
    const k = JSON.stringify(e);
    if (!seen.has(k)) {
      seen.add(k);
      outList.push(e);
    }
  }
  return outList;
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const cmpEdge = (x, y) => cmp(x[0], y[0]) || cmp(x[1], y[1]);
