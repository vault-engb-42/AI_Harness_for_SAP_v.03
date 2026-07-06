import { test } from "node:test";
import assert from "node:assert/strict";
import { DependencyGraph } from "../src/cpg.js";
import { blastRadius } from "../src/blast-radius.js";

/** Build a graph where each node is its own object, wired A->B->C->D->E. */
function chain(ids) {
  const g = new DependencyGraph();
  for (const id of ids) g.addNode({ id, kind: "class", object: id, namespace: "Z" });
  for (let i = 0; i < ids.length - 1; i++) {
    g.addEdge({ source: ids[i], target: ids[i + 1], kind: "call-method" });
  }
  return g;
}

test("blast radius of a leaf reaches all transitive dependents within depth", () => {
  const g = chain(["A", "B", "C", "D"]); // A->B->C->D ; D changing affects C,B,A
  const r = blastRadius(g, "D", 3);
  assert.equal(r.object, "D");
  assert.deepEqual(r.affected_objects, ["A", "B", "C"]);
  assert.equal(r.affected_program_count, 3);
});

test("maxDepth bounds the traversal", () => {
  const g = chain(["A", "B", "C", "D"]);
  const r = blastRadius(g, "D", 1); // only direct dependents: C
  assert.deepEqual(r.affected_objects, ["C"]);
  assert.equal(r.affected_program_count, 1);
});

test("affected nodes are aggregated to their owning object, excluding the target", () => {
  const g = new DependencyGraph();
  g.addNode({ id: "ZCL_A", kind: "class", object: "ZCL_A", namespace: "Z" });
  g.addNode({ id: "ZCL_A.M", kind: "method", object: "ZCL_A", namespace: "Z" });
  g.addNode({ id: "T000", kind: "table", object: "T000", namespace: "sap" });
  g.addEdge({ source: "ZCL_A.M", target: "T000", kind: "uses-table" });
  const r = blastRadius(g, "T000", 3);
  assert.deepEqual(r.affected_objects, ["ZCL_A"]); // method rolls up to its class
  assert.equal(r.affected_program_count, 1);
});

test("an object nothing depends on has an empty, low-impact blast radius", () => {
  const g = chain(["A", "B"]); // A->B ; A is depended on by nobody
  const r = blastRadius(g, "A", 3);
  assert.deepEqual(r.affected_objects, []);
  assert.equal(r.affected_program_count, 0);
  assert.equal(r.highest_impact, "low");
});

test("impact tier scales with the affected-object count", () => {
  const ids = Array.from({ length: 25 }, (_, i) => `N${i}`);
  const g = new DependencyGraph();
  for (const id of ids) g.addNode({ id, kind: "class", object: id, namespace: "Z" });
  // everyone depends directly on HUB
  g.addNode({ id: "HUB", kind: "class", object: "HUB", namespace: "Z" });
  for (const id of ids) g.addEdge({ source: id, target: "HUB", kind: "call-method" });
  const r = blastRadius(g, "HUB", 3);
  assert.equal(r.affected_program_count, 25);
  assert.equal(r.highest_impact, "high"); // 20..49 -> high
});

test("cycles do not cause infinite traversal", () => {
  const g = new DependencyGraph();
  for (const id of ["A", "B", "C"]) g.addNode({ id, kind: "class", object: id, namespace: "Z" });
  g.addEdge({ source: "A", target: "B", kind: "call-method" });
  g.addEdge({ source: "B", target: "C", kind: "call-method" });
  g.addEdge({ source: "C", target: "A", kind: "call-method" }); // cycle
  const r = blastRadius(g, "A", 10);
  assert.deepEqual(r.affected_objects.sort(), ["B", "C"]);
});
