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
 * FOR TESTING methods (the .clas.testclasses include) are excluded so this axis
 * measures the same production population as classCohesion — otherwise trivial
 * ABAP Unit tests would dilute a complex method's penalty and inflate clarity.
 *
 * @param {import("@abaplint/core").Registry} reg
 * @returns {Array<{object: string, method: string, cyclomatic: number}>} sorted (object, method)
 */
export function methodCyclomatic(reg) {
  const out = [];
  for (const obj of objectsOf(reg)) {
    const object = nameOf(obj);
    const testFile = obj.getTestclassFile?.()?.getFilename();
    // CyclomaticComplexityStats.run guards `instanceof ABAPObject` and returns []
    // for DDIC/CDS objects, so no type check is needed here.
    for (const s of CyclomaticComplexityStats.run(obj)) {
      if (testFile && s.file?.getFilename?.() === testFile) continue;
      out.push({ object, method: String(s.name ?? "").toUpperCase(), cyclomatic: s.count + 1 });
    }
  }
  return out.sort(byObjectThen("method"));
}

// abaplint's cyclomatic branch statements (CyclomaticComplexityStats set), reused
// to score FORMs / function modules that its method-only stats skip.
const BRANCH_STATEMENTS = ["Assert", "Check", "If", "ElseIf", "While", "Case", "SelectLoop", "Catch", "Cleanup", "EndAt", "Loop"];

/**
 * Cyclomatic complexity per ROUTINE — methods (via abaplint) PLUS FORMs and
 * function modules (abaplint's method-only stats skip these, verified, so this is
 * purely additive — no double count). A FORM/FM routine's cyclomatic = 1 + count
 * of branch statements in its body. This closes the clarity blind spot where
 * FORM/report-heavy legacy code scored a misleading 100 (op observation 1a).
 * Production only (test include excluded), matching methodCyclomatic.
 *
 * @param {import("@abaplint/core").Registry} reg
 * @returns {Array<{object: string, cyclomatic: number}>} sorted by (object, cyclomatic)
 */
export function routineComplexity(reg) {
  const branchCtors = BRANCH_STATEMENTS.map((n) => Statements[n]).filter(Boolean);
  const out = methodCyclomatic(reg).map((m) => ({ object: m.object, cyclomatic: m.cyclomatic }));
  for (const obj of objectsOf(reg)) {
    const object = nameOf(obj);
    const testFile = obj.getTestclassFile?.()?.getFilename();
    for (const file of obj.getABAPFiles?.() ?? []) {
      if (file.getFilename() === testFile) continue;
      const struct = file.getStructure?.();
      if (!struct) continue;
      for (const Ctor of [Structures.Form, Structures.FunctionModule]) {
        for (const routine of struct.findAllStructures(Ctor)) {
          let branches = 0;
          for (const sn of routine.findAllStatementNodes()) if (branchCtors.some((C) => sn.get() instanceof C)) branches += 1;
          out.push({ object, cyclomatic: branches + 1 });
        }
      }
    }
  }
  return out.sort((a, b) => (a.object < b.object ? -1 : a.object > b.object ? 1 : a.cyclomatic - b.cyclomatic));
}

/**
 * Per object: the max and total line-span of its routine structures (method /
 * FORM / function module, span inclusive of the opening..closing statement). The
 * PER-ROUTINE length signal for code_health.clarity — a per-object average would
 * dilute one 200-line monolith among short routines, so the caller uses `max`.
 * `sum` lets the caller recover a program's event-block body (total LOC − sum),
 * which lives outside any routine structure and would otherwise be invisible.
 * Production only.
 * @param {import("@abaplint/core").Registry} reg
 * @returns {Map<string, {max: number, sum: number}>} object name -> routine LOC stats
 */
export function routineLengths(reg) {
  const out = new Map();
  for (const obj of objectsOf(reg)) {
    const testFile = obj.getTestclassFile?.()?.getFilename();
    let max = 0;
    let sum = 0;
    for (const file of obj.getABAPFiles?.() ?? []) {
      if (file.getFilename() === testFile) continue;
      const struct = file.getStructure?.();
      if (!struct) continue;
      for (const Ctor of [Structures.Method, Structures.Form, Structures.FunctionModule]) {
        for (const routine of struct.findAllStructures(Ctor)) {
          const loc = structLoc(routine);
          max = Math.max(max, loc);
          sum += loc;
        }
      }
    }
    out.set(obj.getName(), { max, sum });
  }
  return out;
}

/** @param {object} node a structure node @returns {number} inclusive line span of its statements */
function structLoc(node) {
  let min = Infinity;
  let max = -Infinity;
  for (const sn of node.findAllStatementNodes()) {
    for (const t of sn.getTokens()) {
      const r = t.getStart().getRow();
      if (r < min) min = r;
      if (r > max) max = r;
    }
  }
  return max >= min ? max - min + 1 : 0;
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
 * Per compilation-unit object: physical LOC and routine count (methods + FORMs +
 * function modules). Production only — the `.clas.testclasses` include is
 * excluded (mirrors methodCyclomatic), so test code never inflates size/density.
 * Inputs for the tech-debt size_ratio / function_density / avg_function_length
 * signals.
 * @param {import("@abaplint/core").Registry} reg
 * @returns {Array<{object: string, loc: number, routines: number}>} sorted by object
 */
export function sizeMetrics(reg) {
  const out = [];
  for (const obj of objectsOf(reg)) {
    const testFile = obj.getTestclassFile?.()?.getFilename();
    let loc = 0;
    let routines = 0;
    for (const file of obj.getABAPFiles?.() ?? []) {
      if (file.getFilename() === testFile) continue; // production only
      loc += file.getRawRows().length;
      const st = file.getStructure?.();
      if (!st) continue;
      routines +=
        st.findAllStructures(Structures.Method).length +
        st.findAllStructures(Structures.Form).length +
        st.findAllStructures(Structures.FunctionModule).length;
    }
    out.push({ object: nameOf(obj), loc, routines });
  }
  return out.sort((a, b) => (a.object < b.object ? -1 : a.object > b.object ? 1 : 0));
}

/**
 * Martin abstractness A per object, for the main-sequence distance in
 * code_health.stability. An interface is fully abstract (A=1); a class's A is
 * its fraction of abstract methods (a concrete class -> 0, a fully deferred
 * class -> 1); every other object kind is concrete (A=0, so it is not keyed
 * here and callers default to 0). FOR TESTING classes are excluded, matching
 * classCohesion.
 * @param {import("@abaplint/core").Registry} reg
 * @returns {Map<string, number>} object name (upper) -> A in [0,1]
 */
export function abstractnessByObject(reg) {
  const map = new Map();
  for (const obj of objectsOf(reg)) {
    for (const file of obj.getABAPFiles?.() ?? []) {
      const info = file.getInfo?.();
      if (!info) continue;
      for (const cd of info.listClassDefinitions?.() ?? []) {
        if (cd.isForTesting) continue;
        const methods = cd.methods ?? [];
        const abstractCount = methods.filter((m) => m.isAbstract).length;
        map.set(String(cd.name).toUpperCase(), methods.length ? abstractCount / methods.length : 0);
      }
      for (const id of info.listInterfaceDefinitions?.() ?? []) {
        map.set(String(id.name).toUpperCase(), 1);
      }
    }
  }
  return map;
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
