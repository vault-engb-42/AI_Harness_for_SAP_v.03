/**
 * The bounded-LLM JUDGMENT I/O boundary (BUILD_PLAN S14) — the SINGLE P8 seam.
 *
 * `factStream(node, consumptionByObject)` reduces a frozen plan node to a CLOSED, canonical object of
 * DETERMINISTIC structural facts. **The arch-reason judge prompt is built ONLY from this object** — that
 * is what makes P8 enforceable: no raw source, no finding-message prose, and no customer-controlled free
 * text (object names, node sigs, raw dependency sigs, un-vetted target strings) ever reaches the model.
 * Every field is either a closed enum / analyser-controlled token, a number, or an allowlist-validated
 * value. `factHash` is its content hash (the same `sha256(canonicalJSON(...))` method as `plan_hash`),
 * the preimage the verdict cache is keyed on (S14 / ADDITION A).
 */
import { createHash } from "node:crypto";
import { canonicalJSON } from "../state/canonical-json.js";

// The analyser's `modernization_target` vocabulary. A target outside it is a residual free string, so it
// is dropped to "unknown" (fail-closed) rather than passed through to the model (S14 allowlist rule).
const KNOWN_TARGETS = new Set([
  "Fiori Elements App", "OData V4 Service", "RAP Business Object", "RAP Interface", "CDS View", "CDS View Entity",
]);

// Higher rank = worse code health. `unknown` (analyser could not grade) never counts as the worst.
const GRADE_RANK = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6 };

/**
 * @param {object} node a frozen plan node (assemble.js shape: object_kind/kind/finding_families/
 *   driving_rule_ids/disposition_hints/disposition/member_meta/modernization_target/dependencies/members)
 * @param {Record<string, string[]>} [consumptionByObject] the consumption-facts cache (consumption-facts.js)
 * @returns {{object_kind: string|null, graph_kind: string|null, finding_families: string[], driving_rule_ids: string[], disposition_hints: string[], disposition: string|null, consumption: string[], modernization_target: string|null, member_summary: {members: number, worst_grade: string, max_complexity: number, total_blast: number}, dependency_count: number}}
 */
export function factStream(node, consumptionByObject = {}) {
  return {
    object_kind: node.object_kind ?? null,
    graph_kind: node.kind ?? null,
    finding_families: [...(node.finding_families ?? [])].sort(),
    driving_rule_ids: [...(node.driving_rule_ids ?? [])].sort(),
    disposition_hints: [...(node.disposition_hints ?? [])].sort(),
    disposition: node.disposition ?? null,
    consumption: consumptionUnion(node, consumptionByObject),
    modernization_target: safeTarget(node.modernization_target ?? null),
    member_summary: reduceMemberMeta(node.member_meta),
    // cardinality only: the raw dependency sigs are opaque to the judge and are a customer-derived string,
    // so the coupling signal is reduced to a count (never the sigs themselves).
    dependency_count: Array.isArray(node.dependencies) ? node.dependencies.length : 0,
  };
}

/** The content hash of the fact stream (S14 verdict-cache key preimage). */
export function factHash(node, consumptionByObject = {}) {
  return hashFactStream(factStream(node, consumptionByObject));
}

/** The content hash of an already-built fact stream (same sha256(canonicalJSON) as plan_hash). */
export function hashFactStream(fact) {
  return createHash("sha256").update(canonicalJSON(fact)).digest("hex");
}

// The case-folded view of a by-object map, cached per map INSTANCE. factStream is called once per plan node
// with the SAME map, so rebuilding the index inside made the pass O(nodes × objects) — invisible on a toy
// fixture, quadratic at the 100K+ LOC scale this must hold (M6). Keyed weakly on the caller's own object, so
// it stays a pure function of its input and never retains a map the caller has dropped. Assumes the map is
// NOT mutated after first use — it is a pure derivation of the frozen, content-hashed findings doc
// (consumption-facts.js), so a mutation would already have broken the fact hash's determinism.
const _upperIndexCache = new WeakMap();
function upperIndex(map) {
  if (map === null || typeof map !== "object") return {};
  const hit = _upperIndexCache.get(map);
  if (hit) return hit;
  const out = {};
  for (const k of Object.keys(map)) out[k.toUpperCase()] = map[k];
  _upperIndexCache.set(map, out);
  return out;
}

/** Sorted union of the consumption facts of every member (case-insensitive on the member id). */
function consumptionUnion(node, consumptionByObject) {
  const byUpper = upperIndex(consumptionByObject);
  const members = node.members?.length ? node.members : [node.object];
  const set = new Set();
  for (const m of members) for (const f of byUpper[String(m).toUpperCase()] ?? []) set.add(f);
  return [...set].sort();
}

/** An allowlisted analyser target, `null` for none, `"unknown"` for anything outside the vocabulary. */
function safeTarget(target) {
  if (target == null) return null;
  return KNOWN_TARGETS.has(target) ? target : "unknown";
}

/** Reduce per-member {grade,complexity,blast} to a deterministic summary (member_meta reduced, S14). */
function reduceMemberMeta(memberMeta) {
  const metas = Object.values(memberMeta ?? {});
  let worstRank = 0;
  let worstGrade = "unknown";
  let maxComplexity = 0;
  let totalBlast = 0;
  for (const m of metas) {
    const rank = GRADE_RANK[m?.grade] ?? 0;
    if (rank > worstRank) {
      worstRank = rank;
      worstGrade = m.grade;
    }
    const c = Number(m?.complexity);
    if (Number.isFinite(c) && c > maxComplexity) maxComplexity = c;
    const b = Number(m?.blast);
    if (Number.isFinite(b)) totalBlast += b;
  }
  return { members: metas.length, worst_grade: worstGrade, max_complexity: maxComplexity, total_blast: totalBlast };
}
