/**
 * The grounding pre-pass (BUILD_PLAN S3): emits a deterministic per-object grounding cache that the PURE
 * disposition classifier consumes, keeping the classifier free of I/O. v1 is FINDING-DERIVED — the analyser's
 * clean-core / deprecation findings already encode its released-API grounding, so `released_clean` = the
 * object was analysed (has findings) AND has ZERO P1 blockers in the clean-core / deprecation families.
 * Absence of findings is NOT cleanliness (an FM whose findings are attributed to its function group must not
 * read as clean). Source-level greenfield grounding (harvestRefs → groundReleasedApis) is a later enhancement
 * that raises `grounding_certainty` to the source-grounded 1.0 and populates `released_standard_exists`.
 */

const BLOCKER_FAMILIES = new Set(["clean-core", "deprecation"]);
// Below the source-grounded 1.0 — keeps a finding-derived refactor at PROMPT until real source grounding (θ=0.9).
const FINDING_DERIVED_CERTAINTY = 0.8;

/**
 * @param {{findings?: Array<{object: string, family?: string, atc_priority?: string}>, modernization_plan?: {objects?: Array<{object: string}>}}} doc analyser-findings.json
 * @returns {Record<string, {released_clean: boolean, released_standard_exists: boolean, grounding_certainty: number}>}
 */
export function groundCandidates(doc) {
  const byObject = new Map();
  for (const f of doc.findings ?? []) {
    if (!byObject.has(f.object)) byObject.set(f.object, []);
    byObject.get(f.object).push(f);
  }
  const cache = {};
  for (const o of doc.modernization_plan?.objects ?? []) {
    const fs = byObject.get(o.object) ?? [];
    const analysed = fs.length > 0;
    const p1Blockers = fs.filter((f) => f.atc_priority === "P1" && BLOCKER_FAMILIES.has(f.family));
    cache[o.object] = {
      released_clean: analysed && p1Blockers.length === 0,
      released_standard_exists: false, // needs the cloudification registry / fit-to-standard — not finding-derivable (v1)
      grounding_certainty: FINDING_DERIVED_CERTAINTY,
    };
  }
  return cache;
}
