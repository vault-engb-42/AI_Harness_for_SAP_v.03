import { objectsOf } from "../src/abaplint-loader.js";

/**
 * CDS-structure rule pack — coded checks over a DDLS object's parsed data
 * (sources/associations) and raw DDL text. Ports the TALOS CDS join-graph and
 * push-down rules that neither the line-regex pack nor abaplint cover:
 * PERF-61/67/68/81/82/83/86/87/90/92. TALOS codes are cited in messages.
 *
 * The analysis core (`analyzeCds`) is a pure function over (name, raw,
 * parsedData) so count thresholds are unit-testable without 100-join fixtures.
 */

const TABLE_LIMIT = 100; // PERF-81
const QUALITY_LIMITS = { A: 3, B: 5 }; // PERF-82/83
const CYCLIC_REPEAT = 3; // PERF-90
const CASE_LIMIT = 3; // PERF-67
const CALC_FN_RE = /\b(?:concat|substring|cast|coalesce|division|left|right|upper|lower|replace)\s*\(|\bcase\b/i;

export const cdsStructurePack = {
  id: "cds-structure-pack",
  family: "cds-structure-pack",
  verdict: "WARN",
  /**
   * @param {import("../src/rule-engine.js").AnalysisContext} ctx
   * @returns {object[]}
   */
  check(ctx) {
    const findings = [];
    for (const obj of objectsOf(ctx.reg)) {
      if (obj.getType?.() !== "DDLS") continue;
      const raw = obj.getFiles?.()[0]?.getRaw?.();
      const pd = obj.getParsedData?.();
      if (!raw || !pd) continue;
      const file = obj.getFiles()[0].getFilename();
      for (const f of analyzeCds(obj.getName(), raw, pd)) {
        findings.push({ ...f, object: obj.getName(), object_type: "DDLS", file, line: f.line ?? 1 });
      }
    }
    return findings;
  },
};

/**
 * Pure CDS structure analysis.
 * @param {string} name object name
 * @param {string} raw DDL source
 * @param {{sources?: Array<{name?: string}>, associations?: Array<{name?: string}>}} pd
 * @returns {Array<{rule_id: string, severity: string, message: string, family: string}>}
 */
export function analyzeCds(name, raw, pd) {
  const findings = [];
  const sourceNames = (pd.sources ?? []).map((s) => String(s?.name ?? "").toUpperCase()).filter(Boolean);
  const distinct = new Set(sourceNames);

  checkTableCounts(findings, raw, sourceNames, distinct);
  checkJoinPredicates(findings, raw);
  checkProjection(findings, raw);
  checkVdmLayering(findings, raw, sourceNames);
  return findings;
}

function mk(rule_id, severity, message) {
  return { rule_id, severity, message, family: "performance" };
}

function checkTableCounts(findings, raw, sourceNames, distinct) {
  if (distinct.size > TABLE_LIMIT) {
    findings.push(mk("talos-cds-too-many-tables", "priority-1", `CDS view joins ${distinct.size} distinct tables (> ${TABLE_LIMIT}); HANA plan stability collapses — split the view (ABAP-PERF-81)`));
  }
  const q = /@ObjectModel\.usageType\.serviceQuality\s*:\s*#([AB])\b/i.exec(raw);
  if (q) {
    const limit = QUALITY_LIMITS[q[1].toUpperCase()];
    if (distinct.size > limit) {
      findings.push(mk("talos-cds-service-quality-mismatch", "priority-2", `serviceQuality #${q[1].toUpperCase()} view uses ${distinct.size} tables (> ${limit}); requality or reduce sources (ABAP-PERF-82/83)`));
    }
  }
  const counts = new Map();
  for (const s of sourceNames) counts.set(s, (counts.get(s) ?? 0) + 1);
  for (const [tab, n] of counts) {
    if (n >= CYCLIC_REPEAT) {
      findings.push(mk("talos-cds-cyclic-join", "priority-1", `table ${tab} appears ${n}x in the FROM/JOIN graph; cyclic-looking join forces row-engine materialisation (ABAP-PERF-90)`));
      break; // one finding per view is enough
    }
  }
}

function checkJoinPredicates(findings, raw) {
  // JOIN ... ON <predicate until '{' or next join>
  for (const m of raw.matchAll(/\bjoin\b[\s\S]*?\bon\b([\s\S]*?)(?=\bjoin\b|\{)/gi)) {
    if (CALC_FN_RE.test(m[1])) {
      findings.push(mk("talos-cds-calc-field-in-join", "priority-2", "JOIN ON references a calculated expression; join on base columns so the predicate pushes down (ABAP-PERF-87/93)"));
      break;
    }
  }
  const where = /\bwhere\b([\s\S]*?)(?=\bgroup\s+by\b|\bunion\b|$)/i.exec(raw);
  if (where && CALC_FN_RE.test(where[1])) {
    findings.push(mk("talos-cds-calc-field-in-where", "priority-2", "WHERE filters on a calculated expression; filter on base columns so the predicate pushes down (ABAP-PERF-86)"));
  }
}

function checkProjection(findings, raw) {
  // Anchor on the first '{' AFTER the select clause: header annotations with
  // braced values (@UI: { ... }) must not leak into the CASE-count and
  // key-order checks.
  const proj = /\bselect\b[^{]*\{([\s\S]*)\}/i.exec(raw);
  if (!proj) return;
  const body = proj[1];

  const caseCount = (body.match(/\bcase\b/gi) ?? []).length;
  if (caseCount >= CASE_LIMIT) {
    findings.push(mk("talos-cds-business-logic", "priority-2", `${caseCount} CASE expressions in the projection; business logic belongs in the behavior/consumer, not the data layer (ABAP-PERF-67)`));
  }

  // PERF-61: a `key` element after a non-key element
  let sawNonKey = false;
  for (const el of body.split(",")) {
    const t = el.trim();
    if (!t) continue;
    if (/^key\s/i.test(t)) {
      if (sawNonKey) {
        findings.push(mk("talos-cds-field-order", "info", "key field declared after a non-key field; keys must lead the projection (ABAP-PERF-61)"));
        break;
      }
    } else {
      sawNonKey = true;
    }
  }

  if (/\bgroup\s+by\b/i.test(raw) && isInterfaceView(raw)) {
    findings.push(mk("talos-cds-groupby-in-reuse", "priority-2", "GROUP BY in a basic/interface view forces materialisation for every consumer; aggregate in a dedicated consumption view (ABAP-PERF-92)"));
  }
}

function checkVdmLayering(findings, raw, sourceNames) {
  const vdm = /@VDM\.viewType\s*:\s*#(COMPOSITE|CONSUMPTION)\b/i.exec(raw);
  if (!vdm) return;
  // Direct DDIC access = a source that is not an interface/consumption view
  // by VDM naming (I_/ZI_/C_/ZC_...).
  const direct = sourceNames.find((s) => !/^Z?[IC]_/i.test(s) && !s.startsWith("/"));
  if (direct) {
    findings.push(mk("talos-cds-composite-direct-ddic", "priority-2", `${vdm[1].toLowerCase()} view selects directly from DDIC table ${direct}; layer over a basic interface view instead (ABAP-PERF-68)`));
  }
}

/** Basic/interface view heuristic: VDM annotation or I_/ZI_ naming. */
function isInterfaceView(raw) {
  if (/@VDM\.viewType\s*:\s*#(BASIC|COMPOSITE)\b/i.test(raw)) return true;
  const def = /define\s+view(?:\s+entity)?\s+(\w+)/i.exec(raw);
  return def ? /^Z?I_/i.test(def[1]) : false;
}
