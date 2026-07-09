import { modernizationMetrics } from "./modernization-metrics.js";
import { methodCyclomatic } from "./ast-metrics.js";

/**
 * Modernization plan (§3.D) — per customer object: modernization target, effort
 * tier, priority rank, migration complexity, and its transformation work-list,
 * emitted in transport-safe order. Reproduces TALOS's enrich_node_metadata +
 * transport sequence (docs/reference/TALOS_ANALYSER_INTERNALS.md §10 / Appendix B)
 * over our REAL inputs — debt (debt-scorer), rank (normalized PageRank), and AST
 * metrics — rather than TALOS's regex proxies. Deterministic: a pure function of
 * the graph JSON, debt block, findings, parsed registry, and oracle adapter.
 */

// Node kind -> modernization target artifact (TALOS obj_type map, on our kinds).
const TARGET_BY_KIND = {
  class: "RAP Business Object",
  report: "Fiori Elements App",
  function: "OData V4 Service",
  interface: "RAP Interface",
  table: "CDS View Entity",
  cds: "CDS View Entity",
};
const DEFAULT_TARGET = "Review Required";

// Transport sequence rank (TALOS _TRANSPORT_ORDER {cds:1,intf:2,class:3,bdef:4}):
// "CDS views -> interfaces -> classes -> behavior definitions." Unmapped kinds
// sort last (99), then by name.
const TRANSPORT_RANK = { cds: 1, interface: 2, class: 3, behavior: 4 };
const DEFAULT_TRANSPORT = 99;

// Customer compilation-unit kinds that get a plan entry. Members (method/form)
// are excluded — they modernize with their owner, not independently.
const PLAN_KINDS = new Set(["class", "report", "function", "interface", "table", "cds", "behavior"]);
// P1: only customer objects are modernization targets; SAP/registered are deps.
const CUSTOMER_NS = new Set(["Z", "Y"]);

// TALOS's migration_complexity obj_type term counts {wdyn,wapa,enho} (Web Dynpro /
// BSP / enhancement). Our node taxonomy has no analogue, so the term is
// structurally 0 — kept for parity, evaluates false for every kind we emit.
const COMPLEX_KINDS = new Set();

// A transformation is a modernization step; raw abaplint style/naming lint is
// code-quality (it feeds debt/clarity + the Findings tab), not a migration step.
const isTransformation = (f) => Boolean(f?.family) && f.family !== "abaplint";

/** @param {string} kind @returns {string} */
export function modernizationTarget(kind) {
  return TARGET_BY_KIND[kind] ?? DEFAULT_TARGET;
}

/** @param {number} debt @param {number} stmts @returns {"S"|"M"|"L"|"XL"} */
export function effortTier(debt, stmts) {
  if (debt > 0.7 || stmts > 200) return "XL";
  if (debt > 0.5 || stmts > 100) return "L";
  if (debt > 0.3 || stmts > 50) return "M";
  return "S";
}

/** @param {number} rank normalized PageRank in [0,1] @returns {"P1"|"P2"|"P3"} */
export function priorityRank(rank) {
  if (rank > 0.8) return "P1";
  if (rank > 0.5) return "P2";
  return "P3";
}

/**
 * @param {{dyn_call_ratio: number, cyclomatic: number, nesting: number, debt: number, kind: string}} m
 * @returns {number} 0-5 (0-4 in our taxonomy; the obj_type term has no analogue)
 */
export function migrationComplexity({ dyn_call_ratio, cyclomatic, nesting, debt, kind }) {
  return (
    (dyn_call_ratio > 0.3 ? 1 : 0) +
    (cyclomatic > 10 ? 1 : 0) +
    (nesting > 5 ? 1 : 0) +
    (debt > 0.6 ? 1 : 0) +
    (COMPLEX_KINDS.has(kind) ? 1 : 0)
  );
}

/** @param {string} kind @returns {number} transport sequence rank */
export function transportRank(kind) {
  return TRANSPORT_RANK[kind] ?? DEFAULT_TRANSPORT;
}

/**
 * @param {{nodes?: object[]}} g enriched CPG graph JSON (nodes carry rank + namespace)
 * @param {{scores?: Array<{symbol: string, score: number}>}} debt debt block
 * @param {object[]} findings curated findings
 * @param {import("@abaplint/core").Registry} reg parsed registry
 * @param {{getSuccessor?: (name: string) => (string|undefined)}} cloud oracle adapter
 * @returns {{objects: object[], summary: object}}
 */
