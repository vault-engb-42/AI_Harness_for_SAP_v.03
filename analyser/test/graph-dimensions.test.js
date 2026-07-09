import { test } from "node:test";
import assert from "node:assert/strict";
import { layers, boundaries } from "../src/graph-dimensions.js";

// layers + boundaries dimensions (arch spec §3.C), derived deterministically from
// the CPG graph JSON. layers: entry (nothing calls it) / internal (called) / data
// (tables). boundaries: compilation-unit objects called INTO from a different
// object (inbound interface surfaces) — member->owner resolved via node.object.

const G = {
  nodes: [
    { id: "ZR_MAIN", kind: "report", object: "ZR_MAIN" },
    { id: "ZCL_SVC", kind: "class", object: "ZCL_SVC" },
    { id: "ZCL_SVC=>run", kind: "method", object: "ZCL_SVC" },
    { id: "KNA1", kind: "table", object: "KNA1" },
  ],
  edges: [
    { source: "ZR_MAIN", target: "ZCL_SVC=>run", kind: "call-method" },
    { source: "ZCL_SVC=>run", target: "KNA1", kind: "uses-table" },
  ],
};

test("layers assigns entry / internal / data by graph topology, sorted", () => {
  assert.deepEqual(layers(G), {
    entry: ["ZCL_SVC", "ZR_MAIN"], // report + class node: not the target of a call edge
    internal: ["ZCL_SVC=>run"], //     the method IS called
    data: ["KNA1"], //                 tables are data
  });
});

test("layers is total on empty graph", () => {
  assert.deepEqual(layers({ nodes: [], edges: [] }), { entry: [], internal: [], data: [] });
});

test("boundaries lists compilation-unit objects called into from a DIFFERENT object (inbound)", () => {
  // ZR_MAIN calls ZCL_SVC.run -> ZCL_SVC (its owner) is an inbound boundary.
  assert.deepEqual(boundaries(G), [{ name: "ZCL_SVC", kind: "class", direction: "inbound" }]);
});

test("boundaries excludes tables and self-internal calls; deterministic + sorted", () => {
  const g2 = {
    nodes: [
      { id: "ZCL_A", kind: "class", object: "ZCL_A" },
      { id: "ZCL_A=>m", kind: "method", object: "ZCL_A" },
      { id: "ZCL_A=>n", kind: "method", object: "ZCL_A" },
    ],
    // an intra-object call (m -> n, same owner ZCL_A) is NOT a boundary
    edges: [{ source: "ZCL_A=>m", target: "ZCL_A=>n", kind: "call-method" }],
  };
  assert.deepEqual(boundaries(g2), []);
});
