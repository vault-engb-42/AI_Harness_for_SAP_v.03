import { ABAPObject } from "@abaplint/core";
import { objectsOf } from "../src/abaplint-loader.js";

/**
 * Statement-AST rule pack — coded checks over the statement stream that the
 * regex pack cannot express (multi-line statements, loop context, lookback):
 *   - IN_LOOP:          statement types flagged when executed inside a loop
 *   - IN_LOOP_PATTERNS: text/type patterns flagged only inside a loop
 *   - STATEMENT_PATTERNS: single-statement checks (multi-line-statement safe)
 *   - context rules:    guard-lookback (FAE / RAP MODIFY), sort-after-select,
 *                       repeated identical SELECT SINGLE per file
 *
 * Loop nesting is a depth counter over LOOP/WHILE/DO/SELECT..ENDSELECT.
 * Findings surface their own rule_id/family (TALOS code in the message).
 */

const LOOP_OPEN = new Set(["Loop", "While", "Do", "SelectLoop"]);
const LOOP_CLOSE = new Set(["EndLoop", "EndWhile", "EndDo", "EndSelect"]);

/** statement constructor name -> finding spec when seen inside a loop. */
const IN_LOOP = {
  Select: { id: "talos-select-in-loop", family: "performance", severity: "priority-1", message: "SELECT inside LOOP causes N+1 database round-trips; batch-read before the loop (ABAP-N1)" },
  SelectLoop: { id: "talos-select-in-loop", family: "performance", severity: "priority-1", message: "Nested SELECT ... ENDSELECT inside a LOOP causes N+1 database round-trips (ABAP-N1)" },
  InsertDatabase: { id: "talos-dml-in-loop", family: "performance", severity: "priority-2", message: "Database INSERT inside LOOP; collect rows and INSERT ... FROM TABLE once (ABAP-PERF-69)" },
  UpdateDatabase: { id: "talos-dml-in-loop", family: "performance", severity: "priority-2", message: "Database UPDATE inside LOOP; use a set-based update (ABAP-PERF-69)" },
  ModifyDatabase: { id: "talos-dml-in-loop", family: "performance", severity: "priority-2", message: "Database MODIFY inside LOOP; use MODIFY ... FROM TABLE (ABAP-PERF-69)" },
  DeleteDatabase: { id: "talos-dml-in-loop", family: "performance", severity: "priority-2", message: "Database DELETE inside LOOP; use a set-based delete (ABAP-PERF-69)" },
  ModifyEntities: { id: "talos-rap-modify-in-loop", family: "rap-odata", severity: "priority-1", message: "RAP MODIFY ENTITIES inside LOOP; pass the full instance table in one call (ABAP-PERF-11)" },
  CommitEntities: { id: "talos-rap-commit-in-loop", family: "rap-odata", severity: "priority-1", message: "RAP COMMIT ENTITIES inside LOOP; commit once after the loop (ABAP-PERF-11)" },
  Commit: { id: "talos-commit-in-loop", family: "performance", severity: "priority-1", message: "COMMIT WORK inside LOOP; commit once per logical unit of work" },
};

