/**
 * Mega-SCC seam computation (MODERNISER_DESIGN §3.1 Stage 2 / §3.4 #4, L5). A cycle
 * super-node above SESSION_BUDGET is never "atomic": compute an approximate minimum
 * feedback-arc-set — greedy Eades–Lin–Smyth linear arrangement, back-edges = cut
 * candidates — cutting GREEDILY FEW edges (approximate; exact minimality is NP-hard and
 * §3.1 asks only for "approximate") until every residual sub-component fits the budget.
 * Each seam carries an HONEST evidence field: `confidence` = how much the cut shrank the
 * largest blob (0 when it broke structure without shrinking it yet — such cuts also carry
 * `structural: true`; no fabricated floors, the human ranks by this number).
 *
 * The human approves a CUT, not an ordering. Deferred to the exception module (§3.4 #7),
 * recorded here so nothing is silently dropped: the CUT/COGEN_RAP_BO/SPROUT_DEFER gate
 * (`cycle_gate.proposeSeams` is the intended caller wrapping `minFeedbackArcSet`), the
 * learned seam-memory (member-signature-set keyed), the gate-packet edge-KIND enrichment
 * (seams are (source,target) pairs — the gate joins kinds upstream; `possible_cycle`
 * synthetic edges deserve cut-preference the pipeline cannot yet express), and the
 * per-member sub-scheduler for mid-cycle resume (§3.1 Stage 2 last sentence — home:
 * sched/loop + exception scheduler, DEV-gated).
 *
 * Pure. ITERATIVE throughout (the scale NFR — mega-SCCs are exactly where recursion
 * dies). Deterministic: inputs are normalised (sorted, deduped, self-loop/foreign-edge
 * free) before any traversal, so the result is byte-stable regardless of discovery order.
 */
import { tarjanCondense } from "./condense.js";

const CANDIDATES_PER_CUT = 16; // top-K back-edges (by span) evaluated per cut — bounded work

/**
 * Greedy Eades–Lin–Smyth arrangement: repeatedly peel sinks (to the right), sources (to
 * the left), else the max-(out−in) node. Sink/source discovery is incremental via queues
 * (no O(V²) rescans for the peeling); NB the stuck-pick fallback scans `remaining` per
 * pick, so a dense sink/source-free blob degrades toward O(V²) — the ELS m/2−n/6 quality
 * bound holds regardless (delta-buckets are the known fix if profiling ever bites).
 * Removing the order-violating edges of the result always yields a DAG.
 * @param {string[]} nodeIds @param {Array<[string, string]>} edgesIn
 * @returns {string[]} the arrangement
 */
export function elsOrder(nodeIds, edgesIn) {
  const nodes = [...new Set(nodeIds)].sort();
  const { out, inn } = adjacency(nodes, edgesIn);
  const ctx = { out, inn, remaining: new Set(nodes), s1: [], s2: [], sinkQ: [], sourceQ: [], si: 0, so: 0 };
  for (const n of nodes) {
    if (out.get(n).size === 0) ctx.sinkQ.push(n);
    else if (inn.get(n).size === 0) ctx.sourceQ.push(n);
  }
  while (ctx.remaining.size > 0) {
    drainPeelQueues(ctx);
    if (ctx.remaining.size > 0) stuckPick(ctx);
  }
  return [...ctx.s1, ...ctx.s2.reverse()]; // s2 was built in removal order; ELS prepends sinks
}

/** remove a node, feeding newly-created sinks/sources into the peel queues. */
function removeNode(ctx, n) {
  ctx.remaining.delete(n);
  for (const v of ctx.out.get(n)) {
    ctx.inn.get(v).delete(n);
    if (ctx.inn.get(v).size === 0 && ctx.remaining.has(v)) ctx.sourceQ.push(v);
  }
  for (const u of ctx.inn.get(n)) {
    ctx.out.get(u).delete(n);
    if (ctx.out.get(u).size === 0 && ctx.remaining.has(u)) ctx.sinkQ.push(u);
  }
}

/** peel every queued sink (→ s2) and source (→ s1); stale queue entries are re-validated. */
function drainPeelQueues(ctx) {
  while (ctx.si < ctx.sinkQ.length || ctx.so < ctx.sourceQ.length) {
    while (ctx.si < ctx.sinkQ.length) {
      const n = ctx.sinkQ[ctx.si++];
      if (ctx.remaining.has(n) && ctx.out.get(n).size === 0) {
        ctx.s2.push(n);
        removeNode(ctx, n);
      }
    }
    while (ctx.so < ctx.sourceQ.length) {
      const n = ctx.sourceQ[ctx.so++];
      if (ctx.remaining.has(n) && ctx.inn.get(n).size === 0) {
        ctx.s1.push(n);
        removeNode(ctx, n);
      }
    }
  }
}

/** no sinks or sources left: remove the max-(out−in) node (tiebreak min id) to s1. */
function stuckPick(ctx) {
  let best = null;
  let bestD = -Infinity;
  for (const n of ctx.remaining) {
    const d = ctx.out.get(n).size - ctx.inn.get(n).size;
    if (d > bestD || (d === bestD && n < best)) {
      best = n;
      bestD = d;
    }
  }
  ctx.s1.push(best);
  removeNode(ctx, best);
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
    const noShrink = cut.largestAfter === target.members.length;
    seams.push({
      source: cut.edge[0],
      target: cut.edge[1],
      rank: seams.length + 1,
      // HONEST evidence for the human gate: how much this cut shrank the largest blob.
      // A structure-breaking cut that shrank nothing reports 0 (+ structural marker) —
      // never a fabricated floor a human could mistake for measured shrink.
      confidence: Math.round(((target.members.length - cut.largestAfter) / target.members.length) * 100) / 100,
      ...(noShrink ? { structural: true } : {}),
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
    let largest = 1; // loop, never a spread — Math.max(...130k members) RangeErrors (argument-count ceiling)
    for (const s of cc.superNodes) if (s.members.length > largest) largest = s.members.length;
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
