import { test } from "node:test";
import assert from "node:assert/strict";
import { groundCandidates } from "../src/plan/ground-candidates.js";

// B2 / S3 — the grounding pre-pass (I/O boundary). Emits a deterministic per-object grounding cache the
// PURE classifier consumes. v1 is finding-derived (the analyser's clean-core findings already encode its
// grounding); source-level greenfield grounding (harvestRefs → groundReleasedApis) is a later enhancement.

test("groundCandidates emits one cache entry per plan object", () => {
  const doc = { findings: [], modernization_plan: { objects: [{ object: "A" }, { object: "B" }] } };
  assert.deepEqual(Object.keys(groundCandidates(doc)).sort(), ["A", "B"]);
});

test("released_clean requires POSITIVE evidence: analysed (has findings) AND zero P1 clean-core/deprecation blockers", () => {
  const doc = {
    findings: [
      { object: "CLEAN", rule_id: "line_length", family: "abaplint", atc_priority: "P2" }, // style only
      { object: "BLOCKED", rule_id: "talos-cloud-006-write", family: "deprecation", atc_priority: "P1" },
    ],
    modernization_plan: { objects: [{ object: "CLEAN" }, { object: "BLOCKED" }, { object: "UNANALYSED" }] },
  };
  const c = groundCandidates(doc);
  assert.equal(c.CLEAN.released_clean, true, "style-only, no P1 blocker → clean");
  assert.equal(c.BLOCKED.released_clean, false, "P1 deprecation blocker → not clean");
  assert.equal(c.UNANALYSED.released_clean, false, "no findings ≠ clean — absence of evidence is not evidence of cleanliness");
});

test("grounding_certainty is finding-derived (< 1, not source-grounded) and the pre-pass is deterministic", () => {
  const doc = { findings: [{ object: "A", rule_id: "x", family: "abaplint", atc_priority: "P2" }], modernization_plan: { objects: [{ object: "A" }] } };
  const c = groundCandidates(doc);
  assert.ok(c.A.grounding_certainty < 1, "finding-derived certainty is below source-grounded 1.0");
  assert.equal(JSON.stringify(c), JSON.stringify(groundCandidates(doc)), "deterministic");
});
