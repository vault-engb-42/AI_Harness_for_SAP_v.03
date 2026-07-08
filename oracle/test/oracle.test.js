import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyName } from "../src/oracle.js";

// The oracle is the shared clean-core classifier (arch spec §2 / §15.1): it maps
// SAP's two published registries (data/) onto the A/B/C/D level spine with a
// TOTAL, deterministic weakest-wins resolution over conflicting keys (conv #3).
// Real registry data on disk, no mocks. Anchors below are verified against data/.

/** project to the comparable subset */
const pick = (r) => ({ level: r.level, grade: r.grade, atc_priority: r.atc_priority });

test("classifyName maps each registry state to its level / grade / atc_priority (§2 table)", () => {
  assert.deepEqual(pick(classifyName("ACTVT", "AUTH")), { level: "A", grade: null, atc_priority: "none" });
  assert.deepEqual(pick(classifyName("/AIF/CL_BGRFC_CLEANUP_UTIL", "CLAS")), { level: "B", grade: "advisory", atc_priority: "P3" });
  assert.deepEqual(pick(classifyName("D_SUPLSTPRPSDCCPRPOSTODELCCP", "BDEF")), { level: "C", grade: "warning", atc_priority: "P2" });
  assert.deepEqual(pick(classifyName("CI_DCLS_CHK", "CHKO")), { level: "D", grade: "blocker", atc_priority: "P1" });
  assert.deepEqual(pick(classifyName("/AIF/CL_TRANSFORM_DATA", "CLAS")), { level: "D", grade: "blocker", atc_priority: "P1" });
});

test("classifyName resolves conflicting keys by weakest-wins (conv #3 — D<C<B<A)", () => {
  // CL_BCS: notToBeReleased(D) in release-info vs classicAPI(B) in classifications -> weakest D.
  assert.equal(classifyName("CL_BCS", "CLAS").level, "D");
  // IF_AUNIT_CONSTANTS: deprecated(C) vs classicAPI(B) -> weakest C.
  assert.equal(classifyName("IF_AUNIT_CONSTANTS", "INTF").level, "C");
});

test("classifyName is TOTAL — an unlisted name resolves to unknown / needs_review, never throws", () => {
  const r = classifyName("ZZ_DEFINITELY_NOT_A_REAL_SAP_OBJECT", "CLAS");
  assert.equal(r.level, "unknown");
  assert.equal(r.grade, "needs_review");
  assert.equal(r.atc_priority, "none");
});

test("classifyName without tadirType is total — weakest across all rows carrying the name (conv #3)", () => {
  const r = classifyName("CL_BCS");
  assert.ok(["A", "B", "C", "D", "unknown"].includes(r.level), "name-only call must be total");
  assert.equal(r.level, "D", "weakest across all CL_BCS (name-only) rows");
});

test("classifyName is case-insensitive and null-safe (boundary)", () => {
  assert.equal(classifyName("cl_bcs", "clas").level, "D");
  assert.equal(classifyName(null).level, "unknown");
  assert.equal(classifyName(undefined).level, "unknown");
  assert.equal(classifyName("").level, "unknown");
});
