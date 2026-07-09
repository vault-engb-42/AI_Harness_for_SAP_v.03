import { routineComplexity, classCohesion, abstractnessByObject, sizeMetrics, routineLengths } from "./ast-metrics.js";
import { modernizationMetrics } from "./modernization-metrics.js";
import { objectsOf } from "./abaplint-loader.js";

/**
 * code_health dimension (arch spec §3.C) — a package-level clean_core_grade plus
 * four 0-100 health scores, all deterministic functions of the enriched CPG
 * graph JSON, the curated findings, and the parsed registry. `clarity` is a
 * multi-factor readability score (cyclomatic + routine length + nesting + LCOM*);
 * `stability`/`performance`/`compound` are the analyser's own deterministic
 * definitions (operator-approved 2026-07-09): the numbers are a UX target, not an
 * oracle.
 */

/** Node kinds that are repository compilation units (the objects we score). */
const COMPILATION_UNIT_KINDS = new Set(["class", "interface", "function", "report", "cds", "behavior", "form"]);
/** abaplint object types that hold executable code (clarity's population). */
const CODE_TYPES = new Set(["PROG", "CLAS", "FUGR", "FUNC", "INTF"]);
/** Dependency edge kinds that count as coupling for Martin instability. */
const COUPLING_KINDS = new Set(["calls", "call-function", "call-method", "inherits", "consumes-cds", "get-badi", "uses-table", "includes"]);
/** Weakness rank (mirrors enrich.js): lower = weaker (D < C < B < A). */
const LEVEL_RANK = { D: 0, C: 1, B: 2, A: 3 };
/** Clarity anchors — a penalty ramps linearly from LOW (clean) to HIGH (max). */
const CC_LOW = 10; // cyclomatic: <=10 is McCabe-clean
const CC_HIGH = 20; // >=20 is abaplint's max
const LEN_LOW = 50; // avg routine length: <=50 lines reads cleanly
const LEN_HIGH = 200; // >=200 lines is a monolith
const NEST_LOW = 3; // control-flow nesting: <=3 is fine
const NEST_HIGH = 8; // >=8 is deeply nested

/**
 * @param {{nodes?: object[], edges?: object[]}} g the enriched CPG graph JSON
 * @param {object[]} findings the curated findings
 * @param {import("@abaplint/core").Registry} reg the parsed registry (for AST metrics)
 * @returns {object} the code_health block
 */
export function codeHealth(g, findings, reg) {
  const inputs = clarityInputs(reg);
  const { clarity, clarity_breakdown } = clarityScore(inputs);
  const stability = stabilityScore(g, abstractnessByObject(reg));
  const performance = performanceScore(g, findings);
  const compound = Math.round((clarity + stability + performance) / 3);
  return {
    clean_core_grade: aggregateGrade(g?.nodes ?? []),
    clarity,
    clarity_breakdown,
    stability,
    performance,
    compound,
    by_object: perObjectHealth(g, findings, inputs),
  };
}

/**
 * Per code object (PROG/CLAS/FUGR/FUNC/INTF): the four readability inputs — worst
 * routine cyclomatic, worst routine LENGTH (longest single method/FORM/FM; an
 * event-block program with no routine structures uses its whole-program LOC), max
 * control-flow nesting, and class LCOM*. Length is per-routine max, NOT a
 * per-object average, so one 200-line monolith cannot hide among short routines.
 * @param {import("@abaplint/core").Registry} reg
 * @returns {Map<string, {maxCC: number, lengthLoc: number, nesting: number, lcom: number|null, hasCode: boolean}>}
 */
function clarityInputs(reg) {
  const maxCC = new Map();
  for (const r of routineComplexity(reg)) maxCC.set(r.object, Math.max(maxCC.get(r.object) ?? 0, r.cyclomatic));
  const size = new Map(sizeMetrics(reg).map((s) => [s.object, s]));
  const routineLen = routineLengths(reg);
  const nesting = new Map(modernizationMetrics(reg).map((m) => [m.object, m.nesting]));
  const lcom = new Map(classCohesion(reg).map((c) => [c.object, c.lcom]));
  const out = new Map();
  for (const obj of objectsOf(reg)) {
    const type = obj.getType?.();
    if (!CODE_TYPES.has(type)) continue;
    const object = obj.getName();
    const s = size.get(object) ?? { loc: 0, routines: 0 };
    const rlen = routineLen.get(object) ?? { max: 0, sum: 0 };
    // Length = worst reading unit: the longest routine OR, for a program, its
    // event-block body (total LOC outside any routine) — whichever is bigger.
    const eventBody = type === "PROG" ? Math.max(0, s.loc - rlen.sum) : 0;
    out.set(object, {
      maxCC: maxCC.get(object) ?? 0,
      lengthLoc: Math.max(rlen.max, eventBody),
      nesting: nesting.get(object) ?? 0,
      lcom: lcom.has(object) ? lcom.get(object) : null,
      hasCode: s.routines > 0 || type === "PROG",
    });
  }
  return out;
}

