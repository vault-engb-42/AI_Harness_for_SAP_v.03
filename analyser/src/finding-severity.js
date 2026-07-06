/**
 * Maps an abaplint rule Issue to the analyser-findings schema's `severity`
 * enum (priority-1 | priority-2 | priority-3 | info).
 *
 * priority-1 is reserved for genuine Clean-Core blockers. abaplint's generic
 * rules map Error->priority-2 / Warning->priority-3 (no severity inflation),
 * EXCEPT the cloud-readiness rules, whose Errors ARE Clean-Core blockers and
 * are promoted to priority-1. The harness's own HARD rules (released-api, P4
 * invariants) are the other priority-1 sources.
 */

/** abaplint Severity value -> schema severity. */
const SEVERITY_MAP = {
  Error: "priority-2",
  Warning: "priority-3",
  Info: "info",
};

/** abaplint rule keys whose Error findings are Clean-Core blockers (priority-1). */
const CLEAN_CORE_CRITICAL = new Set(["cloud_types"]);

/**
 * @param {string} ruleKey abaplint rule key (Issue.getKey())
 * @param {string} abaplintSeverity abaplint Severity value ("Error"|"Warning"|"Info")
 * @returns {"priority-1"|"priority-2"|"priority-3"|"info"}
 */
export function severityForAbaplintRule(ruleKey, abaplintSeverity) {
  const base = SEVERITY_MAP[abaplintSeverity] ?? "info";
  if (base !== "info" && CLEAN_CORE_CRITICAL.has(ruleKey)) {
    return "priority-1";
  }
  return base;
}

/** @param {string} ruleKey @returns {string} coarse family tag for the finding */
export function familyForAbaplintRule(ruleKey) {
  return CLEAN_CORE_CRITICAL.has(ruleKey) ? "clean-core" : "abaplint";
}
