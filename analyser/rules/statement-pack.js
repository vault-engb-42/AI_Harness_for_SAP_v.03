import { ABAPObject } from "@abaplint/core";
import { objectsOf } from "../src/abaplint-loader.js";

/**
 * Statement-AST rule pack — coded checks over the statement stream that the
 * regex pack cannot express. Covers the high-value TALOS performance cluster:
 *   - DB/RAP/COMMIT statements executed inside a LOOP (N+1 / chatty writes)
 *   - SELECT ... FOR ALL ENTRIES without a preceding IS NOT INITIAL guard
 *
 * Loop nesting is tracked with a depth counter over LOOP/WHILE/DO/SELECT..
 * ENDSELECT. Findings surface their own rule_id/family.
 */

const LOOP_OPEN = new Set(["Loop", "While", "Do", "SelectLoop"]);
const LOOP_CLOSE = new Set(["EndLoop", "EndWhile", "EndDo", "EndSelect"]);

/** statement constructor name -> finding spec when seen inside a loop. */
const IN_LOOP = {
  Select: { id: "talos-select-in-loop", family: "performance", severity: "priority-1", message: "SELECT inside LOOP causes N+1 database round-trips; batch-read before the loop" },
  SelectLoop: { id: "talos-select-in-loop", family: "performance", severity: "priority-1", message: "Nested SELECT ... ENDSELECT inside a LOOP causes N+1 database round-trips" },
  InsertDatabase: { id: "talos-dml-in-loop", family: "performance", severity: "priority-2", message: "Database INSERT inside LOOP; collect rows and INSERT ... FROM TABLE once" },
  UpdateDatabase: { id: "talos-dml-in-loop", family: "performance", severity: "priority-2", message: "Database UPDATE inside LOOP; use a set-based update" },
  ModifyDatabase: { id: "talos-dml-in-loop", family: "performance", severity: "priority-2", message: "Database MODIFY inside LOOP; use MODIFY ... FROM TABLE" },
  DeleteDatabase: { id: "talos-dml-in-loop", family: "performance", severity: "priority-2", message: "Database DELETE inside LOOP; use a set-based delete" },
  ModifyEntities: { id: "talos-rap-modify-in-loop", family: "rap-odata", severity: "priority-1", message: "RAP MODIFY ENTITIES inside LOOP; pass the full instance table in one call" },
  CommitEntities: { id: "talos-rap-commit-in-loop", family: "rap-odata", severity: "priority-1", message: "RAP COMMIT ENTITIES inside LOOP; commit once after the loop" },
  Commit: { id: "talos-commit-in-loop", family: "performance", severity: "priority-1", message: "COMMIT WORK inside LOOP; commit once per logical unit of work" },
};

const FAE_RE = /FOR\s+ALL\s+ENTRIES\s+IN\s+@?(\w+)/i;
const FAE_LOOKBACK = 6;

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
  let depth = 0;
  for (let i = 0; i < stmts.length; i++) {
    const name = stmts[i].get()?.constructor?.name;

    // Check target BEFORE adjusting depth: a top-level SELECT..ENDSELECT is not
    // "inside a loop"; a nested one (depth > 0) is.
    if (depth > 0 && IN_LOOP[name]) {
      push(findings, IN_LOOP[name], obj, file, stmts[i]);
    }
    if (name === "Select" || name === "SelectLoop") {
      checkFaeGuard(stmts, i, obj, file, findings);
    }

    if (LOOP_OPEN.has(name)) depth++;
    else if (LOOP_CLOSE.has(name)) depth = Math.max(0, depth - 1);
  }
}

/**
 * Flag a FOR ALL ENTRIES select whose driver table is not proven non-empty by a
 * preceding IS NOT INITIAL check (an empty driver silently reads the whole table).
 */
function checkFaeGuard(stmts, i, obj, file, findings) {
  const m = FAE_RE.exec(stmts[i].concatTokens());
  if (!m) return;
  const driver = m[1].toUpperCase();
  for (let j = i - 1; j >= Math.max(0, i - FAE_LOOKBACK); j--) {
    const t = stmts[j].concatTokens().toUpperCase();
    if (t.includes(driver) && t.includes("IS NOT INITIAL")) return; // guarded
  }
  push(
    findings,
    { id: "talos-fae-no-guard", family: "performance", severity: "priority-1", message: `SELECT ... FOR ALL ENTRIES on ${driver} without a preceding IS NOT INITIAL guard (an empty driver reads the whole table)` },
    obj,
    file,
    stmts[i]
  );
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
