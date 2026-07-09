import { methodCyclomatic, classCohesion } from "./ast-metrics.js";

/**
 * code_health dimension (arch spec §3.C) — a package-level clean_core_grade plus
 * four 0-100 health scores, all deterministic functions of the enriched CPG
 * graph JSON, the curated findings, and the parsed registry. Only `clarity` is
 * spec-formulated (cyclomatic b+1 + LCOM); `stability`/`performance`/`compound`
 * are the analyser's own deterministic definitions (operator-approved 2026-07-09,
 * "faithful AST metrics"): the reference numbers are a UX target, not an oracle.
 */

/** Node kinds that are repository compilation units (the objects we score). */
const COMPILATION_UNIT_KINDS = new Set(["class", "interface", "function", "report", "cds", "behavior", "form"]);
/** Dependency edge kinds that count as coupling for Martin instability. */
const COUPLING_KINDS = new Set(["calls", "call-function", "call-method", "inherits", "consumes-cds", "get-badi", "uses-table", "includes"]);
/** Weakness rank (mirrors enrich.js): lower = weaker (D < C < B < A). */
const LEVEL_RANK = { D: 0, C: 1, B: 2, A: 3 };
/** Cyclomatic clarity anchors: <=10 is McCabe-clean, >=20 is abaplint's max. */
const CC_LOW = 10;
const CC_HIGH = 20;

/**
 * @param {{nodes?: object[], edges?: object[]}} g the enriched CPG graph JSON
 * @param {object[]} findings the curated findings
 * @param {import("@abaplint/core").Registry} reg the parsed registry (for AST metrics)
 * @returns {{clean_core_grade: string, clarity: number, stability: number, performance: number, compound: number}}
 */
export function codeHealth(g, findings, reg) {
  const clarity = clarityScore(reg);
  const stability = stabilityScore(g);
  const performance = performanceScore(g, findings);
  const compound = Math.round((clarity + stability + performance) / 3);
  return { clean_core_grade: aggregateGrade(g?.nodes ?? []), clarity, stability, performance, compound };
}

/**
 * Clarity = equal-weight mean of the two present sub-axes. Cyclomatic sub-axis:
 * each method penalized linearly from 0 at cc<=10 to 1 at cc>=20 (abaplint max),
 * score = 100*(1 - mean penalty). LCOM sub-axis: score = 100*(1 - mean LCOM*).
 * A package with neither methods nor classes scores 100 (no complexity to fault).
 * @param {import("@abaplint/core").Registry} reg
 * @returns {number} 0-100
 */
function clarityScore(reg) {
  const sub = [];
  const ccs = methodCyclomatic(reg);
  if (ccs.length) {
    const penalties = ccs.map((m) => clamp01((m.cyclomatic - CC_LOW) / (CC_HIGH - CC_LOW)));
    sub.push(100 * (1 - mean(penalties)));
  }
  const cohesions = classCohesion(reg);
  if (cohesions.length) {
    sub.push(100 * (1 - mean(cohesions.map((c) => c.lcom))));
  }
  return sub.length ? Math.round(mean(sub)) : 100;
}

/**
 * Stability = 100*(1 - mean Martin instability I=Ce/(Ca+Ce)) over compilation-unit
 * objects, where Ce/Ca are the DISTINCT other objects this object depends on /
 * is depended on by (members resolved to their owning object; self-loops and
 * non-coupling edges ignored). Isolated objects (Ce+Ca=0) are excluded; an
 * uncoupled package scores 100.
 * @param {{nodes?: object[], edges?: object[]}} g
 * @returns {number} 0-100
 */
function stabilityScore(g) {
  const nodes = g?.nodes ?? [];
  const ownerById = new Map(nodes.map((n) => [n.id, n.object]));
  const ce = new Map();
  const ca = new Map();
  for (const e of g?.edges ?? []) {
    if (!COUPLING_KINDS.has(e.kind)) continue;
    const src = ownerById.get(e.source) ?? e.source;
    const tgt = ownerById.get(e.target) ?? e.target;
    if (!src || !tgt || src === tgt) continue;
    addTo(ce, src, tgt);
    addTo(ca, tgt, src);
  }
  const instabilities = [];
  for (const object of compilationUnitObjects(nodes)) {
    const out = ce.get(object)?.size ?? 0;
    const inc = ca.get(object)?.size ?? 0;
    if (out + inc === 0) continue;
    instabilities.push(out / (out + inc));
  }
  return instabilities.length ? Math.round(100 * (1 - mean(instabilities))) : 100;
}

/**
 * Performance = share of compilation-unit objects with no performance-family
 * finding. An object-free package scores 100.
 * @param {{nodes?: object[]}} g
 * @param {object[]} findings
 * @returns {number} 0-100
 */
function performanceScore(g, findings) {
  const objects = compilationUnitObjects(g?.nodes ?? []);
  if (objects.size === 0) return 100;
  const flagged = new Set((findings ?? []).filter((f) => f.family === "performance").map((f) => f.object));
  let clean = 0;
  for (const o of objects) if (!flagged.has(o)) clean += 1;
  return Math.round((100 * clean) / objects.size);
}

/**
 * Package clean_core_grade = weakest KNOWN node grade (§2 weakest-wins); falls
 * back to "unknown" only when no node carries a known A/B/C/D grade (§15.3
 * unknown->INDETERMINATE). A known blocker (D) dominates any co-present unknowns.
 * @param {object[]} nodes
 * @returns {string} A|B|C|D|unknown
 */
function aggregateGrade(nodes) {
  let weakest = null;
  for (const n of nodes) {
    const grade = n.clean_core_grade;
    if (grade === undefined || grade === "unknown" || !(grade in LEVEL_RANK)) continue;
    if (weakest === null || LEVEL_RANK[grade] < LEVEL_RANK[weakest]) weakest = grade;
  }
  return weakest ?? "unknown";
}

/** @param {object[]} nodes @returns {Set<string>} distinct owning objects of compilation-unit nodes */
function compilationUnitObjects(nodes) {
  const objects = new Set();
  for (const n of nodes) if (COMPILATION_UNIT_KINDS.has(n.kind)) objects.add(n.object);
  return objects;
}

/** @param {Map<string, Set<string>>} index @param {string} from @param {string} to */
function addTo(index, from, to) {
  let set = index.get(from);
  if (!set) index.set(from, (set = new Set()));
  set.add(to);
}

/** @param {number[]} xs @returns {number} arithmetic mean (0 for empty) */
function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** @param {number} x @returns {number} x clamped to [0,1] */
function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
