/**
 * Focused validator for the analyser-findings schema — enforces the required
 * fields and enums that consumers (/abap-brownfield, /readiness, /seam-finder)
 * depend on. In-house (no ajv dependency); mirrors
 * .claude/schemas/analyser-findings.schema.json. Doubles as the C5 oracle.
 */

const SEVERITY = new Set(["priority-1", "priority-2", "priority-3", "info"]);
const NODE_KIND = new Set(["class", "method", "function", "report", "cds", "behavior", "table", "form", "interface"]);
const EDGE_KIND = new Set(["calls", "call-function", "call-method", "get-badi", "uses-table", "authority-check", "inherits", "consumes-cds", "includes", "data-flow-def", "data-flow-use"]);
const NAMESPACE = new Set(["Z", "Y", "registered", "sap"]);
const POSTURE = new Set(["level-a", "brownfield-mixed", "classic", "unknown"]);
const GRADE = new Set(["A", "B", "C", "D", "unknown"]);
const TIER = new Set(["retire", "re-platform", "keep-and-clean", "unknown"]);
const IMPACT = new Set(["low", "medium", "high", "critical"]);

/**
 * @param {object} doc a produced analyser-findings document
 * @returns {{valid: boolean, errors: string[]}}
 */
/** A required field is missing when null OR undefined (null violates the schema too). */
const absent = (v) => v == null;
/** An optional enum field is invalid when PRESENT (incl. null/"") but not in the enum. */
const badEnum = (obj, key, allowed) => obj != null && key in obj && !allowed.has(obj[key]);

export function validateFindings(doc) {
  const errors = [];
  for (const f of ["source_system", "package", "generated_at", "findings", "s4_readiness", "graph"]) {
    if (absent(doc?.[f])) errors.push(`missing required top-level field: ${f}`);
  }
  validateFindingsArray(doc?.findings, errors);
  validateGraph(doc?.graph, errors);
  validateReadiness(doc?.s4_readiness, errors);
  validateBlastRadius(doc?.blast_radius, errors);
  validateCodeHealth(doc?.code_health, errors);
  validateDebt(doc?.debt, errors);
  return { valid: errors.length === 0, errors };
}

function validateFindingsArray(findings, errors) {
  if (!Array.isArray(findings)) return void errors.push("findings is not an array");
  findings.forEach((f, i) => {
    for (const r of ["rule_id", "severity", "object", "message"]) {
      if (absent(f?.[r])) errors.push(`findings[${i}] missing ${r}`);
    }
    if (badEnum(f, "severity", SEVERITY)) errors.push(`findings[${i}] bad severity: ${f.severity}`);
  });
}

function validateGraph(graph, errors) {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    return void errors.push("graph.nodes / graph.edges must be arrays");
  }
  graph.nodes.forEach((n, i) => {
    for (const r of ["id", "kind", "object"]) if (absent(n?.[r])) errors.push(`nodes[${i}] missing ${r}`);
    if (badEnum(n, "kind", NODE_KIND)) errors.push(`nodes[${i}] bad kind: ${n.kind}`);
    if (badEnum(n, "namespace", NAMESPACE)) errors.push(`nodes[${i}] bad namespace: ${n.namespace}`);
    if (badEnum(n, "clean_core_posture", POSTURE)) errors.push(`nodes[${i}] bad clean_core_posture: ${n.clean_core_posture}`);
    if (badEnum(n, "clean_core_grade", GRADE)) errors.push(`nodes[${i}] bad clean_core_grade: ${n.clean_core_grade}`);
    if (badEnum(n, "effort_tier", TIER)) errors.push(`nodes[${i}] bad effort_tier: ${n.effort_tier}`);
  });
  graph.edges.forEach((e, i) => {
    for (const r of ["source", "target", "kind"]) if (absent(e?.[r])) errors.push(`edges[${i}] missing ${r}`);
    if (badEnum(e, "kind", EDGE_KIND)) errors.push(`edges[${i}] bad kind: ${e.kind}`);
  });
}

function validateReadiness(s4, errors) {
  if (!s4) return void errors.push("s4_readiness missing");
  for (const r of ["s4_readiness_pct", "released_hits", "deprecated_hits"]) {
    if (absent(s4[r])) errors.push(`s4_readiness missing ${r}`);
  }
}

/** code_health is optional; when present, grade must be a legal Level and the four scores integers in [0,100]. */
function validateCodeHealth(ch, errors) {
  if (ch === undefined) return;
  if (badEnum(ch, "clean_core_grade", GRADE)) errors.push(`code_health bad clean_core_grade: ${ch.clean_core_grade}`);
  for (const k of ["clarity", "stability", "performance", "compound"]) {
    const v = ch?.[k];
    if (!Number.isInteger(v) || v < 0 || v > 100) errors.push(`code_health.${k} must be an integer in [0,100]: ${v}`);
  }
}

/** debt is optional; when present, scores is an array of {symbol, score∈[0,1]} + numeric summaries. */
function validateDebt(debt, errors) {
  if (debt === undefined) return;
  if (!Array.isArray(debt.scores)) return void errors.push("debt.scores is not an array");
  debt.scores.forEach((s, i) => {
    if (absent(s?.symbol)) errors.push(`debt.scores[${i}] missing symbol`);
    if (typeof s?.score !== "number" || s.score < 0 || s.score > 1) errors.push(`debt.scores[${i}].score must be a number in [0,1]: ${s?.score}`);
  });
}

function validateBlastRadius(blast, errors) {
  if (blast === undefined) return;
  if (!Array.isArray(blast)) return void errors.push("blast_radius is not an array");
  blast.forEach((b, i) => {
    for (const r of ["object", "affected_program_count"]) if (absent(b?.[r])) errors.push(`blast_radius[${i}] missing ${r}`);
    if (badEnum(b, "highest_impact", IMPACT)) errors.push(`blast_radius[${i}] bad highest_impact: ${b.highest_impact}`);
  });
}
