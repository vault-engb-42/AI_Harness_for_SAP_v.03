import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tarjanCondense } from "../src/graph/condense.js";

// §3.1 Stage 2 / L5 — condense the reference graph into a guaranteed DAG. Each SCC is
// one super-node; a multi-member SCC is a cycle super-node flagged break_gate.
// ITERATIVE (must not stack-overflow at the 100K+-LOC scale).

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = JSON.parse(readFileSync(join(HERE, "fixtures", "analyser-findings.json"), "utf8"));

test("a DAG condenses to singleton super-nodes with edges preserved", () => {
  const { superNodes, edges } = tarjanCondense(["A", "B", "C"], [["A", "B"], ["B", "C"]]);
  assert.equal(superNodes.length, 3);
  assert.ok(superNodes.every((s) => s.members.length === 1 && !s.break_gate));
  assert.deepEqual(edges, [["A", "B"], ["B", "C"]]);
});

test("a cycle collapses to ONE super-node flagged break_gate", () => {
  const { superNodes, edges, superOf } = tarjanCondense(["A", "B", "D"], [["A", "B"], ["B", "A"], ["A", "D"]]);
  const cyc = superNodes.find((s) => s.break_gate);
  assert.deepEqual(cyc.members, ["A", "B"]);
  assert.equal(cyc.id, "A"); // smallest member = representative
  assert.equal(superOf.A, "A");
  assert.equal(superOf.B, "A");
  assert.deepEqual(edges, [["A", "D"]]); // A->B, B->A collapse away; A->D remains
});

test("self-loops and duplicate condensed edges are dropped", () => {
  const { edges } = tarjanCondense(["A", "B"], [["A", "A"], ["A", "B"], ["A", "B"]]);
  assert.deepEqual(edges, [["A", "B"]]);
});

test("the condensation of the golden fixture graph is a DAG (no cyclic super-nodes)", () => {
  const nodeIds = DOC.graph.nodes.map((n) => n.id);
  const edges = DOC.graph.edges.map((e) => [e.source, e.target]);
  const c = tarjanCondense(nodeIds, edges);
  // a DAG has no back edge among super-nodes: reachability must be acyclic
  assert.ok(hasNoCycle(c.superNodes.map((s) => s.id), c.edges), "condensation is acyclic");
  // deterministic
  const c2 = tarjanCondense(nodeIds, edges);
  assert.equal(JSON.stringify(c), JSON.stringify(c2));
});

test("iterative — condenses a 20000-node deep chain without stack overflow", () => {
  const N = 20000;
  const ids = Array.from({ length: N }, (_, i) => "n" + String(i).padStart(6, "0"));
  const edges = ids.slice(0, -1).map((id, i) => [id, ids[i + 1]]);
  const c = tarjanCondense(ids, edges); // a recursive Tarjan would RangeError here
  assert.equal(c.superNodes.length, N);
  assert.ok(c.superNodes.every((s) => !s.break_gate));
});

// Kahn reachability check for the test only (no cycle among super-node ids).
function hasNoCycle(nodes, edges) {
  const indeg = new Map(nodes.map((n) => [n, 0]));
  const adj = new Map(nodes.map((n) => [n, []]));
  for (const [u, v] of edges) { adj.get(u).push(v); indeg.set(v, indeg.get(v) + 1); }
  const q = nodes.filter((n) => indeg.get(n) === 0);
  let seen = 0;
  while (q.length) {
    const n = q.pop();
    seen++;
    for (const w of adj.get(n)) { indeg.set(w, indeg.get(w) - 1); if (indeg.get(w) === 0) q.push(w); }
  }
  return seen === nodes.length;
}
