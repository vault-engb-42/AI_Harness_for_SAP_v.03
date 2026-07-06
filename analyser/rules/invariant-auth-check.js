import { ABAPObject, Statements } from "@abaplint/core";
import { objectsOf } from "../src/abaplint-loader.js";

/**
 * P4 invariant rule — AUTHORITY-CHECK must be followed by a SY-SUBRC check.
 *
 * The harness treats AUTHORITY-CHECK gates as immutable (P4): SY-SUBRC must be
 * evaluated after every AUTHORITY-CHECK, or the gate is toothless. This DETECTS
 * the violation in scanned brownfield code (distinct from the pre-write hook,
 * which PREVENTS it on write). priority-1 HARD.
 */

const LOOKAHEAD = 3;

/**
 * @param {import("@abaplint/core").StatementNode[]} stmts
 * @param {number} i index of the AUTHORITY-CHECK statement
 * @returns {boolean} true if sy-subrc is referenced within LOOKAHEAD statements
 */
function subrcCheckedAfter(stmts, i) {
  for (let j = i + 1; j <= i + LOOKAHEAD && j < stmts.length; j++) {
    if (/sy-subrc/i.test(stmts[j].concatTokens())) return true;
  }
  return false;
}

export const invariantAuthCheckRule = {
  id: "invariant-authority-check-subrc",
  family: "invariant",
  verdict: "HARD",
  /**
   * @param {import("../src/rule-engine.js").AnalysisContext} ctx
   * @returns {object[]}
   */
  check(ctx) {
    const findings = [];
    for (const obj of objectsOf(ctx.reg)) {
      if (!(obj instanceof ABAPObject)) continue;
      for (const file of obj.getABAPFiles()) {
        const stmts = file.getStatements();
        for (let i = 0; i < stmts.length; i++) {
          if (!(stmts[i].get() instanceof Statements.AuthorityCheck)) continue;
          if (subrcCheckedAfter(stmts, i)) continue;
          findings.push({
            severity: "priority-1",
            object: obj.getName(),
            object_type: obj.getType(),
            file: file.getFilename(),
            line: stmts[i].getFirstToken().getStart().getRow(),
            message: "AUTHORITY-CHECK not followed by a SY-SUBRC check within 3 statements (P4 invariant)",
            family: "invariant",
          });
        }
      }
    }
    return findings;
  },
};
