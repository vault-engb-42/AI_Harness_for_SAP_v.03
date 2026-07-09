import { CyclomaticComplexityStats, Structures, Statements, Expressions } from "@abaplint/core";
import { objectsOf } from "./abaplint-loader.js";

/**
 * Pure AST-derived complexity + cohesion metrics for code_health.clarity (arch
 * spec §3.C). Deterministic functions of a parsed abaplint Registry — no I/O, no
 * volatile state. Also the reuse point for the future `debt` dimension's
 * `complexity` + `lcom_score` signals (§3.C debt / reference §5).
 */

const nameOf = (obj) => obj.getName();
const byObjectThen = (key) => (a, b) =>
  a.object < b.object ? -1 : a.object > b.object ? 1 : a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0;

/**
 * McCabe cyclomatic complexity per method: abaplint's own branch-statement count
 * (b) PLUS ONE (the spec's "cyclomatic b+1"). We reuse @abaplint/core's
 * CyclomaticComplexityStats so our branch set is byte-identical to the engine
 * that raises `cyclomatic_complexity` at b>20 (the "abaplint max=20" contract) —
 * its set is {Assert, Check, If, ElseIf, While, Case, SelectLoop, Catch,
 * Cleanup, EndAt, Loop}; DO and DATA are NOT branches. abaplint reports methods
 * only (not FORMs / event blocks), a limitation we inherit deliberately.
 *
 * @param {import("@abaplint/core").Registry} reg
 * @returns {Array<{object: string, method: string, cyclomatic: number}>} sorted (object, method)
 */
export function methodCyclomatic(reg) {
  const out = [];
  for (const obj of objectsOf(reg)) {
    const object = nameOf(obj);
    // CyclomaticComplexityStats.run guards `instanceof ABAPObject` and returns []
    // for DDIC/CDS objects, so no type check is needed here.
    for (const s of CyclomaticComplexityStats.run(obj)) {
      out.push({ object, method: String(s.name ?? "").toUpperCase(), cyclomatic: s.count + 1 });
    }
  }
  return out.sort(byObjectThen("method"));
}

/**
 * Henderson-Sellers LCOM* per (non-test) class: `(m - (1/a)·Σ μ(f)) / (m - 1)`,
 * where m = implemented methods, a = declared attributes, μ(f) = methods
 * referencing attribute f. 0 = every method touches every attribute (cohesive);
 * 1 = disjoint. Undefined for m≤1 or a=0 (trivially cohesive) -> 0; clamped to
 * [0,1] (unused attributes can push the raw value past 1). Attribute access is
 * detected by token membership in the method body — a deterministic
 * approximation (a local variable shadowing an attribute name over-counts).
 * FOR TESTING classes are excluded (test cohesion is not production health).
 *
 * @param {import("@abaplint/core").Registry} reg
 * @returns {Array<{object: string, lcom: number, methods: number, attributes: number}>} sorted by class
 */
export function classCohesion(reg) {
  const out = [];
  for (const obj of objectsOf(reg)) {
    const { implMap, defs } = collectClassInfo(obj);
    for (const cd of defs) {
      if (cd.isForTesting) continue;
      out.push(lcomForClass(cd, implMap.get(String(cd.name).toUpperCase()) ?? new Map()));
    }
  }
  return out.sort((a, b) => (a.object < b.object ? -1 : a.object > b.object ? 1 : 0));
}

/**
 * Gather, across ALL of an object's ABAP files, the class definitions and the
 * per-class method-body token sets (definition and implementation may live in
 * different includes, so this is object-wide, not per-file).
 * @param {import("@abaplint/core").IObject} obj
 * @returns {{implMap: Map<string, Map<string, Set<string>>>, defs: object[]}}
 */
function collectClassInfo(obj) {
  const implMap = new Map();
  const defs = [];
  for (const file of obj.getABAPFiles?.() ?? []) {
    const struct = file.getStructure?.();
    if (struct) {
      for (const ci of struct.findAllStructures(Structures.ClassImplementation)) {
        const cname = structName(ci, Statements.ClassImplementation, Expressions.ClassName);
        if (cname) implMap.set(cname, methodTokenSets(ci));
      }
    }
    for (const cd of file.getInfo?.().listClassDefinitions() ?? []) defs.push(cd);
  }
  return { implMap, defs };
}

/**
 * @param {object} ci a ClassImplementation structure
 * @returns {Map<string, Set<string>>} method name (upper) -> its body token set (upper)
 */
function methodTokenSets(ci) {
  const methods = new Map();
  for (const m of ci.findAllStructures(Structures.Method)) {
    const mname = structName(m, Statements.MethodImplementation, Expressions.MethodName);
    if (!mname) continue;
    const toks = new Set();
    for (const sn of m.findAllStatementNodes()) {
      for (const t of sn.getTokens()) toks.add(t.getStr().toUpperCase());
    }
    methods.set(mname, toks);
  }
  return methods;
}

/**
 * @param {object} cd an InfoClassDefinition
 * @param {Map<string, Set<string>>} methodTokens implemented methods -> token sets
 * @returns {{object: string, lcom: number, methods: number, attributes: number}}
 */
function lcomForClass(cd, methodTokens) {
  const object = String(cd.name).toUpperCase();
  const attrs = (cd.attributes ?? []).map((a) => String(a.name).toUpperCase());
  const m = methodTokens.size;
  const a = attrs.length;
  if (m <= 1 || a === 0) return { object, lcom: 0, methods: m, attributes: a };
  let sumMu = 0;
  for (const f of attrs) {
    for (const toks of methodTokens.values()) if (toks.has(f)) sumMu += 1;
  }
  const raw = (m - sumMu / a) / (m - 1);
  return { object, lcom: clamp01(raw), methods: m, attributes: a };
}

/**
 * @param {object} struct a structure node
 * @param {Function} stmt the direct statement class to descend into
 * @param {Function} expr the name expression class
 * @returns {string|undefined} the upper-cased name token, if present
 */
function structName(struct, stmt, expr) {
  const tok = struct.findDirectStatement(stmt)?.findDirectExpression(expr)?.getFirstToken();
  return tok ? tok.getStr().toUpperCase() : undefined;
}

/** @param {number} x @returns {number} x clamped to [0,1] */
function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
