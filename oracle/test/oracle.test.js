import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyName, gradeUsage, successorOf, debtScore, fixtureFor } from "../src/oracle.js";

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

test("gradeUsage applies the read/write split on non-released objects (§2 / §15.1)", () => {
  // released object -> no access penalty
  assert.deepEqual(gradeUsage("ACTVT", "read", "AUTH"), { level: "A", atc_priority: "none" });
  // non-released: read -> C/P2, write -> D/P1
  assert.deepEqual(gradeUsage("CI_DCLS_CHK", "read", "CHKO"), { level: "C", atc_priority: "P2" });
  assert.deepEqual(gradeUsage("CI_DCLS_CHK", "write", "CHKO"), { level: "D", atc_priority: "P1" });
  // an unknown access kind defaults to the (less severe) read grade
  assert.deepEqual(gradeUsage("CI_DCLS_CHK", undefined, "CHKO"), { level: "C", atc_priority: "P2" });
});

test("successorOf returns ALL registry successors + the ingested mapping kind (O1/O2)", () => {
  // CL_A4C_BC_FACTORY: successorClassification=multipleObjects, 2 successors on disk.
  assert.deepEqual(successorOf("CL_A4C_BC_FACTORY", "CLAS"), {
    successor: "CL_BCFG_CD_REUSE_API_FACTORY",
    successor_kind: "CLAS",
    successors: [
      { name: "CL_BCFG_CD_REUSE_API_FACTORY", type: "CLAS" },
      { name: "XCO_CP_CTS", type: "CLAS" },
    ],
    mapping_kind: "multipleObjects",
    successor_concept: null,
  });
  assert.equal(successorOf("ZZ_NOT_A_REAL_OBJECT"), null);
  assert.equal(successorOf(null), null);
});

test("successorOf ingests the single-successor mapping kind (O2 — oneObject)", () => {
  const r = successorOf("ABAP_CLOUD_DEVELOPMENT_3TIER", "CHKV");
  assert.equal(r.mapping_kind, "oneObject");
  assert.equal(r.successor, "ABAP_CLEAN_CORE_DEVELOPMENT");
  assert.deepEqual(r.successors, [{ name: "ABAP_CLEAN_CORE_DEVELOPMENT", type: "CHKV" }]);
});

test("successorOf surfaces a concept successor with no discrete object (O2 — concept)", () => {
  // CL_APJ_SCP_TOOLS: successorClassification=concept, no successors[], a named concept.
  const r = successorOf("CL_APJ_SCP_TOOLS", "CLAS");
  assert.equal(r.mapping_kind, "concept");
  assert.equal(r.successor_concept, "Automatic Job Restart in BTP");
  assert.deepEqual(r.successors, []);
  assert.equal(r.successor, null);
});

test("classifyName exposes the full successor list + mapping kind (O1/O2)", () => {
  const r = classifyName("CL_A4C_BC_FACTORY", "CLAS");
  assert.equal(r.successors.length, 2, "1:many — both successors, not just the first");
  assert.deepEqual(r.successors.map((s) => s.name), ["CL_BCFG_CD_REUSE_API_FACTORY", "XCO_CP_CTS"]);
  assert.equal(r.mapping_kind, "multipleObjects");
});

test("classifyName labels a deprecated state as a state-derived warning, distinct from the level (O5)", () => {
  const dep = classifyName("CL_A4C_BC_FACTORY", "CLAS");
  assert.equal(dep.level, "C", "clean-core level is a separate judgement");
  assert.equal(dep.state, "deprecated");
  assert.match(dep.state_warning, /deprecated/i, "the deprecation is surfaced as a state warning, not conflated with the C level");
  // a released (level A) object carries no state warning
  const rel = classifyName("ACTVT", "AUTH");
  assert.equal(rel.level, "A");
  assert.equal(rel.state_warning, null);
  // a classicAPI object (level B) surfaces the cloud-vs-on-prem lifecycle warning
  const classic = classifyName("/AIF/CL_BGRFC_CLEANUP_UTIL", "CLAS");
  assert.equal(classic.level, "B");
  assert.match(classic.state_warning, /ABAP Cloud/i, "classicAPI surfaces the on-prem-vs-cloud split, not conflated with the B level");
});

test("debtScore is the Kernseife weighting 10·P1 + 5·P2 + 1·P3 (§2/§12)", () => {
  assert.equal(debtScore({ p1: 2, p2: 3, p3: 4 }), 39);
  assert.equal(debtScore({}), 0);
  assert.equal(debtScore(), 0);
});

test("fixtureFor is total — null for every rule until curated fixtures are bundled (§2)", () => {
  assert.equal(fixtureFor("released-api"), null);
  assert.equal(fixtureFor("anything"), null);
});
