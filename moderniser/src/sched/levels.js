/**
 * Topological levels over the SCC-condensed DAG (MODERNISER_DESIGN §3.1 Stage 3, L2/L6).
 *
 * Kahn peeling by full layers: layer 0 = the in-degree-0 condensation roots, then remove
 * them and re-collect the newly-zero nodes, and so on. A node's layer therefore equals its
 * longest predecessor chain = its EARLIEST schedulable wave (it cannot start until ALL
 * predecessors are green, L2). Fixes TALOS's dead in-degree table + non-resumable one-shot:
 * the returned `indegree` is the INITIAL in-degree map — the seed for the scheduler's
 * resumable live-decrementing counter (the loop owns the decrement as nodes go green).
 *
 * Within a level, order WORST-DEBT-FIRST so the hard-checkpoint budget lands on the
 * riskiest nodes: (clean_core_grade D→A, migration_complexity desc, blast_radius desc,
 * id asc). A multi-member super-node inherits its worst member's key. `nodeMeta` is keyed
 * by ORIGINAL CPG node id (populated later by SCOPE); absent meta sorts last, id-tiebroken.
 *
 * Pure. Iterative (no recursion — deep chains at the 100K+-LOC scale NFR). Deterministic:
 * every layer is sorted, so the output is byte-stable regardless of input order. Fails
 * closed if the input is not a DAG (a cycle among super-nodes means `condense` is broken).
 *
 * @param {{superNodes: Array<{id: string, members: string[]}>, edges: Array<[string, string]>}} condensation
 * @param {Record<string, {grade?: string, complexity?: number, blast?: number}>} [nodeMeta]
 * @returns {{levels: string[][], levelOf: Record<string, number>, indegree: Record<string, number>}}
 */
export function kahnLevels(condensation, nodeMeta = {}) {
  const ids = condensation.superNodes.map((s) => s.id);
  const indegree = Object.fromEntries(ids.map((id) => [id, 0]));
  const adj = new Map(ids.map((id) => [id, []]));
  for (const [u, v] of condensation.edges) {
    if (adj.has(u) && indegree[v] !== undefined) {
      adj.get(u).push(v);
      indegree[v] += 1;
    }
  }

  const key = compositeKeys(condensation.superNodes, nodeMeta);
  const byWorst = (a, b) => cmpKey(key[a], key[b], a, b);

  const counter = { ...indegree };
  const levels = [];
  const levelOf = {};
  let assigned = 0;
  let layer = ids.filter((id) => counter[id] === 0).sort(byWorst);
  while (layer.length) {
    for (const id of layer) levelOf[id] = levels.length;
    levels.push(layer);
    assigned += layer.length;
    const next = [];
    for (const u of layer) {
      for (const v of adj.get(u)) {
        counter[v] -= 1;
        if (counter[v] === 0) next.push(v);
      }
    }
    layer = next.sort(byWorst);
  }

  if (assigned !== ids.length) {
    throw new Error(`kahnLevels: condensation is not a DAG (${ids.length - assigned} super-node(s) in a cycle)`);
  }
  return { levels, levelOf, indegree };
}

const GRADE_RANK = { D: 0, C: 1, B: 2, A: 3 };

/** Clean-core grade → rank (D worst = 0). Unknown/absent → 4 (sorts last). */
function gradeRank(grade) {
  const r = GRADE_RANK[String(grade ?? "").toUpperCase()];
  return r === undefined ? 4 : r;
}

/** Aggregate each super-node's WORST-member composite key. */
function compositeKeys(superNodes, nodeMeta) {
  const key = {};
  for (const s of superNodes) {
    let rank = 4;
    let complexity = 0;
    let blast = 0;
    for (const m of s.members) {
      const meta = nodeMeta[m] || {};
      rank = Math.min(rank, gradeRank(meta.grade));
      complexity = Math.max(complexity, meta.complexity || 0);
      blast = Math.max(blast, meta.blast || 0);
    }
    key[s.id] = { rank, complexity, blast };
  }
  return key;
}

/** Worst-first: grade D→A asc, then complexity desc, then blast desc, then id asc. */
function cmpKey(a, b, ida, idb) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.complexity !== b.complexity) return b.complexity - a.complexity;
  if (a.blast !== b.blast) return b.blast - a.blast;
  return ida < idb ? -1 : ida > idb ? 1 : 0;
}
