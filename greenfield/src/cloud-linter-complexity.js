import { ABAPObject } from "@abaplint/core";
import { lineOf } from "./cloud-linter-checks.js";

/**
 * Batch 5 — complexity + test-quality rules over the per-method statement stream.
 * The "parser beats regex" tier: REAL statement counts, REAL block nesting, and
 * PARSED method signatures — not TALOS's keyword-count / indentation heuristics.
 * Mirrors TALOS CLEAN-011..014 + 016..019.
 */

const METHOD_LEN = { warn: 40, err: 80 };
const CYCLO = { warn: 10, err: 20 };
const NEST = { warn: 4, err: 6 };
const PARAM = { warn: 3, err: 6 };
const ASSERTS = { warn: 3, err: 6 };
const CALLS = { warn: 3 };

const CYCLO_KINDS = new Set(["If", "ElseIf", "When", "While", "Do", "Loop", "Catch", "Check"]);
const NEST_OPEN = new Set(["If", "Loop", "Do", "While", "Case", "Try"]);
const NEST_CLOSE = new Set(["EndIf", "EndLoop", "EndDo", "EndWhile", "EndCase", "EndTry"]);
const ASSERT_RE = /\bCL_A(?:BAP_UNIT|UNIT)_ASSERT\b/i;
const CALL_RE = /->\w+\s*\(/g;
const NEW_PROD_RE = /\bNEW\s+z[ci]l_\w+\s*\(/i;
const SECTION_RE = /\b(?:EXPORTING|CHANGING|RETURNING|RAISING|EXCEPTIONS|PREFERRED\s+PARAMETER)\b/i;
const VISIBILITY_PUBLIC = 3;

/** @returns {"error"|"warning"|null} severity for a metric against a two-tier threshold */
function tier(value, t) {
  if (t.err !== undefined && value > t.err) return "error";
  if (value > t.warn) return "warning";
  return null;
}

/** @returns {number} IMPORTING parameter count declared in a MethodDef text */
function importingParamCount(text) {
  const m = /\bIMPORTING\b([\s\S]*)/i.exec(text);
  if (!m) return 0;
  const section = m[1].split(SECTION_RE)[0];
  return (section.match(/\w+\s+TYPE\b/gi) || []).length;
}

/** @returns {Set<string>} the FOR TESTING method names declared in a file */
function testMethodNames(stmts) {
  const set = new Set();
  for (const st of stmts) {
    if (st.get()?.constructor?.name !== "MethodDef") continue;
    const text = st.concatTokens();
    if (!/\bFOR\s+TESTING\b/i.test(text)) continue;
    const nm = /^METHODS\s+([\w~]+)/i.exec(text)?.[1]?.toUpperCase();
    if (nm) set.add(nm);
  }
  return set;
}

function mk(rule_id, severity, message, family, objName, objType, file, st) {
  return { rule_id, severity, object: objName, object_type: objType, file: file.getFilename(), line: lineOf(st), message, family };
}

/** CLEAN-012 — IMPORTING parameter count per method definition */
function paramFindings(stmts, objName, objType, file, findings) {
  for (const st of stmts) {
    if (st.get()?.constructor?.name !== "MethodDef") continue;
    const n = importingParamCount(st.concatTokens());
    const sev = tier(n, PARAM);
    if (sev) findings.push(mk("gf-cx-param-count", sev, `${n} IMPORTING parameters — a method with many inputs does too much; group them into a structure or split it`, "complexity", objName, objType, file, st));
  }
}

/** Emit the accumulated metrics for one method body on ENDMETHOD. */
function emitMethod(m, testMethods, objName, objType, file, findings) {
  const add = (id, sev, msg, fam) => sev && findings.push(mk(id, sev, msg, fam, objName, objType, file, m.st));
  add("gf-cx-method-length", tier(m.count, METHOD_LEN), `${m.count} statements in one method — extract cohesive steps into smaller methods`, "complexity");
  add("gf-cx-cyclomatic", tier(m.cyclo, CYCLO), `cyclomatic complexity ${m.cyclo} — too many decision paths; decompose the method`, "complexity");
  add("gf-cx-nesting-depth", tier(m.maxDepth, NEST), `block nesting depth ${m.maxDepth} — flatten with guard clauses / early returns`, "complexity");
  if (!(m.name && testMethods.has(m.name))) return;
  add("gf-test-assert-count", tier(m.asserts, ASSERTS), `${m.asserts} assertions in one test method — a test should verify one behavior; split it`, "test-quality");
  add("gf-test-too-many-calls", tier(m.calls, CALLS), `${m.calls} production calls in one test method — the test exercises too much; narrow its scope`, "test-quality");
  if (m.newProd > 0) add("gf-test-instantiates-prod", "warning", "test instantiates a production class directly (NEW zcl_…) — inject the dependency or use a released test double", "test-quality");
}

/** Walk each method body: statement count, cyclomatic, nesting, and test metrics. */
function bodyFindings(stmts, testMethods, objName, objType, file, findings) {
  let m = null;
  for (const st of stmts) {
    const kind = st.get()?.constructor?.name;
    if (kind === "MethodImplementation" || kind === "Method") {
      m = { name: /^METHOD\s+([\w~]+)/i.exec(st.concatTokens())?.[1]?.toUpperCase(), st, count: 0, cyclo: 1, depth: 0, maxDepth: 0, asserts: 0, calls: 0, newProd: 0 };
    } else if (kind === "EndMethod") {
      if (m) emitMethod(m, testMethods, objName, objType, file, findings);
      m = null;
    } else if (m) {
      m.count++;
      const text = st.concatTokens();
      if (CYCLO_KINDS.has(kind)) m.cyclo++;
      if (NEST_OPEN.has(kind)) m.maxDepth = Math.max(m.maxDepth, ++m.depth);
      else if (NEST_CLOSE.has(kind)) m.depth = Math.max(0, m.depth - 1);
      if (m.name && testMethods.has(m.name)) {
        if (ASSERT_RE.test(text)) m.asserts++;
        m.calls += (text.match(CALL_RE) || []).length;
        if (NEW_PROD_RE.test(text)) m.newProd++;
      }
    }
  }
}

/**
 * Per-file complexity + test-body metrics (CLEAN-011/012/013/014/016/017/018).
 * @param {string} objName @param {string} objType @param {import("@abaplint/core").ABAPFile} file
 * @returns {object[]}
 */
export function complexityFindings(objName, objType, file) {
  const findings = [];
  const stmts = file.getStatements?.() ?? [];
  const testMethods = testMethodNames(stmts);
  paramFindings(stmts, objName, objType, file, findings);
  bodyFindings(stmts, testMethods, objName, objType, file, findings);
  return findings;
}

/**
 * CLEAN-019 — public methods the class's test include never references. Cross-file
 * (class definition vs test include) — a whole-object negative regex cannot prove.
 * @param {import("@abaplint/core").IObject} obj
 * @returns {object[]}
 */
export function publicCoverageFindings(obj) {
  if (!(obj instanceof ABAPObject) || obj.getType?.() !== "CLAS") return [];
  const testFile = obj.getTestclassFile?.();
  const def = obj.getClassDefinition?.();
  if (!testFile || !def) return [];
  const publicMethods = (def.methods ?? [])
    .filter((mm) => Number(mm.visibility) === VISIBILITY_PUBLIC)
    .map((mm) => String(mm.name).toUpperCase())
    .filter((n) => !n.startsWith("CONSTRUCTOR"));
  if (!publicMethods.length) return [];
  const testRaw = (testFile.getRaw?.() ?? "").toUpperCase();
  const untested = publicMethods.filter((n) => !testRaw.includes(n));
  if (!untested.length) return [];
  return [{ rule_id: "gf-test-public-untested", severity: "warning", object: obj.getName(), object_type: "CLAS", file: testFile.getFilename(), line: 1, message: `public methods never referenced by the test class: ${untested.join(", ")} — behavior changes there are unguarded`, family: "test-quality" }];
}
