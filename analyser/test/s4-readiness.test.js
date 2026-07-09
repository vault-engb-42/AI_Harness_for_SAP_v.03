import { test } from "node:test";
import assert from "node:assert/strict";
import { DependencyGraph } from "../src/cpg.js";
import * as cloud from "../src/cloudification.js";
import { computeReadiness } from "../src/s4-readiness.js";

// Object-level readiness: an object is "ready" for a target when it carries NO
// blocking finding. readiness_pct = the share of customer objects with no blocker —
// measured over ALL the analyser's checks, not a handful of registry dependency
// edges. S/4HANA blockers = deprecated/removed SAP objects + modifications; Cloud
// blockers = those PLUS non-cloud code patterns (clean-core, security). Classic
// patterns run on S/4 on-prem, so they block Cloud but NOT S/4. Real oracle, no mocks.

function graphWith(nodes, edges = []) {
  const g = new DependencyGraph();
  for (const n of nodes) g.addNode(n);
  for (const e of edges) g.addEdge(e);
  return g;
}
const custClass = (name) => ({ id: name, kind: "class", object: name, namespace: "Z" });

test("object-level: clean-core blocks Cloud but not S/4 (classic patterns run on-prem)", () => {
  const g = graphWith([custClass("ZCL_A"), custClass("ZCL_B")]);
  const findings = [{ object: "ZCL_A", family: "clean-core", severity: "priority-1", message: "CALL FUNCTION" }];
  const r = computeReadiness(g, findings, cloud);
  assert.equal(r.total_objects, 2);
  assert.equal(r.cloud_blocked_objects, 1, "ZCL_A cloud-blocked by clean-core");
  assert.equal(r.s4_blocked_objects, 0, "clean-core still runs on S/4 on-prem");
  assert.equal(r.cloud_readiness_pct, 50, "1 of 2 objects cloud-ready");
  assert.equal(r.s4_readiness_pct, 100, "both S/4-ready");
});

test("deprecation + modification block BOTH S/4 and Cloud", () => {
  const g = graphWith([custClass("ZCL_A"), custClass("ZCL_B"), custClass("ZCL_C")]);
  const findings = [
    { object: "ZCL_A", family: "deprecation", severity: "priority-1", message: "deprecated table" },
    { object: "ZCL_B", family: "modification", severity: "priority-2", message: "mod to SAP standard" },
  ];
  const r = computeReadiness(g, findings, cloud);
  assert.equal(r.s4_blocked_objects, 2);
  assert.equal(r.cloud_blocked_objects, 2);
  assert.equal(r.s4_readiness_pct, 33, "1 of 3 S/4-ready");
  assert.equal(r.cloud_readiness_pct, 33);
});

test("released-api blocks S/4 only for deprecated/removed (grade blocker/warning), not classicAPI (advisory)", () => {
  const g = graphWith([custClass("ZCL_REMOVED"), custClass("ZCL_CLASSIC")]);
  const findings = [
    { object: "ZCL_REMOVED", family: "released-api", grade: "blocker", severity: "priority-1", message: "removed SAP table" },
    { object: "ZCL_CLASSIC", family: "released-api", grade: "advisory", severity: "priority-2", message: "classicAPI" },
  ];
  const r = computeReadiness(g, findings, cloud);
  assert.equal(r.s4_blocked_objects, 1, "only the removed-object user is S/4-blocked");
  assert.equal(r.cloud_blocked_objects, 2, "both are cloud-blocked (non-released)");
});

test("performance / abaplint / anti-pattern are debt, not readiness blockers", () => {
  const g = graphWith([custClass("ZCL_A")]);
  const findings = [
    { object: "ZCL_A", family: "performance", severity: "priority-1", message: "SELECT *" },
    { object: "ZCL_A", family: "abaplint", severity: "priority-3", message: "naming" },
  ];
  const r = computeReadiness(g, findings, cloud);
  assert.equal(r.s4_readiness_pct, 100);
  assert.equal(r.cloud_readiness_pct, 100, "slow/ugly code still runs — not a readiness blocker");
});

test("empty package: no objects -> trivially 100% ready for both", () => {
  const r = computeReadiness(graphWith([]), [], cloud);
  assert.equal(r.total_objects, 0);
  assert.equal(r.s4_readiness_pct, 100);
  assert.equal(r.cloud_readiness_pct, 100);
});

test("API dependency hygiene (secondary detail): edges tallied by oracle Level", () => {
  const g = graphWith(
    [custClass("ZCL_X")],
    [
      { source: "ZCL_X", target: "/ATL/BLART_RANGE", kind: "uses-table" }, // A released
      { source: "ZCL_X", target: "BAPIRET1", kind: "uses-table" }, // C deprecated
      { source: "ZCL_X", target: "CF_REBD_BUILDING", kind: "call-function" }, // D removed (noAPI)
      { source: "ZCL_X", target: "ZCL_HELPER", kind: "call-function" }, // unknown (customer) -> excluded
    ],
  );
  const r = computeReadiness(g, [], cloud);
  assert.equal(r.released_hits, 1);
  assert.equal(r.deprecated_hits, 1);
  assert.equal(r.not_released_hits, 1);
  assert.equal(r.total_api_calls, 3, "customer edge excluded from the dependency tally");
});
