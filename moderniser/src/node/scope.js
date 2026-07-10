/**
 * SCOPE per-node JOIN (MODERNISER_DESIGN §6.2, §3.2 SCOPE). For each
 * `modernization_plan.objects[o]` (keyed by `object`), assemble the node record the
 * scheduler + node loop consume, joining the analyser's already-computed sections:
 *   canonical_sig = sha256(rule | entity_name | seam)   [rule = driving finding rule_id;
 *                     entity = object; seam = object at object granularity, §6.3]
 *   ⊕ grade   : code_health.by_object[o].grade          (OBJECT-level, authoritative)
 *   ⊕ debt    : debt.scores[symbol==o].score
 *   ⊕ blast   : Σ blast_radius[b | edge(o → b.object)]  (the object's at-risk SAP deps)
 *   ⊕ plan    : target / effort / priority / complexity / wave / dependencies / transforms
 *   ⊕ keys    : program_pool from `includes` edges (co-tenancy); ddic/locks/nr/transport are
 *               live/deeper-analysis concerns, left empty offline (never populated from mere
 *               read edges — that would fabricate spurious conflicts, per the §3.1 Stage-4 note)
 *   ⊕ parity_required : any transformation ⇒ parity is mandatory (the precise §6.1 class set
 *               is derived post-generation by classify_parity over the before/after AST)
 *
 * Pure. The before/after AST feature bundles (invariant_diff / classify_parity inputs) and
 * the raw `source` (augment) are a LATER extraction step (offline: corpus + @abaplint;
 * online: ADT get_source) — not produced here.
 *
 * @param {object} doc analyser-findings.json
 * @param {ReturnType<import("../graph/build.js").buildObjectGraph>} [objectGraph]
 * @returns {Array<object>} one scoped node record per plan object
 */
import { canonicalNodeId } from "../state/node-id.js";
import { buildObjectGraph } from "../graph/build.js";

export function scopeNodes(doc, objectGraph) {
  const og = objectGraph ?? buildObjectGraph(doc);
  const gradeOf = indexBy(doc.code_health?.by_object, (o) => o.object, (o) => o.grade);
  const debtOf = indexBy(doc.debt?.scores, (s) => s.symbol, (s) => s.score);
  const blastOf = new Map((doc.blast_radius ?? []).map((b) => [b.object, num(b.affected_program_count)]));
  const pools = programPools(og.edges);

  return (doc.modernization_plan?.objects ?? []).map((o) => {
    const rule = o.transformations?.[0]?.rule_id ?? "no-finding";
    const complexity = num(o.migration_complexity);
    const blast = sumBlast(o.object, og.edges, blastOf);
    const grade = gradeOf.get(o.object) ?? "unknown";
    return {
      object: o.object,
      canonical_sig: canonicalNodeId({ rule, entity_name: o.object, seam: o.object }),
      kind: o.kind,
      wave: o.wave,
      dependencies: [...(o.dependencies ?? [])].sort(),
      modernization_target: o.modernization_target,
      effort_tier: o.effort_tier,
      priority_rank: o.priority_rank,
      migration_complexity: complexity,
      transformation_count: num(o.transformation_count),
      parity_required: num(o.transformation_count) > 0,
      grade,
      debt: debtOf.get(o.object) ?? 0,
      blast,
      meta: { grade, complexity, blast },
      resource_keys: resourceKeys(o.object, pools),
    };
  });
}

/** id → {grade, complexity, blast} — the `nodeMeta` for kahnLevels / frontier. */
export function scopeMeta(scoped) {
  const meta = {};
  for (const s of scoped) meta[s.object] = s.meta;
  return meta;
}

/** conflict-graph node list (buildConflictGraph input), keyed by object id. */
export function scopeConflictNodes(scoped) {
  return scoped.map((s) => ({ id: s.object, ...s.resource_keys }));
}

function indexBy(arr, keyFn, valFn) {
  const m = new Map();
  for (const x of arr ?? []) m.set(keyFn(x), valFn(x));
  return m;
}

/** object → program pool = the topmost main program of its `includes` tree (co-tenancy). */
function programPools(edges) {
  const includedBy = new Map();
  const members = new Set();
  for (const e of edges) {
    if (e.kind !== "includes") continue;
    includedBy.set(e.target, e.source);
    members.add(e.source);
    members.add(e.target);
  }
  const pool = new Map();
  for (const o of members) {
    let top = o;
    const guard = new Set();
    while (includedBy.has(top) && !guard.has(top)) {
      guard.add(top);
      top = includedBy.get(top);
    }
    pool.set(o, top);
  }
  return pool;
}

function sumBlast(object, edges, blastOf) {
  let sum = 0;
  for (const e of edges) if (e.source === object && blastOf.has(e.target)) sum += blastOf.get(e.target);
  return sum;
}

function resourceKeys(object, pools) {
  const keys = { ddic: [], locks: [], number_ranges: [] };
  if (pools.has(object)) keys.program_pool = pools.get(object);
  return keys;
}

const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
