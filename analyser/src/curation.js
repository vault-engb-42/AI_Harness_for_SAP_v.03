import { classifyName } from "../../oracle/src/oracle.js";

/**
 * Static-first curation (arch spec §3.B, conv #17). Adds the curated fields to
 * each finding: source_category (its native family), a grade routed TOTAL and
 * DISJOINT by family, atc_priority, and atcCheckId (§15.7).
 *
 * Grade routing (conv #17): registry-grounded families grade via the ORACLE on
 * the finding's referenced_object (the SAP object it uses) — the oracle is the
 * grade authority, so a classicAPI (B) reference grades `advisory` even where the
 * rule set a higher ATC severity. All other families (and any registry finding
 * with no referenced_object) grade from the finding's own severity. `grade` is
 * additive — it never alters the existing `severity`.
 *
 * Usage-aware curation (reachability decommission) stays DEFERRED until the
 * GAP#3a usage adapter feeds runRules — this is the static-first pass (§3.B).
 */

/** Families whose findings reference a classifiable SAP object (grade via oracle). */
const REGISTRY_FAMILIES = new Set(["released-api"]);

/** ATC severity -> clean-core grade (the severity path — total over the enum). */
const SEVERITY_GRADE = {
  "priority-1": "blocker",
  "priority-2": "warning",
  "priority-3": "advisory",
  info: "advisory",
};

/** grade -> ATC priority. */
const GRADE_PRIORITY = { blocker: "P1", warning: "P2", advisory: "P3", needs_review: "none" };

/** family -> ATC check id (§15.7); default SYCM_USAGE_OF_APIS. */
const ATC_CHECK_ID = {
  "released-api": "SYCM_USAGE_OF_APIS",
  deprecation: "SYCM_USAGE_OF_APIS",
  "metadata-pack": "SYCM_ALLOWED_ENH_TECHNOLOGY",
  "statement-pack": "CI_CRITICAL_STATEMENTS",
  invariant: "SLIN_SEC",
};

/**
 * @param {string} family
 * @returns {string} the nearest ATC check id (§15.7)
 */
export function atcCheckIdFor(family) {
  return ATC_CHECK_ID[family] ?? "SYCM_USAGE_OF_APIS";
}

/** severity -> grade, total over the enum (unknown severity -> advisory). */
function severityGrade(severity) {
  return SEVERITY_GRADE[severity] ?? "advisory";
}

/**
 * Grade one finding (conv #17). Registry family + referenced_object -> oracle
 * grade (blocker/warning/advisory/needs_review); a `null` oracle grade (Level A)
 * or a missing referenced_object falls back to the severity path.
 * @param {object} finding
 * @returns {string}
 */
function gradeFor(finding) {
  if (REGISTRY_FAMILIES.has(finding.family) && finding.referenced_object) {
    const g = classifyName(finding.referenced_object).grade;
    if (g) return g;
  }
  return severityGrade(finding.severity);
}

/**
 * Curate findings: attach source_category, grade, atc_priority, atcCheckId.
 * @param {object[]} findings
 * @returns {object[]}
 */
export function curateFindings(findings) {
  return findings.map((f) => {
    const grade = gradeFor(f);
    return {
      ...f,
      source_category: f.family ?? "unknown",
      grade,
      atc_priority: GRADE_PRIORITY[grade] ?? "none",
      atcCheckId: atcCheckIdFor(f.family),
    };
  });
}