/** text/type patterns flagged only inside a loop. `stmts` and `re` AND together. */
const IN_LOOP_PATTERNS = [
  { id: "talos-sync-http-in-loop", family: "performance", severity: "priority-1", re: /\w+->\s*(?:send|receive)\s*\(/i, message: "Synchronous HTTP send/receive inside LOOP; batch or dispatch asynchronously (ABAP-PERF-16)" },
  { id: "talos-free-in-loop", family: "performance", severity: "priority-2", re: /^FREE\b/i, message: "FREE inside LOOP deallocates capacity every iteration; use CLEAR/REFRESH outside the loop (ABAP-PERF-45)" },
  { id: "talos-itab-fulltable-op-in-loop", family: "performance", severity: "priority-2", stmts: ["Sort"], message: "Whole-table SORT inside LOOP is O(n²); sort once after the loop (ABAP-PERF-66)" },
  { id: "talos-itab-fulltable-op-in-loop", family: "performance", severity: "priority-2", stmts: ["DeleteInternal"], re: /\b(?:ADJACENT\s+DUPLICATES|WHERE)\b/i, message: "Whole-table DELETE inside LOOP is O(n²); restructure the loop (ABAP-PERF-66)" },
  { id: "talos-window-function-candidate", family: "performance", severity: "priority-2", re: /^(\w+)\s*=\s*\1\s*[+-]/i, message: "Running total/counter computed per row in an ABAP loop; SQL window function or CDS aggregation candidate (ABAP-PERF-36)" },
  { id: "talos-assign-component-in-loop", family: "performance", severity: "info", re: /^ASSIGN\s+COMPONENT\b/i, message: "ASSIGN COMPONENT inside a loop does per-iteration RTTI lookup; resolve the component once before the loop (ABAP-PERF-46)" },
  { id: "talos-scalar-fn-in-loop", family: "performance", severity: "priority-2", re: /CALL\s+FUNCTION\s+'(?:CONVERT_TO_LOCAL_CURRENCY|CONVERT_TO_FOREIGN_CURRENCY|UNIT_CONVERSION_SIMPLE|CURRENCY_CONVERSION|FISCAL_\w+)'/i, message: "HANA scalar function reimplemented per row via CALL FUNCTION in a loop; push down to CDS/AMDP (ABAP-PERF-35)" },
];

/** single-statement checks, any depth. `re` must match; `notRe` must NOT. */
const STATEMENT_PATTERNS = [
  { id: "talos-enqueue-no-wait", family: "performance", severity: "priority-1", stmts: ["CallFunction"], re: /CALL\s+FUNCTION\s+'ENQUEUE_/i, notRe: /_WAIT/i, message: "ENQUEUE_* without a bounded _WAIT parameter risks unbounded lock wait (ABAP-PERF-33)" },
  { id: "talos-endselect-no-package-size", family: "performance", severity: "priority-2", stmts: ["SelectLoop"], notRe: /PACKAGE\s+SIZE/i, message: "SELECT ... ENDSELECT without PACKAGE SIZE does single-row round-trips (ABAP-PERF-56)" },
  { id: "talos-select-single-no-where", family: "performance", severity: "priority-2", stmts: ["Select"], re: /^SELECT\s+SINGLE\b/i, notRe: /\bWHERE\b/i, message: "SELECT SINGLE without a WHERE clause reads an arbitrary row; constrain the full key (ABAP-PERF-58)" },
];

const FAE_RE = /FOR\s+ALL\s+ENTRIES\s+IN\s+@?(\w+)/i;
const MODIFY_WITH_RE = /\bWITH\s+@?(\w+)/i;
const GUARD_LOOKBACK = 6;

export const statementPack = {
  id: "statement-pack",
  family: "statement-pack",
  verdict: "WARN",
  /**
   * @param {import("../src/rule-engine.js").AnalysisContext} ctx
   * @returns {object[]}
   */
  check(ctx) {
    const findings = [];
    for (const obj of objectsOf(ctx.reg)) {
      if (!(obj instanceof ABAPObject)) continue;
      for (const file of obj.getABAPFiles()) {
        scanStatements(file, obj, findings);
      }
    }
    return findings;
  },
};

function scanStatements(file, obj, findings) {
  const stmts = file.getStatements();
  const selectSingleCounts = new Map();
  let depth = 0;
  for (let i = 0; i < stmts.length; i++) {
    const name = stmts[i].get()?.constructor?.name;
    const text = stmts[i].concatTokens();

    // Check target BEFORE adjusting depth: a top-level SELECT..ENDSELECT is not
    // "inside a loop"; a nested one (depth > 0) is.
    if (depth > 0) {
      if (IN_LOOP[name]) push(findings, IN_LOOP[name], obj, file, stmts[i]);
      matchPatterns(IN_LOOP_PATTERNS, name, text, findings, obj, file, stmts[i]);
    }
    matchPatterns(STATEMENT_PATTERNS, name, text, findings, obj, file, stmts[i]);

    if (name === "Select" || name === "SelectLoop") {
      checkGuard(stmts, i, FAE_RE, "talos-fae-no-guard", "SELECT ... FOR ALL ENTRIES on %D% without a preceding IS NOT INITIAL guard (an empty driver reads the whole table) (ABAP-PERF-13)", obj, file, findings);
      countSelectSingle(text, stmts[i], selectSingleCounts);
    }
    if (name === "ModifyEntities") {
      checkGuard(stmts, i, MODIFY_WITH_RE, "talos-rap-modify-no-guard", "MODIFY ENTITIES on %D% without a preceding IS NOT INITIAL guard on the input collection (ABAP-PERF-12)", obj, file, findings);
    }
    if (name === "Sort") {
      checkSortAfterSelect(stmts, i, text, obj, file, findings);
    }

    if (LOOP_OPEN.has(name)) depth++;
    else if (LOOP_CLOSE.has(name)) depth = Math.max(0, depth - 1);
  }
  reportRepeatedSelects(selectSingleCounts, obj, file, findings);
}

/** Apply a pattern table to one statement. */
function matchPatterns(patterns, name, text, findings, obj, file, st) {
  for (const p of patterns) {
    if (p.stmts && !p.stmts.includes(name)) continue;
    if (p.re && !p.re.test(text)) continue;
    if (p.notRe && p.notRe.test(text)) continue;
    if (!p.stmts && !p.re) continue;
    push(findings, p, obj, file, st);
  }
}

/**
 * Flag a statement whose driver table (captured by `capRe`) is not proven
 * non-empty by a preceding IS NOT INITIAL / lines( ) check.
 */
function checkGuard(stmts, i, capRe, id, messageTpl, obj, file, findings) {
  const m = capRe.exec(stmts[i].concatTokens());
  if (!m) return;
  const driver = m[1].toUpperCase();
  for (let j = i - 1; j >= Math.max(0, i - GUARD_LOOKBACK); j--) {
    const t = stmts[j].concatTokens().toUpperCase();
    if (t.includes(driver) && (t.includes("IS NOT INITIAL") || t.includes("LINES("))) return;
  }
  push(
    findings,
    { rule_id: id, id, family: id.includes("rap") ? "rap-odata" : "performance", severity: "priority-1", message: messageTpl.replace("%D%", driver) },
    obj,
    file,
    stmts[i]
  );
}

/** PERF-3: SORT <itab> right after a SELECT ... INTO TABLE <itab> lacking ORDER BY. */
function checkSortAfterSelect(stmts, i, text, obj, file, findings) {
  const m = /^SORT\s+(\w+)/i.exec(text);
  if (!m) return;
  const target = m[1].toUpperCase();
  for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
    const t = stmts[j].concatTokens().toUpperCase();
    if (stmts[j].get()?.constructor?.name === "Select" && t.includes("INTO TABLE") && t.includes(target)) {
      if (!t.includes("ORDER BY")) {
        push(findings, { id: "talos-client-sort-after-select", family: "performance", severity: "priority-2", message: `client-side SORT of ${target} right after its SELECT; add ORDER BY to push sorting to the database (ABAP-PERF-3)` }, obj, file, stmts[i]);
      }
      return;
    }
  }
}

/** HARDY-11: count identical SELECT SINGLE (normalized: INTO clause stripped). */
function countSelectSingle(text, st, counts) {
  if (!/^SELECT\s+SINGLE\b/i.test(text)) return;
  const key = text.toUpperCase().replace(/\bINTO\b.*?(?=\bWHERE\b|$)/s, " ").replace(/\s+/g, " ").trim();
  const rec = counts.get(key) ?? { n: 0, st };
  rec.n++;
  counts.set(key, rec);
}

function reportRepeatedSelects(counts, obj, file, findings) {
  for (const rec of counts.values()) {
    if (rec.n >= 3) {
      push(findings, { id: "talos-repeated-select-single", family: "performance", severity: "priority-2", message: `identical SELECT SINGLE repeated ${rec.n}x in this source; read once and cache (HARDY-11)` }, obj, file, rec.st);
    }
  }
}

function push(findings, spec, obj, file, st) {
  findings.push({
    rule_id: spec.id,
    severity: spec.severity,
    object: obj.getName(),
    object_type: obj.getType(),
    file: file.getFilename(),
    line: st.getFirstToken()?.getStart()?.getRow?.() ?? 0,
    message: spec.message,
    family: spec.family,
  });
}
