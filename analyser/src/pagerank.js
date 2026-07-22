/**
 * PageRank over the CPG (arch spec §3.C top_objects / §3.D priority_rank),
 * reproducing TALOS's importance ranking (local working doc, untracked: docs/reference/TALOS_ANALYSER_
 * INTERNALS.md §5): power iteration keyed by node id, damping d=0.85, dangling
 * mass redistributed uniformly, unresolved edge endpoints added as phantom
 * nodes, multi-edges counted. Pure + deterministic — a function of the graph
 * JSON only. Iteration order follows the emitted (sorted) node/edge arrays, so
 * the byte-identical determinism contract (§3.A) holds.
 */

const DAMPING = 0.85;
const MAX_ITERATIONS = 30;
const TOL = 1e-6;

/**
 * @param {{nodes?: object[], edges?: object[]}} g graph JSON
 * @param {{damping?: number, maxIterations?: number, tol?: number}} [opts]
 * @returns {Map<string, number>} node id -> PageRank score (distribution, sums to ~1)
 */
export function pageRank(g, opts = {}) {
  const d = opts.damping ?? DAMPING;
  const maxIter = opts.maxIterations ?? MAX_ITERATIONS;
  const tol = opts.tol ?? TOL;

  // Node id universe = declared nodes ∪ any phantom edge endpoint (preserving
  // first-seen order: nodes, then edge sources/targets).
  const ids = new Set();
  for (const node of g?.nodes ?? []) ids.add(node.id);
  for (const e of g?.edges ?? []) {
    ids.add(e.source);
    ids.add(e.target);
  }
  const all = [...ids];
  const n = all.length;
  if (n === 0) return new Map();

  const outTargets = new Map(); // src -> [tgt...] (multi-edges duplicated)
  const outDeg = new Map();
  for (const e of g?.edges ?? []) {
    if (!outTargets.has(e.source)) outTargets.set(e.source, []);
    outTargets.get(e.source).push(e.target);
    outDeg.set(e.source, (outDeg.get(e.source) ?? 0) + 1);
  }

  let score = new Map(all.map((id) => [id, 1 / n]));
  for (let iter = 0; iter < maxIter; iter++) {
    const base = (1 - d) / n;
    // Dangling mass: nodes with no out-edges leak their score; redistribute it
    // uniformly so the distribution stays normalized.
    let dangling = 0;
    for (const id of all) if (!outDeg.has(id)) dangling += score.get(id);
    const danglingShare = (d * dangling) / n;

    const next = new Map(all.map((id) => [id, base + danglingShare]));
    for (const [src, targets] of outTargets) {
      const share = (d * score.get(src)) / outDeg.get(src);
      for (const t of targets) next.set(t, next.get(t) + share);
    }

    let maxDelta = 0;
    for (const id of all) maxDelta = Math.max(maxDelta, Math.abs(next.get(id) - score.get(id)));
    score = next;
    if (maxDelta < tol) break;
  }
  return score;
}

/**
 * PageRank normalized to [0,1] by the max score, so the most important node = 1.0
 * (the shape §3.D priority_rank thresholds 0.8/0.5 expect). Empty graph -> empty.
 * @param {{nodes?: object[], edges?: object[]}} g
 * @returns {Map<string, number>} node id -> rank in [0,1]
 */
export function normalizedRank(g) {
  const raw = pageRank(g);
  const max = Math.max(0, ...raw.values());
  if (max === 0) return raw;
  const out = new Map();
  for (const [id, s] of raw) out.set(id, s / max);
  return out;
}
