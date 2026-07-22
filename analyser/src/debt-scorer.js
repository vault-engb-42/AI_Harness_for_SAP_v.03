import { methodCyclomatic, classCohesion, abstractnessByObject, sizeMetrics } from "./ast-metrics.js";
import { objectsOf } from "./abaplint-loader.js";

/**
 * Tech-debt scoring (arch spec §3.C Debt tab) — a per-symbol 0-1 composite over
 * 10 signals, grounded in TALOS's debt_scorer (local working doc, untracked: docs/reference/TALOS_ANALYSER_
 * INTERNALS.md Appendix A) and ADAPTED to our real metrics (operator-approved
 * 2026-07-09): where TALOS forces complexity=0.0 for ABAP, uses a coupling PROXY
 * for lcom, and 0 for duplication (no clone detector), we compute REAL McCabe
 * complexity, Henderson-Sellers LCOM*, and clone-finding duplication — so our
 * debt is populated where TALOS's reads flat. Structure/weights/anchors are
 * TALOS's. Symbol = the compilation-unit object (node.object). Deterministic:
 * a pure function of the parsed registry, the CPG graph JSON, and the findings.
 */

const MAX_FILE_LINES = 300; // size_ratio anchor
const ROUTINES_PER = 50; // function_density: routines per 50 lines
const MAX_FUNCTION_LINES = 50; // avg_function_length anchor
const CC_LOW = 10; // complexity: McCabe-clean
const CC_HIGH = 20; // complexity: abaplint max
const DUP_RULE_ID = "talos-duplicate-block"; // clone-pack finding

// Composite = weighted sum of ONLY signals 1-6 (weights sum to 1.0); signals
// 7-10 are structural, reported but NOT weighted (TALOS debt_scorer).
const WEIGHTS = { size_ratio: 0.2, function_density: 0.1, avg_function_length: 0.2, coupling: 0.2, complexity: 0.2, duplication: 0.1 };

const COMPILATION_UNIT_KINDS = new Set(["class", "interface", "function", "report", "cds", "behavior", "form"]);
const COUPLING_KINDS = new Set(["calls", "call-function", "call-method", "inherits", "consumes-cds", "get-badi", "uses-table", "includes"]);

/**
 * @param {{nodes?: object[], edges?: object[]}} g enriched CPG graph JSON
 * @param {object[]} findings curated findings (for the duplication signal)
 * @param {import("@abaplint/core").Registry} reg parsed registry (for AST metrics)
 * @returns {{scores: Array<{symbol: string, score: number, signals: object}>, avg_score: number, max_score: number, hotspot_count: number}}
 */
export function scoreDebt(g, findings, reg) {
  const maps = {
    size: new Map(sizeMetrics(reg).map((s) => [s.object, s])),
    complexity: meanByObject(methodCyclomatic(reg), (m) => clamp01((m.cyclomatic - CC_LOW) / (CC_HIGH - CC_LOW))),
    lcom: meanByObject(classCohesion(reg), (c) => c.lcom),
    abstract: abstractnessByObject(reg),
    interfaces: interfacePresence(reg),
    testReady: testReadyObjects(reg),
    coupling: couplingByObject(g),
    dup: dupByObject(findings),
  };
  const objects = compilationUnitObjects(g?.nodes ?? []);
  const n = Math.max(objects.size, 1);
  const scores = [];
  for (const object of objects) {
    const signals = signalsFor(object, maps.size.get(object) ?? { loc: 0, routines: 0 }, n, maps);
    scores.push({ symbol: object, score: composite(signals), signals });
  }
  scores.sort((a, b) => b.score - a.score || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  const all = scores.map((s) => s.score);
  return {
    scores,
    avg_score: all.length ? round3(mean(all)) : 0,
    max_score: all.length ? Math.max(...all) : 0,
    hotspot_count: all.filter((s) => s > 0.5).length,
  };
}

/**
 * The 10 signals for one object (raw, except structural_quality rounded per
 * TALOS). Higher = more debt throughout.
 * @returns {object}
 */
function signalsFor(object, sz, n, maps) {
  const size_ratio = sz.loc > 0 ? clamp01(sz.loc / MAX_FILE_LINES) : 0;
  const density = sz.loc > 0 ? sz.routines / (sz.loc / ROUTINES_PER) : 0;
  const function_density = sz.loc > 0 ? clamp01(1 - density) : 0; // sparse routines = worse
  const avg_function_length = sz.routines > 0 ? clamp01(sz.loc / sz.routines / MAX_FUNCTION_LINES) : 0;
  const coupling = clamp01((maps.coupling.get(object) ?? 0) / n);
  const complexity = maps.complexity.get(object) ?? 0; // ADAPT: real McCabe mean penalty
  const duplication = clamp01((maps.dup.get(object) ?? 0) / Math.max(sz.routines, 1)); // ADAPT: clone density
  const interface_presence = maps.interfaces.has(object) || (maps.abstract.get(object) ?? 0) > 0 ? 1 : 0;
  const test_double_ready = maps.testReady.has(object) ? 1 : 0;
  const lcom_score = maps.lcom.get(object) ?? 0; // ADAPT: real Henderson-Sellers LCOM*
  const structural_quality = round3(
    (1 - clamp01(coupling / 20)) * 0.3 + (1 - lcom_score) * 0.3 + interface_presence * 0.2 + test_double_ready * 0.2,
  );
  return { size_ratio, function_density, avg_function_length, coupling, complexity, duplication, interface_presence, test_double_ready, lcom_score, structural_quality };
}

/** Composite = weighted sum of signals 1-6, clamped to [0,1], rounded to 3. */
function composite(s) {
  let raw = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) raw += s[k] * w;
  return round3(Math.min(raw, 1));
}