/** The four readability penalties (0-1) for one object; null where the dimension does not apply. */
function penalties(x) {
  return {
    cyclomatic: x.maxCC > 0 ? clamp01((x.maxCC - CC_LOW) / (CC_HIGH - CC_LOW)) : null,
    length: x.hasCode && x.lengthLoc > 0 ? clamp01((x.lengthLoc - LEN_LOW) / (LEN_HIGH - LEN_LOW)) : null,
    nesting: x.hasCode ? clamp01((x.nesting - NEST_LOW) / (NEST_HIGH - NEST_LOW)) : null,
    lcom: x.lcom == null ? null : clamp01(x.lcom),
  };
}

/** The MAX of an object's applicable penalties — its worst readability attribute. */
function objectPenalty(x) {
  const present = Object.values(penalties(x)).filter((v) => v != null);
  return present.length ? Math.max(...present) : null;
}

/**
 * Clarity = 100*(1 - mean object penalty), each object penalized by its WORST
 * readability attribute (max of cyclomatic / routine length / nesting / LCOM*), so
 * a low branch count cannot mask a 200-line routine (op observation 1a). The
 * clarity_breakdown reports each dimension's mean penalty as a 0-100 axis so the
 * score is explainable. Empty population scores 100.
 * @param {Map<string, object>} inputs
 * @returns {{clarity: number, clarity_breakdown: object}}
 */
function clarityScore(inputs) {
  const objectPenalties = [];
  const dim = { cyclomatic: [], length: [], nesting: [], lcom: [] };
  for (const x of inputs.values()) {
    const p = penalties(x);
    for (const k of Object.keys(dim)) if (p[k] != null) dim[k].push(p[k]);
    const op = objectPenalty(x);
    if (op != null) objectPenalties.push(op);
  }
  const axis = (arr) => (arr.length ? Math.round(100 * (1 - mean(arr))) : null);
  return {
    clarity: objectPenalties.length ? Math.round(100 * (1 - mean(objectPenalties))) : 100,
    clarity_breakdown: { cyclomatic: axis(dim.cyclomatic), length: axis(dim.length), nesting: axis(dim.nesting), lcom: axis(dim.lcom) },
  };
}

/**
 * Per compilation-unit object drill-down (Code Health tab): worst routine
 * cyclomatic, average routine length, max nesting, class LCOM* (null for
 * non-classes), performance-finding count, clean-core grade, and the clarity
 * penalty (0-1) that drove the score — so a reader sees WHICH objects, and WHY,
 * drag the package down. Sorted worst-penalty first.
 * @param {{nodes?: object[]}} g
 * @param {object[]} findings
 * @param {Map<string, object>} inputs
 * @returns {Array<object>}
 */
function perObjectHealth(g, findings, inputs) {
  const perfBy = new Map();
  for (const f of findings ?? []) if (f.family === "performance" && f.object) perfBy.set(f.object, (perfBy.get(f.object) ?? 0) + 1);
  const seen = new Map();
  for (const n of g?.nodes ?? []) {
    if (!COMPILATION_UNIT_KINDS.has(n.kind) || seen.has(n.object)) continue;
    const x = inputs.get(n.object);
    const pen = x ? objectPenalty(x) : null;
    seen.set(n.object, {
      object: n.object,
      kind: n.kind,
      cyclomatic: x?.maxCC ?? 0,
      max_routine_loc: x?.lengthLoc ?? 0,
      nesting: x?.nesting ?? 0,
      lcom: x && x.lcom != null ? Math.round(x.lcom * 100) / 100 : null,
      perf_findings: perfBy.get(n.object) ?? 0,
      grade: n.clean_core_grade ?? "unknown",
      penalty: pen == null ? 0 : Math.round(pen * 100) / 100,
    });
  }
  return [...seen.values()].sort((a, b) => b.penalty - a.penalty || (a.object < b.object ? -1 : a.object > b.object ? 1 : 0));
}

/**
 * Stability = 100*(1 - mean D) over the DEPENDED-UPON core, where D=|A+I-1| is
 * Robert C. Martin's distance from the main sequence: I=Ce/(Ca+Ce) is instability
 * (Ce/Ca = DISTINCT objects this object depends on / is depended on by, members
 * resolved to their owning object; self-loops and non-coupling edges ignored),
 * and A is Martin abstractness (interface=1, class=abstract-method fraction,
 * else 0). Objects with NO dependents (Ca=0) are excluded — a by-design entry
 * point's position is not a health signal (decision 2026-07-09). A package with
 * no depended-upon objects scores 100.
 * @param {{nodes?: object[], edges?: object[]}} g
 * @param {Map<string, number>} abstractness object name -> Martin abstractness A (default 0)
 * @returns {number} 0-100
 */
export function stabilityScore(g, abstractness = new Map()) {
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
  const distances = [];
  for (const object of compilationUnitObjects(nodes)) {
    const inc = ca.get(object)?.size ?? 0;
    if (inc === 0) continue; // exclude by-design entry points (nothing depends on them)
    const out = ce.get(object)?.size ?? 0;
    const instability = out / (out + inc); // inc>0 => denominator>0
    const a = abstractness.get(object) ?? 0;
    distances.push(Math.abs(a + instability - 1)); // D = |A + I - 1|, in [0,1]
  }
  return distances.length ? Math.round(100 * (1 - mean(distances))) : 100;
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
 * back to "unknown" only when no node carries a known A/B/C/D grade.
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
