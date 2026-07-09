import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, effortTier } from "../src/cloudification.js";

// §3.F oracle-adoption — BEFORE/AFTER fixture (arch spec §3.F: "an INTENDED
// migration ... proven with a before/after fixture, not a silent side effect").
//
// cloudification.classify().release_state + effortTier() now derive from the
// ORACLE Level (weakest-wins over BOTH registries), replacing the old release-
// wins normalizeS4Status. For the ~266 conflict objects this CHANGES output.
// Each row documents BEFORE (old cloudification) -> AFTER (oracle). The AFTER
// values are asserted (regression guard); BEFORE is the documented delta.
// Real registries, no mocks.

// [name, BEFORE release_state, BEFORE tier, AFTER release_state, AFTER tier]
const DELTAS = [
  // released (objectReleaseInfo) + classicAPI (objectClassifications): release-wins
  // reported "released" (readiness numerator, keep-and-clean); weakest-wins reports
  // Level B -> "deprecated" / "re-platform". THESE move s4_readiness_pct downward.
  ["CL_ABAP_CHAR_UTILITIES", "released", "keep-and-clean", "deprecated", "re-platform"],
  ["/UI2/CL_JSON", "released", "keep-and-clean", "deprecated", "re-platform"],
  // notToBeReleased-bearing: old release-wins normalized to "deprecated"/"re-platform";
  // weakest-wins collapses notToBeReleased/noAPI to Level D -> "removed" / "retire".
  ["CL_BCS", "deprecated", "re-platform", "removed", "retire"],
  ["T001", "deprecated", "re-platform", "removed", "retire"],
];

test("§3.F: classify().release_state + effortTier now derive from the oracle Level (before/after)", () => {
  for (const [name, beforeState, beforeTier, afterState, afterTier] of DELTAS) {
    assert.equal(classify(name).release_state, afterState, `${name} release_state should be ${afterState} (was ${beforeState} pre-§3.F)`);
    assert.equal(effortTier(name), afterTier, `${name} effort_tier should be ${afterTier} (was ${beforeTier} pre-§3.F)`);
  }
});

test("§3.F: non-conflict objects are unchanged by the migration (no collateral drift)", () => {
  // released-only stays released/keep-and-clean; an unlisted name stays unknown.
  assert.equal(classify("ACTVT").release_state, "released");
  assert.equal(effortTier("ACTVT"), "keep-and-clean");
  assert.equal(classify("ZZ_NOT_A_REAL_OBJECT").release_state, "unknown");
  assert.equal(effortTier("ZZ_NOT_A_REAL_OBJECT"), "unknown");
});
