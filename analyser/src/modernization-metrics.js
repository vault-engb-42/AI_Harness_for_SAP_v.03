import { Statements, Structures } from "@abaplint/core";
import { objectsOf } from "./abaplint-loader.js";

/**
 * Per-object AST inputs for the modernization plan (§3.D): total statement count,
 * dynamic CALL FUNCTION ratio, and max control-flow nesting depth. Pure,
 * deterministic functions of a parsed abaplint Registry — no I/O. Production
 * only: the .clas.testclasses include is excluded (mirrors ast-metrics.sizeMetrics)
 * so test code never inflates the effort/complexity inputs.
 *
 * Probe-grounded (verified against @abaplint/core, not assumed):
 *  - `file.getStatements().length` is the statement count;
 *  - a CALL FUNCTION whose name token is a string literal ('X' / `X`) is static,
 *    a bare identifier is dynamic;
 *  - only OPENING control structures add a nesting level — branch continuations
 *    (ELSE/ELSEIF/WHEN/CATCH/CLEANUP) are children of their opener in abaplint's
 *    structure tree, so counting them would double-count depth.
 */

const OPENING_KINDS = ["If", "Loop", "While", "Do", "Case", "Try", "At", "Provide", "SelectLoop"];

/**
 * @param {import("@abaplint/core").Registry} reg
 * @returns {Array<{object: string, stmts: number, dyn_call_ratio: number, nesting: number}>} sorted by object
 */
export function modernizationMetrics(reg) {
  const openingCtors = OPENING_KINDS.map((n) => Structures[n]).filter(Boolean);
  const out = [];
  for (const obj of objectsOf(reg)) {
    const testFile = obj.getTestclassFile?.()?.getFilename();
    let stmts = 0;
    let dyn = 0;
    let stat = 0;
    let nesting = 0;
    for (const file of obj.getABAPFiles?.() ?? []) {
      if (file.getFilename() === testFile) continue; // production only
      const statements = file.getStatements();
      stmts += statements.length;
      for (const st of statements) {
        if (!(st.get() instanceof Statements.CallFunction)) continue;
        if (isLiteralCall(st)) stat += 1;
        else dyn += 1;
      }
      const struct = file.getStructure?.();
      if (struct) nesting = Math.max(nesting, maxNesting(struct, 0, openingCtors));
    }
    const calls = dyn + stat;
    out.push({ object: obj.getName(), stmts, dyn_call_ratio: calls ? round3(dyn / calls) : 0, nesting });
  }
  return out.sort((a, b) => (a.object < b.object ? -1 : a.object > b.object ? 1 : 0));
}

/**
 * A CALL FUNCTION is STATIC iff its function-name token (the token after the
 * FUNCTION keyword) is a string literal. A bare identifier (variable) is dynamic.
 * @param {object} st a CallFunction statement node
 * @returns {boolean}
 */
function isLiteralCall(st) {
  const toks = st.getTokens();
  const fi = toks.findIndex((t) => t.getStr().toUpperCase() === "FUNCTION");
  const name = fi >= 0 ? (toks[fi + 1]?.getStr() ?? "") : "";
  return name.startsWith("'") || name.startsWith("`");
}

/**
 * Max nesting depth of OPENING control structures under a structure node.
 * @param {object} node a StructureNode
 * @param {number} depth current depth
 * @param {Function[]} openingCtors opening-structure constructors
 * @returns {number}
 */
function maxNesting(node, depth, openingCtors) {
  let best = depth;
  for (const child of node.getChildren?.() ?? []) {
    const runnable = child.get?.();
    const inc = runnable && openingCtors.some((C) => runnable instanceof C);
    best = Math.max(best, maxNesting(child, inc ? depth + 1 : depth, openingCtors));
  }
  return best;
}

const round3 = (x) => Math.round(x * 1000) / 1000;
