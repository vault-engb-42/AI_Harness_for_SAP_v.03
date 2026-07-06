/**
 * Rule engine — runs harness/TALOS rules over an analysis context and
 * aggregates their findings. abaplint's built-in rules run separately (see
 * abaplint-rules.js); this engine drives the rules the harness owns.
 *
 * A Rule is a plain object:
 *   { id: string, family: string, verdict: "HARD"|"WARN"|"INFO",
 *     applicable_to_kinds?: NodeKind[], check(ctx): Finding[] }
 * Rules query the analysis context (graph + registry + cloudification), never
 * hold cross-object state, and return schema `findings` items (rule_id/family
 * are stamped from the rule if the finding omits them).
 *
 * @typedef {object} AnalysisContext
 * @property {import("./cpg.js").DependencyGraph} graph  the CPG
 * @property {import("@abaplint/core").Registry} reg     parsed registry (source access)
 * @property {object} cloud  cloudification adapter { classify, isReleased, getSuccessor, effortTier }
 */

/**
 * @param {Array<{id: string, family: string, verdict: string, check: (ctx: AnalysisContext) => object[]}>} rules
 * @param {AnalysisContext} ctx
 * @returns {object[]} aggregated schema findings
 */
export function runRules(rules, ctx) {
  const findings = [];
  for (const rule of rules) {
    for (const f of runOne(rule, ctx)) {
      findings.push({ family: rule.family, ...f, rule_id: f.rule_id ?? rule.id });
    }
  }
  return findings;
}

/**
 * Run a single rule with error isolation: a throwing rule must not abort the
 * whole scan (corpus robustness), so it degrades to one diagnostic finding.
 * @param {{id: string, family: string, check: Function}} rule
 * @param {AnalysisContext} ctx
 * @returns {object[]}
 */
function runOne(rule, ctx) {
  try {
    return rule.check(ctx) ?? [];
  } catch (err) {
    // Engine boundary: convert a rule crash into a surfaced diagnostic rather
    // than losing every other rule's findings.
    return [{
      rule_id: rule.id,
      severity: "info",
      object: "(engine)",
      message: `rule ${rule.id} threw: ${err.message}`,
      family: "engine",
    }];
  }
}
