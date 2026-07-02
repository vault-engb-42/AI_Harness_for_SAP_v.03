import { test } from "node:test";
import assert from "node:assert/strict";
import { DependencyGraph } from "../src/cpg.js";

test("addNode stores a node and dedups by id (first-write-wins on kind)", () => {
  const g = new DependencyGraph();
  g.addNode({ id: "ZCL_A", kind: "class", object: "ZCL_A", namespace: "Z" });
  g.addNode({ id: "ZCL_A", kind: "table", object: "ZCL_A", namespace: "Z" });
  assert.equal(g.nodeCount(), 1);
  assert.equal(g.getNode("ZCL_A").kind, "class");
});

test("addNode enriches missing fields on a previously-thin node", () => {
  const g = new DependencyGraph();
  g.addNode({ id: "ZCL_A", kind: "class", object: "ZCL_A" });
  g.addNode({ id: "ZCL_A", kind: "class", object: "ZCL_A", namespace: "Z", clean_core_posture: "level-a" });
  const n = g.getNode("ZCL_A");
  assert.equal(n.namespace, "Z");
  assert.equal(n.clean_core_posture, "level-a");
});

test("addEdge stores an edge and dedups by source|target|kind", () => {
  const g = new DependencyGraph();
  g.addEdge({ source: "A", target: "B", kind: "call-method", evidence: "x:1" });
  g.addEdge({ source: "A", target: "B", kind: "call-method", evidence: "x:2" });
  g.addEdge({ source: "A", target: "B", kind: "uses-table" });
  assert.equal(g.edgeCount(), 2);
});

test("successors and predecessors traverse the directed graph", () => {
  const g = new DependencyGraph();
  g.addEdge({ source: "A", target: "B", kind: "call-method" });
  g.addEdge({ source: "A", target: "C", kind: "uses-table" });
  g.addEdge({ source: "D", target: "B", kind: "call-method" });
  assert.deepEqual(g.successors("A").sort(), ["B", "C"]);
  assert.deepEqual(g.predecessors("B").sort(), ["A", "D"]);
  assert.deepEqual(g.successors("Z"), []);
});

test("hasNode reports membership", () => {
  const g = new DependencyGraph();
  g.addNode({ id: "A", kind: "class", object: "A" });
  assert.equal(g.hasNode("A"), true);
  assert.equal(g.hasNode("B"), false);
});

test("toGraphJSON emits schema-shaped {nodes, edges}", () => {
  const g = new DependencyGraph();
  g.addNode({ id: "A", kind: "class", object: "A", namespace: "Z" });
  g.addEdge({ source: "A", target: "T000", kind: "uses-table", evidence: "a:1" });
  const json = g.toGraphJSON();
  assert.ok(Array.isArray(json.nodes) && Array.isArray(json.edges));
  assert.equal(json.nodes.length, 1);
  assert.equal(json.edges[0].kind, "uses-table");
});