/** @param {Array<object>} items @param {(item: object) => number} fn @returns {Map<string, number>} object -> mean(fn) */
function meanByObject(items, fn) {
  const byObj = new Map();
  for (const it of items) {
    if (!byObj.has(it.object)) byObj.set(it.object, []);
    byObj.get(it.object).push(fn(it));
  }
  const out = new Map();
  for (const [o, vs] of byObj) out.set(o, mean(vs));
  return out;
}

/** @param {{nodes?: object[], edges?: object[]}} g @returns {Map<string, number>} object -> distinct fan-in + fan-out */
function couplingByObject(g) {
  const owner = new Map((g?.nodes ?? []).map((x) => [x.id, x.object]));
  const ce = new Map();
  const ca = new Map();
  for (const e of g?.edges ?? []) {
    if (!COUPLING_KINDS.has(e.kind)) continue;
    const s = owner.get(e.source) ?? e.source;
    const t = owner.get(e.target) ?? e.target;
    if (!s || !t || s === t) continue;
    addTo(ce, s, t);
    addTo(ca, t, s);
  }
  const out = new Map();
  for (const o of new Set([...ce.keys(), ...ca.keys()])) out.set(o, (ce.get(o)?.size ?? 0) + (ca.get(o)?.size ?? 0));
  return out;
}

/** @param {object[]} findings @returns {Map<string, number>} object -> clone-block finding count */
function dupByObject(findings) {
  const out = new Map();
  for (const f of findings ?? []) {
    if (f?.rule_id === DUP_RULE_ID && f.object) out.set(f.object, (out.get(f.object) ?? 0) + 1);
  }
  return out;
}

/** @param {import("@abaplint/core").Registry} reg @returns {Set<string>} objects that are or declare/implement an interface */
function interfacePresence(reg) {
  const s = new Set();
  for (const obj of objectsOf(reg)) {
    if (obj.getType?.() === "INTF") {
      s.add(obj.getName());
      continue;
    }
    for (const file of obj.getABAPFiles?.() ?? []) {
      for (const cd of file.getInfo?.().listClassDefinitions?.() ?? []) {
        if (!cd.isForTesting && (cd.interfaces ?? []).length > 0) s.add(obj.getName());
      }
    }
  }
  return s;
}

/** @param {import("@abaplint/core").Registry} reg @returns {Set<string>} objects with a .clas.testclasses include */
function testReadyObjects(reg) {
  const s = new Set();
  for (const obj of objectsOf(reg)) if (obj.getTestclassFile?.()?.getFilename()) s.add(obj.getName());
  return s;
}

/** @param {object[]} nodes @returns {Set<string>} distinct owning objects of compilation-unit nodes */
function compilationUnitObjects(nodes) {
  const s = new Set();
  for (const n of nodes) if (COMPILATION_UNIT_KINDS.has(n.kind)) s.add(n.object);
  return s;
}

/** @param {Map<string, Set<string>>} m @param {string} k @param {string} v */
function addTo(m, k, v) {
  let s = m.get(k);
  if (!s) m.set(k, (s = new Set()));
  s.add(v);
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round3 = (x) => Math.round(x * 1000) / 1000;
