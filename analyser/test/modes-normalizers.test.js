import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeAtcFindings, normalizeMigrationSummary } from "../src/modes.js";

// Pure-function coverage for the analyse_via_adt normalizers (the live
// round-trip is covered in the test:live suite).

test("ATC priorities map to schema severities (1/2/3/other, string or number)", () => {
  const out = normalizeAtcFindings({
    findings: [
      { check_id: "A", priority: 1, object_name: "Z1", message: "m1" },
      { check_id: "B", priority: "2", object_name: "Z2", message: "m2" },
      { check_id: "C", priority: 3, object_name: "Z3", message: "m3" },
      { check_id: "D", priority: 9, object_name: "Z4", message: "m4" },
    ],
  });
  assert.deepEqual(out.map((f) => f.severity), ["priority-1", "priority-2", "priority-3", "info"]);
  assert.ok(out.every((f) => f.family === "atc"));
});

test("ATC normalizer tolerates the issues/results aliases and missing fields", () => {
  const viaIssues = normalizeAtcFindings({ issues: [{ check: "X", priority: 1, object: "ZO", text: "t" }] });
  assert.equal(viaIssues[0].rule_id, "X");
  assert.equal(viaIssues[0].object, "ZO");
  assert.equal(viaIssues[0].message, "t");
  const empty = normalizeAtcFindings({});
  assert.deepEqual(empty, []);
});

test("migration summary finite-guards non-numeric counts (no NaN -> null)", () => {
  const out = normalizeMigrationSummary({ summary: { released: "not-a-number", deprecated: 2, not_released: null } });
  assert.equal(out.released_hits, 0);
  assert.equal(out.deprecated_hits, 2);
  assert.equal(out.not_released_hits, 0);
  assert.ok(Number.isFinite(out.s4_readiness_pct));
  assert.ok(!JSON.stringify(out).includes("null"), "nothing serializes to null");
});

test("an unrecognized shape yields the zero-count 100% form (subset mode's coverage_note explains it)", () => {
  const out = normalizeMigrationSummary({ some: "garbage" });
  assert.equal(out.total_api_calls, 0);
  assert.equal(out.s4_readiness_pct, 100);
});