export function modernizationPlan(g, debt, findings, reg, cloud) {
  const debtByObject = new Map((debt?.scores ?? []).map((s) => [s.symbol, s.score]));
  const metricsByObject = new Map(modernizationMetrics(reg).map((m) => [m.object, m]));
  const cycloByObject = maxCyclomaticByObject(reg);
  const transformsByObject = groupTransformations(findings, cloud);

  const units = customerUnits(g?.nodes ?? []);
  const planObjects = new Set(units.map((u) => u.object));
  const deps = dependenciesByObject(g, planObjects);
  const waves = topologicalWaves(units, deps);

  const objects = [];
  for (const { object, kind, rank } of units) {
    const debtScore = debtByObject.get(object) ?? 0;
    const m = metricsByObject.get(object) ?? { stmts: 0, dyn_call_ratio: 0, nesting: 0 };
    const cyclomatic = cycloByObject.get(object) ?? 0;
    const transformations = transformsByObject.get(object) ?? [];
    objects.push({
      object,
      kind,
      modernization_target: modernizationTarget(kind),
      effort_tier: effortTier(debtScore, m.stmts),
      priority_rank: priorityRank(rank),
      migration_complexity: migrationComplexity({ dyn_call_ratio: m.dyn_call_ratio, cyclomatic, nesting: m.nesting, debt: debtScore, kind }),
      wave: waves.get(object) ?? 0,
      dependencies: [...(deps.get(object) ?? [])].sort(),
      transformation_count: transformations.length,
      transformations,
    });
  }
  // Transport-safe order: stable sort by (transport rank, object name).
  objects.sort((a, b) => transportRank(a.kind) - transportRank(b.kind) || (a.object < b.object ? -1 : a.object > b.object ? 1 : 0));
  const wave_count = objects.reduce((mx, o) => Math.max(mx, o.wave + 1), 0);
  return { objects, summary: { ...summarize(objects), wave_count } };
}

/**
 * Per plan object, the OTHER plan objects it depends on (customer→customer edges).
 * @param {{nodes?: object[], edges?: object[]}} g
 * @param {Set<string>} planObjects
 * @returns {Map<string, Set<string>>} object -> its plan-object dependencies
 */
function dependenciesByObject(g, planObjects) {
  const owner = new Map((g?.nodes ?? []).map((n) => [n.id, n.object]));
  const deps = new Map();
  for (const e of g?.edges ?? []) {
    const s = owner.get(e.source) ?? e.source;
    const t = owner.get(e.target) ?? e.target;
    if (s === t || !planObjects.has(s) || !planObjects.has(t)) continue;
    if (!deps.has(s)) deps.set(s, new Set());
    deps.get(s).add(t);
  }
  return deps;
}

/**
 * Modernization waves — the dependency-order batching preview: wave 0 = objects
 * with no plan dependencies (safe to build first), wave N = 1 + max dependency
 * wave. Memoized DFS with a back-edge guard so a dependency cycle degrades to the
 * leaf level rather than looping (the moderniser refines this with SCC condensation
 * at execution). Deterministic over the pre-sorted unit order.
 * @param {Array<{object: string}>} units
 * @param {Map<string, Set<string>>} deps
 * @returns {Map<string, number>} object -> wave index
 */
function topologicalWaves(units, deps) {
  const wave = new Map();
  const visiting = new Set();
  const compute = (obj) => {
    if (wave.has(obj)) return wave.get(obj);
    if (visiting.has(obj)) return 0; // back-edge (cycle) — break rather than loop
    visiting.add(obj);
    let w = 0;
    for (const d of deps.get(obj) ?? []) w = Math.max(w, compute(d) + 1);
    visiting.delete(obj);
    wave.set(obj, w);
    return w;
  };
  for (const u of units) compute(u.object);
  return wave;
}

/**
 * Distinct customer compilation-unit objects with their kind + rank. Iteration is
 * over the pre-sorted node array, so first-seen kind is deterministic; rank is the
 * max across the object's nodes (its compilation-unit node carries the rank).
 * @param {object[]} nodes
 * @returns {Array<{object: string, kind: string, rank: number}>}
 */
function customerUnits(nodes) {
  const byObject = new Map();
  for (const n of nodes) {
    if (!CUSTOMER_NS.has(n.namespace) || !PLAN_KINDS.has(n.kind)) continue;
    const cur = byObject.get(n.object);
    if (!cur) byObject.set(n.object, { object: n.object, kind: n.kind, rank: n.rank ?? 0 });
    else cur.rank = Math.max(cur.rank, n.rank ?? 0);
  }
  return [...byObject.values()];
}

/** @param {import("@abaplint/core").Registry} reg @returns {Map<string, number>} object -> worst method McCabe */
function maxCyclomaticByObject(reg) {
  const m = new Map();
  for (const c of methodCyclomatic(reg)) m.set(c.object, Math.max(m.get(c.object) ?? 0, c.cyclomatic));
  return m;
}

/**
 * Per-object transformation work-list from the modernization-family findings.
 * released_successor is the structured target API from the oracle (not parsed
 * from the message). Findings are pre-sorted, so per-object order is deterministic.
 * @param {object[]} findings
 * @param {{getSuccessor?: (name: string) => (string|undefined)}} cloud
 * @returns {Map<string, object[]>}
 */
function groupTransformations(findings, cloud) {
  const byObject = new Map();
  for (const f of findings ?? []) {
    if (!isTransformation(f) || !f.object) continue;
    if (!byObject.has(f.object)) byObject.set(f.object, []);
    byObject.get(f.object).push({
      kind: f.family,
      rule_id: f.rule_id ?? null,
      why: f.message ?? null,
      fix: f.suggestion ?? null,
      released_successor: f.referenced_object && cloud?.getSuccessor ? (cloud.getSuccessor(f.referenced_object) ?? null) : null,
    });
  }
  return byObject;
}

/** @param {object[]} objects @returns {object} plan roll-up */
function summarize(objects) {
  const by_effort = { S: 0, M: 0, L: 0, XL: 0 };
  const by_priority = { P1: 0, P2: 0, P3: 0 };
  for (const o of objects) {
    by_effort[o.effort_tier] += 1;
    by_priority[o.priority_rank] += 1;
  }
  return { total_objects: objects.length, by_effort, by_priority, transport_order: objects.map((o) => o.object) };
}
