import { sizeMetrics, methodCyclomatic } from "./ast-metrics.js";
import { modernizationMetrics } from "./modernization-metrics.js";
import { objectsOf } from "./abaplint-loader.js";
import { nodeKindForObjectType } from "./node-kinds.js";

/**
 * Package-level codebase metrics for the Summary tab (operator request 2026-07-09):
 * total LOC, object/file counts by kind, customer-vs-SAP LOC split, TALOS size
 * class, avg/max cyclomatic, max control-flow nesting, duplication, and a
 * Maintainability Index. Pure + deterministic over the parsed registry + findings.
 *
 * The Maintainability Index is the SEI/Microsoft comment-adjusted formula, bounded
 * to 0-100; Halstead volume is token-derived (N·log2(vocabulary)) — an honest AST
 * approximation, so MI is an analyser-defined UX score (like code_health), not a
 * numeric oracle.
 */

const DUP_RULE_ID = "talos-duplicate-block";
const CUSTOMER_RE = /^[ZY]/i; // Z*/Y* object names are customer code (LOC split only)

/**
 * @param {object[]} findings curated findings (for the duplication signal)
 * @param {import("@abaplint/core").Registry} reg parsed registry
 * @returns {object} the metrics block
 */
export function computeMetrics(findings, reg) {
  const sizes = sizeMetrics(reg);
  const cycloMax = maxCyclomaticByObject(reg);
  const nesting = new Map(modernizationMetrics(reg).map((m) => [m.object, m.nesting]));
  const hal = halsteadAndComments(reg);
  const kindByObject = kindMap(reg);

  const agg = { total_loc: 0, customer_loc: 0, sap_loc: 0, comment_lines: 0, file_count: 0 };
  const by_kind = {};
  const miVals = [];
  const ccVals = [];
  let max_cyclomatic = 0;
  let max_nesting = 0;
  for (const s of sizes) {
    agg.total_loc += s.loc;
    if (CUSTOMER_RE.test(s.object)) agg.customer_loc += s.loc;
    else agg.sap_loc += s.loc;
    const kind = kindByObject.get(s.object) ?? "other";
    by_kind[kind] = (by_kind[kind] ?? 0) + 1;
    const cc = cycloMax.get(s.object) ?? 0;
    max_cyclomatic = Math.max(max_cyclomatic, cc);
    if (cc > 0) ccVals.push(cc);
    max_nesting = Math.max(max_nesting, nesting.get(s.object) ?? 0);
    const h = hal.get(s.object) ?? { volume: 0, commentLines: 0, totalLines: 0, files: 0 };
    agg.comment_lines += h.commentLines;
    agg.file_count += h.files;
    if (s.loc > 0) miVals.push(maintainabilityIndex(h.volume, cc, s.loc, h.commentLines, h.totalLines));
  }
  return {
    total_loc: agg.total_loc,
    file_count: agg.file_count,
    object_count: sizes.length,
    by_kind,
    customer_loc: agg.customer_loc,
    sap_loc: agg.sap_loc,
    size_class: sizeClass(agg.total_loc),
    avg_cyclomatic: ccVals.length ? round2(mean(ccVals)) : 0,
    max_cyclomatic,
    max_nesting,
    duplication_findings: (findings ?? []).filter((f) => f?.rule_id === DUP_RULE_ID).length,
    comment_ratio: agg.total_loc ? round3(agg.comment_lines / agg.total_loc) : 0,
    maintainability_index: miVals.length ? Math.round(mean(miVals)) : 100,
  };
}

/** TALOS size class by total LOC (scanner_graph_builder size thresholds). */
function sizeClass(loc) {
  if (loc > 10_000_000) return "XXL";
  if (loc > 1_000_000) return "XL";
  if (loc > 100_000) return "L";
  if (loc > 10_000) return "M";
  return "S";
}

/**
 * SEI/Microsoft comment-adjusted Maintainability Index, bounded to [0,100].
 * MI = max(0, min(100, (171 − 5.2·ln(V) − 0.23·CC − 16.2·ln(LOC) + 50·sin(√(2.4·CM))) · 100/171)).
 * @returns {number}
 */
function maintainabilityIndex(volume, cc, loc, commentLines, totalLines) {
  const V = Math.max(volume, 1);
  const L = Math.max(loc, 1);
  const CC = Math.max(cc, 1);
  const cm = totalLines > 0 ? commentLines / totalLines : 0;
  const raw = 171 - 5.2 * Math.log(V) - 0.23 * CC - 16.2 * Math.log(L) + 50 * Math.sin(Math.sqrt(2.4 * cm));
  return Math.max(0, Math.min(100, (raw * 100) / 171));
}

/**
 * Per production object: token-based Halstead length/vocabulary -> volume, plus
 * comment-line and total-line counts (comment = row starting with * or ").
 * @param {import("@abaplint/core").Registry} reg
 * @returns {Map<string, {volume: number, commentLines: number, totalLines: number, files: number}>}
 */
function halsteadAndComments(reg) {
  const out = new Map();
  for (const obj of objectsOf(reg)) {
    const testFile = obj.getTestclassFile?.()?.getFilename();
    let N = 0;
    let commentLines = 0;
    let totalLines = 0;
    let files = 0;
    const vocab = new Set();
    for (const file of obj.getABAPFiles?.() ?? []) {
      if (file.getFilename() === testFile) continue; // production only
      files += 1;
      for (const row of file.getRawRows()) {
        totalLines += 1;
        if (/^\s*[*"]/.test(row)) commentLines += 1;
      }
      for (const st of file.getStatements()) {
        for (const t of st.getTokens()) {
          N += 1;
          vocab.add(t.getStr().toUpperCase());
        }
      }
    }
    const n = vocab.size;
    const volume = N > 0 && n > 1 ? N * Math.log2(n) : 0;
    out.set(obj.getName(), { volume, commentLines, totalLines, files });
  }
  return out;
}

/** @param {import("@abaplint/core").Registry} reg @returns {Map<string, number>} object -> worst method McCabe */
function maxCyclomaticByObject(reg) {
  const m = new Map();
  for (const c of methodCyclomatic(reg)) m.set(c.object, Math.max(m.get(c.object) ?? 0, c.cyclomatic));
  return m;
}

/** @param {import("@abaplint/core").Registry} reg @returns {Map<string, string>} object -> CPG node kind */
function kindMap(reg) {
  const m = new Map();
  for (const obj of objectsOf(reg)) m.set(obj.getName(), nodeKindForObjectType(obj.getType?.()) ?? "other");
  return m;
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round2 = (x) => Math.round(x * 100) / 100;
const round3 = (x) => Math.round(x * 1000) / 1000;
