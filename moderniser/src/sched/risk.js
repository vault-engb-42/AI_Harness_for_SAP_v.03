/**
 * Worst-debt-first composite risk ordering (MODERNISER_DESIGN §3.1), shared by level
 * assignment (Stage 3, within-level order) and frontier selection (Stage 5,
 * composite_risk_key). Extracted so the two can never DIVERGE — a scheduler that ordered
 * differently from the level plan would be a silent correctness bug.
 *
 * Order: clean_core_grade D→A (worst first), then migration_complexity desc, then
 * blast_radius desc, then id asc (total, for determinism). A multi-member super-node
 * inherits its WORST member's key. `nodeMeta` is keyed by ORIGINAL CPG node id (populated
 * by SCOPE); absent meta ranks last (grade "unknown"), id-tiebroken.
 */
const GRADE_RANK = { D: 0, C: 1, B: 2, A: 3 };

/** Clean-core grade → rank (D worst = 0). Unknown/absent → 4 (sorts last). */
export function gradeRank(grade) {
  const r = GRADE_RANK[String(grade ?? "").toUpperCase()];
  return r === undefined ? 4 : r;
}

/** Aggregate each super-node's WORST-member composite key → { [superNodeId]: {rank, complexity, blast} }. */
export function superNodeKeys(superNodes, nodeMeta = {}) {
  const key = {};
  for (const s of superNodes) {
    let rank = 4;
    let complexity = 0;
    let blast = 0;
    for (const m of s.members || [s.id]) {
      const meta = nodeMeta[m] || {};
      rank = Math.min(rank, gradeRank(meta.grade));
      complexity = Math.max(complexity, meta.complexity || 0);
      blast = Math.max(blast, meta.blast || 0);
    }
    key[s.id] = { rank, complexity, blast };
  }
  return key;
}

/** A comparator over super-node ids given their precomputed keys: worst-debt-first. */
export function riskComparator(keyById) {
  return (a, b) => {
    const ka = keyById[a];
    const kb = keyById[b];
    if (ka.rank !== kb.rank) return ka.rank - kb.rank;
    if (ka.complexity !== kb.complexity) return kb.complexity - ka.complexity;
    if (ka.blast !== kb.blast) return kb.blast - ka.blast;
    return a < b ? -1 : a > b ? 1 : 0;
  };
}
