import { test } from "node:test";
import assert from "node:assert/strict";
import { curateFindings, atcCheckIdFor } from "../src/curation.js";

// Static-first curation (arch spec §3.B, conv #17): assign source_category, a
// grade routed total+disjoint BY FAMILY, atc_priority and atcCheckId. Registry-
// grounded families grade via the oracle on their referenced object; all others
// via the finding's severity. Real oracle + real registry anchors, no mocks.

test("registry-family grade is routed through the oracle on referenced_object (conv #17)", () => {
  // referencing a D object (notToBeReleased) -> blocker / P1
  const [d] = curateFindings([{ rule_id: "released-api", family: "released-api", severity: "priority-1", object: "ZCL", referenced_object: "CI_DCLS_CHK" }]);
  assert.equal(d.grade, "blocker");
  assert.equal(d.atc_priority, "P1");
  // referencing a B object (classicAPI) -> advisory (oracle B), even though the
  // rule set severity priority-2 -- the oracle is the grade authority
  const [b] = curateFindings([{ rule_id: "released-api", family: "released-api", severity: "priority-2", object: "ZCL", referenced_object: "/AIF/CL_BGRFC_CLEANUP_UTIL" }]);
  assert.equal(b.grade, "advisory");
  assert.equal(b.atc_priority, "P3");
});

test("non-registry families grade by severity (conv #17 severity path)", () => {
  assert.equal(curateFindings([{ rule_id: "ABAP-PERF-01", family: "performance", severity: "priority-2", object: "ZR" }])[0].grade, "warning");
  assert.equal(curateFindings([{ rule_id: "x", family: "anti-pattern", severity: "priority-1", object: "ZR" }])[0].grade, "blocker");
  assert.equal(curateFindings([{ rule_id: "x", family: "statement-pack", severity: "info", object: "ZR" }])[0].grade, "advisory");
});

test("curateFindings is total — grade + source_category + atcCheckId on every finding", () => {
  const [f] = curateFindings([{ rule_id: "x", family: "unknown-family", severity: "priority-3", object: "ZR" }]);
  assert.equal(f.source_category, "unknown-family");
  assert.equal(f.grade, "advisory");
  assert.equal(f.atc_priority, "P3");
  assert.equal(f.atcCheckId, "SYCM_USAGE_OF_APIS", "default atcCheckId");
  // a registry family with NO referenced_object falls back to severity, still total
  assert.equal(curateFindings([{ rule_id: "released-api", family: "released-api", severity: "priority-1", object: "ZR" }])[0].grade, "blocker");
});

test("atcCheckIdFor maps families per §15.7", () => {
  assert.equal(atcCheckIdFor("released-api"), "SYCM_USAGE_OF_APIS");
  assert.equal(atcCheckIdFor("statement-pack"), "CI_CRITICAL_STATEMENTS");
  assert.equal(atcCheckIdFor("invariant"), "SLIN_SEC");
  assert.equal(atcCheckIdFor("whatever-else"), "SYCM_USAGE_OF_APIS");
});
