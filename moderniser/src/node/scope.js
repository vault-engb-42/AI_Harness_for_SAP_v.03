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
 * live: ADT get_source) — not produced here.
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
  const drivingOf = drivingRules(doc.findings);
  const signalsOf = signalsByObject(doc.findings);

  return (doc.modernization_plan?.objects ?? []).map((o) => {
    // canonical_sig keys the ratchet baseline, so `rule` must be STABLE: the object's
    // driving (highest-severity) finding, not the positional-first transformation (§6.3).
    const rule = drivingOf.get(o.object) ?? o.transformations?.[0]?.rule_id ?? "no-finding";
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
      finding_families: signalsOf.families.get(o.object) ?? [],
      driving_rule_ids: signalsOf.rule_ids.get(o.object) ?? [],
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

/**
 * object → program pool. Every object in an `includes` tree (a main and its includes, even
 * an include pulled by several mains) is one co-tenancy cluster; the pool is the cluster's
 * min-id member. Union-find so a shared include correctly unions all its includers.
 */
function programPools(edges) {
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const add = (x) => {
    if (!parent.has(x)) parent.set(x, x);
  };
  for (const e of edges) {
    if (e.kind !== "includes") continue;
    add(e.source);
    add(e.target);
    const ra = find(e.source);
    const rb = find(e.target);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb); // min-id root
  }
  const pool = new Map();
  for (const o of parent.keys()) pool.set(o, find(o));
  return pool;
}

/**
 * object → its analyser SIGNAL SET for the disposition classifier (B1): the DISTINCT, sorted
 * finding families + rule_ids of the object's findings. The classifier (B2) is pure over the
 * node, so its declared signals must ride the node — sourced here, never recomputed downstream.
 * @param {Array<{object: string, family?: string, rule_id?: string}>} findings
 * @returns {{families: Map<string, string[]>, rule_ids: Map<string, string[]>}}
 */
function signalsByObject(findings) {
  const fam = new Map();
  const rid = new Map();
  for (const f of findings ?? []) {
    if (!fam.has(f.object)) fam.set(f.object, new Set());
    if (!rid.has(f.object)) rid.set(f.object, new Set());
    if (f.family) fam.get(f.object).add(f.family);
    if (f.rule_id) rid.get(f.object).add(f.rule_id);
  }
  const sortMap = (m) => new Map([...m].map(([k, s]) => [k, [...s].sort()]));
  return { families: sortMap(fam), rule_ids: sortMap(rid) };
}

/** object → the rule_id of its DRIVING finding: lowest atc_priority (P1<P2<P3), tiebreak rule_id. */
function drivingRules(findings) {
  const best = new Map();
  for (const f of findings ?? []) {
    const prio = priorityNum(f.atc_priority);
    const cur = best.get(f.object);
    if (!cur || prio < cur.prio || (prio === cur.prio && f.rule_id < cur.rule)) best.set(f.object, { prio, rule: f.rule_id });
  }
  const out = new Map();
  for (const [o, v] of best) out.set(o, v.rule);
  return out;
}

const priorityNum = (p) => {
  const m = String(p).match(/(\d+)/);
  return m ? Number(m[1]) : 99;
};

/** Σ blast over the object's DISTINCT at-risk deps (a dep reached via 2 edge kinds counts once). */
function sumBlast(object, edges, blastOf) {
  const deps = new Set();
  for (const e of edges) if (e.source === object && blastOf.has(e.target)) deps.add(e.target);
  let sum = 0;
  for (const t of deps) sum += blastOf.get(t);
  return sum;
}

function resourceKeys(object, pools) {
  const keys = { ddic: [], locks: [], number_ranges: [] };
  if (pools.has(object)) keys.program_pool = pools.get(object);
  return keys;
}

const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
