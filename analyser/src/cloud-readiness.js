/**
 * cloud_readiness dimension (arch spec §3.C) — buckets curated findings by their
 * clean-core grade so the report's Cloud Readiness tab can show blocker/warning/
 * advisory/needs_review counts. 1:1 with the grade tiers (blockers=D, warnings=C,
 * advisories=B, needs_review=unknown) and the SARIF error/warning/note/note
 * levels. Pure + deterministic; the per-finding detail stays in doc.findings
 * (the HTML filters it by grade — no duplication).
 */

/** grade -> bucket key. */
const GRADE_BUCKET = { blocker: "blockers", warning: "warnings", advisory: "advisories", needs_review: "needs_review" };
const BUCKETS = ["blockers", "warnings", "advisories", "needs_review"];

/**
 * @param {Array<{grade?: string, rule_id?: string}>} findings curated findings
 * @returns {Record<string, {findings: number, distinct_rules: number}>}
 */
export function cloudReadiness(findings) {
  const counts = {};
  const rules = {};
  for (const b of BUCKETS) {
    counts[b] = 0;
    rules[b] = new Set();
  }
  for (const f of findings ?? []) {
    const bucket = GRADE_BUCKET[f?.grade];
    if (!bucket) continue;
    counts[bucket]++;
    rules[bucket].add(f.rule_id ?? "");
  }
  const out = {};
  for (const b of BUCKETS) out[b] = { findings: counts[b], distinct_rules: rules[b].size };
  return out;
}
