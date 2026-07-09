import { test } from "node:test";
import assert from "node:assert/strict";
import { DependencyGraph } from "../src/cpg.js";
import * as cloud from "../src/cloudification.js";
import { computeReadiness } from "../src/s4-readiness.js";

function graphWith(edges) {
  const g = new DependencyGraph();
  for (const e of edges) g.addEdge(e);
  return g;
}

test("readiness tallies released / deprecated / removed API edges", () => {
  const g = graphWith([
    { source: "ZCL_X", target: "/ATL/BLART_RANGE", kind: "uses-table" }, // released
    { source: "ZCL_X", target: "BAPIRET1", kind: "uses-table" }, // deprecated
    { source: "ZCL_Y", target: "CL_A4C_BC_FACTORY", kind: "inherits" }, // deprecated
    { source: "ZCL_Y", target: "ZCL_HELPER", kind: "call-function" }, // unknown (customer) -> excluded
  ]);
  const r = computeReadiness(g, cloud);
  assert.equal(r.released_hits, 1);
  assert.equal(r.deprecated_hits, 2);
  assert.equal(r.total_api_calls, 3, "customer edge excluded from denominator");
  assert.equal(r.s4_readiness_pct, 33); // 1/3
});

test("no classifiable edges: S/4 100% (nothing at risk) but Cloud 0% (nothing cloud-released)", () => {
  const g = graphWith([{ source: "A", target: "A.M", kind: "call-method" }]);
  const r = computeReadiness(g, cloud);
  assert.equal(r.total_api_calls, 0);
  assert.equal(r.s4_readiness_pct, 100, "empty = trivially S/4-ready");
  assert.equal(r.cloud_readiness_pct, 0, "empty = nothing cloud-released (distinct sentinel from S/4)");
});

test("all-released package is 100% ready", () => {
  const g = graphWith([{ source: "ZCL_X", target: "/ATL/BLART_RANGE", kind: "uses-table" }]);
  const r = computeReadiness(g, cloud);
  assert.equal(r.s4_readiness_pct, 100);
  assert.equal(r.released_hits, 1);
});

test("a removed (noAPI) dependency lands in not_released_hits and dilutes readiness", () => {
  const g = graphWith([
    { source: "ZCL_X", target: "/ATL/BLART_RANGE", kind: "uses-table" }, // released
    { source: "ZCL_X", target: "CF_REBD_BUILDING", kind: "call-function" }, // noAPI -> removed
  ]);
  const r = computeReadiness(g, cloud);
  assert.equal(r.not_released_hits, 1, "removed branch tallied");
  assert.equal(r.total_api_calls, 2);
  assert.equal(r.s4_readiness_pct, 50, "removed dilutes the percentage");
});

test("classicAPI (Level B) is S/4-ready but NOT Cloud-ready — the two percentages diverge", () => {
  // The bug: release_state collapses Level B (classicAPI) into 'deprecated', so
  // s4/cloud came out identical. Fix: classify by oracle Level — cloud-ready = A;
  // S/4-ready = A + B (classicAPI runs on S/4 but is not cloud-released).
  const g = graphWith([
    { source: "ZCL_X", target: "/ATL/BLART_RANGE", kind: "uses-table" }, // A released
    { source: "ZCL_X", target: "/AIF/CL_BGRFC_CLEANUP_UTIL", kind: "inherits" }, // B classicAPI (classifications-only, so release-info-wins keeps it B)
    { source: "ZCL_X", target: "CF_REBD_BUILDING", kind: "call-function" }, // D removed
  ]);
  const r = computeReadiness(g, cloud);
  // a=1, b=1, d=1, total=3.
  assert.equal(r.classic_api_hits, 1, "classicAPI tallied separately, not folded into deprecated");
  assert.equal(r.released_hits, 1);
  assert.equal(r.not_released_hits, 1);
  assert.equal(r.total_api_calls, 3);
  assert.equal(r.cloud_readiness_pct, 33, "only released (A) is cloud-ready: 1/3");
  assert.equal(r.s4_readiness_pct, 67, "released + classicAPI (A+B) run on S/4: 2/3");
  assert.notEqual(r.s4_readiness_pct, r.cloud_readiness_pct, "S/4 and Cloud readiness are now distinct");
});
