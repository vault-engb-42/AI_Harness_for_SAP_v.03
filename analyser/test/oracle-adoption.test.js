import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, effortTier } from "../src/cloudification.js";

// Oracle classification — §3.F oracle-adoption, refined by the 2026-07-09
// "release-info wins" operator policy. classify().release_state + effortTier()
// derive from the oracle Level. On a cross-registry conflict the AUTHORITATIVE
// objectReleaseInfo file wins over the classifications file (its states are used
// whenever present; classifications is a fallback), with weakest-wins WITHIN the
// winning source. So a released↔classicAPI object stays RELEASED (the classic-API
// list can't demote a released foundational API), while a notToBeReleased/deprecated
// object still collapses to removed/deprecated. Real registries, no mocks.

// [name, expected release_state, expected effort_tier]
const CASES = [
  // released (release-info) + classicAPI (classifications) conflict: release-info
  // wins -> stays released / keep-and-clean (the false-flag class we fixed).
  ["CL_ABAP_CHAR_UTILITIES", "released", "keep-and-clean"],
  ["/UI2/CL_JSON", "released", "keep-and-clean"],
  ["CX_STATIC_CHECK", "released", "keep-and-clean"],
  // notToBeReleased (release-info) -> Level D: release-info wins AND is the worst
  // state, so these collapse to removed / retire (unchanged by the policy).
  ["CL_BCS", "removed", "retire"],
  ["T001", "removed", "retire"],
];

test("classify().release_state + effortTier: release-info wins over the classifications file", () => {
  for (const [name, state, tier] of CASES) {
    assert.equal(classify(name).release_state, state, `${name} release_state should be ${state}`);
    assert.equal(effortTier(name), tier, `${name} effort_tier should be ${tier}`);
  }
});

test("§3.F: non-conflict objects are unchanged by the migration (no collateral drift)", () => {
  // released-only stays released/keep-and-clean; an unlisted name stays unknown.
  assert.equal(classify("ACTVT").release_state, "released");
  assert.equal(effortTier("ACTVT"), "keep-and-clean");
  assert.equal(classify("ZZ_NOT_A_REAL_OBJECT").release_state, "unknown");
  assert.equal(effortTier("ZZ_NOT_A_REAL_OBJECT"), "unknown");
});
