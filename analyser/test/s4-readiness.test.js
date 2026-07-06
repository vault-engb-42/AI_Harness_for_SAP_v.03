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

test("no classifiable edges yields 100% (nothing at risk)", () => {
  const g = graphWith([{ source: "A", target: "A.M", kind: "call-method" }]);
  const r = computeReadiness(g, cloud);
  assert.equal(r.total_api_calls, 0);
  assert.equal(r.s4_readiness_pct, 100);
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
