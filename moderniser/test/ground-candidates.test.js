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

// GAP 1 — the source-grounded 1.0, which opens the disposition gate's `auto` lane.
//
// The lane was unreachable BY CONSTRUCTION: `autonomy` needs `refactor && confidence >= 0.9`, refactor
// confidence IS `grounding_certainty`, and the only assignment was the flat FINDING_DERIVED_CERTAINTY = 0.8.
// Measured before this change: autonomy=auto produced 0 times across 116 nodes on all five corpora.
//
// The refs are grounded from CPG EDGE TARGETS — symbol names, never source text (P8) — which is the same
// channel `groundRegistryRefs` already walks. Harvesting from source would be a step backwards on P8 and is
// deliberately not done.
//
// The whole risk lives in one direction: 1.0 means no human looks again. So the predicate demands POSITIVE
// evidence — at least one classifiable SAP ref, and every one of them `released`. Absence of refs is not
// cleanliness, and `unknown` is not `released`. Measured on the corpora: of 15 released_clean refactor
// nodes, 8 have no classifiable refs at all and MUST stay at 0.8; 7 qualify.

const withEdges = (object, targets, extraFindings = []) => ({
  findings: [{ object, rule_id: "line_length", family: "abaplint", atc_priority: "P2" }, ...extraFindings],
  modernization_plan: { objects: [{ object }] },
  graph: { nodes: [], edges: targets.map((t) => ({ source: `${object}.M`, target: t, kind: "call-method" })) },
});

test("GAP1 every referenced SAP object released → the source-grounded 1.0", () => {
  const c = groundCandidates(withEdges("REL", ["I_COMPANYCODE"]));
  assert.equal(c.REL.released_clean, true, "precondition: finding-derived cleanliness");
  assert.equal(c.REL.grounding_certainty, 1, "all refs released is the positive evidence 1.0 rests on");
});

test("GAP1 an UNKNOWN ref never counts as released — silence is not evidence", () => {
  // BAPI_SALESORDER_CREATEFROMDAT2 is a mainstream SAP BAPI that the bundled registry does not carry, so
  // `classify` returns `unknown`. Reading that as clean would manufacture certainty from a gap in the
  // registry — the exact failure this codebase keeps finding.
  const c = groundCandidates(withEdges("UNK", ["I_COMPANYCODE", "BAPI_SALESORDER_CREATEFROMDAT2"]));
  assert.ok(c.UNK.grounding_certainty < 0.9, `one unknown ref must hold it below the auto threshold: ${c.UNK.grounding_certainty}`);
});

test("GAP1 a deprecated or removed ref holds certainty down", () => {
  assert.ok(groundCandidates(withEdges("DEP", ["CL_GUI_ALV_GRID"])).DEP.grounding_certainty < 0.9, "deprecated");
  assert.ok(groundCandidates(withEdges("REM", ["CL_HTTP_CLIENT"])).REM.grounding_certainty < 0.9, "removed");
});

test("GAP1 NO classifiable refs stays finding-derived — absence of evidence is not evidence", () => {
  // 8 of the 15 auto-eligible nodes on the real corpora are exactly this shape.
  const c = groundCandidates(withEdges("BARE", []));
  assert.equal(c.BARE.grounding_certainty, 0.8, "nothing was grounded, so nothing was proved");
});

test("GAP1 customer-namespace refs are not SAP refs, and cannot supply the evidence", () => {
  const c = groundCandidates(withEdges("ZONLY", ["ZCL_HELPER", "ZIF_THING"]));
  assert.equal(c.ZONLY.grounding_certainty, 0.8, "Z/Y targets say nothing about released-API cleanliness");
});
