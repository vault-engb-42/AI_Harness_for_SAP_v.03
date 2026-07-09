import { test } from "node:test";
import assert from "node:assert/strict";
import { cloudReadiness } from "../src/cloud-readiness.js";

// cloud_readiness dimension (arch spec §3.C): bucket the curated findings by
// clean-core grade — blockers=D, warnings=C, advisories=B, needs_review=unknown
// (1:1 with the grade tiers). Each bucket carries a finding count + distinct-rule
// count (mirrors the reference tab header "BLOCKERS (11 FINDINGS, 4 DISTINCT RULES)").

test("cloudReadiness buckets findings by grade with finding + distinct-rule counts", () => {
  const findings = [
    { grade: "blocker", rule_id: "S4-001" },
    { grade: "blocker", rule_id: "S4-001" },
    { grade: "blocker", rule_id: "S4-006" },
    { grade: "warning", rule_id: "R2" },
    { grade: "advisory", rule_id: "R3" },
    { grade: "advisory", rule_id: "R3" },
    { grade: "needs_review", rule_id: "R4" },
  ];
  const cr = cloudReadiness(findings);
  assert.deepEqual(cr.blockers, { findings: 3, distinct_rules: 2 });
  assert.deepEqual(cr.warnings, { findings: 1, distinct_rules: 1 });
  assert.deepEqual(cr.advisories, { findings: 2, distinct_rules: 1 });
  assert.deepEqual(cr.needs_review, { findings: 1, distinct_rules: 1 });
});

test("cloudReadiness is total — all four buckets present, zeroed, on empty input", () => {
  assert.deepEqual(cloudReadiness([]), {
    blockers: { findings: 0, distinct_rules: 0 },
    warnings: { findings: 0, distinct_rules: 0 },
    advisories: { findings: 0, distinct_rules: 0 },
    needs_review: { findings: 0, distinct_rules: 0 },
  });
});

test("cloudReadiness ignores findings with no recognized grade (defensive)", () => {
  const cr = cloudReadiness([{ grade: "blocker", rule_id: "X" }, { grade: undefined, rule_id: "Y" }, { rule_id: "Z" }]);
  assert.equal(cr.blockers.findings, 1);
  assert.equal(cr.warnings.findings + cr.advisories.findings + cr.needs_review.findings, 0);
});
