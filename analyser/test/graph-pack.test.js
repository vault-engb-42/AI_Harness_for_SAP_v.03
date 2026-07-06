import { test } from "node:test";
import assert from "node:assert/strict";
import { DependencyGraph } from "../src/cpg.js";
import { graphPack } from "../rules/graph-pack.js";

function run(graph) {
  return graphPack.check({ graph });
}

test("a customer object with high fan-in is flagged as a god object", () => {
  const g = new DependencyGraph();
  g.addNode({ id: "ZCL_HUB", kind: "class", object: "ZCL_HUB", namespace: "Z" });
  for (let i = 0; i < 12; i++) {
    const caller = `ZCL_C${i}`;
    g.addNode({ id: caller, kind: "class", object: caller, namespace: "Z" });
    g.addEdge({ source: caller, target: "ZCL_HUB", kind: "call-method" });
  }
  const f = run(g);
  const hit = f.find((x) => x.rule_id === "talos-god-object");
  assert.ok(hit, "god object flagged");
  assert.equal(hit.object, "ZCL_HUB");
});

test("a SAP hub with high fan-in is NOT flagged (not actionable)", () => {
  const g = new DependencyGraph();
  g.addNode({ id: "T000", kind: "table", object: "T000", namespace: "sap" });
  for (let i = 0; i < 15; i++) {
    const caller = `ZCL_C${i}`;
    g.addNode({ id: caller, kind: "class", object: caller, namespace: "Z" });
    g.addEdge({ source: caller, target: "T000", kind: "uses-table" });
  }
  assert.deepEqual(run(g).filter((x) => x.rule_id === "talos-god-object"), []);
});

test("a dependency cycle among customer objects is flagged", () => {
  const g = new DependencyGraph();
  for (const id of ["ZCL_A", "ZCL_B", "ZCL_C"]) g.addNode({ id, kind: "class", object: id, namespace: "Z" });
  g.addEdge({ source: "ZCL_A", target: "ZCL_B", kind: "call-method" });
  g.addEdge({ source: "ZCL_B", target: "ZCL_C", kind: "call-method" });
  g.addEdge({ source: "ZCL_C", target: "ZCL_A", kind: "call-method" });
  const cyc = run(g).filter((x) => x.rule_id === "talos-dependency-cycle").map((x) => x.object).sort();
  assert.deepEqual(cyc, ["ZCL_A", "ZCL_B", "ZCL_C"]);
});

test("an acyclic customer graph yields no cycle findings", () => {
  const g = new DependencyGraph();
  for (const id of ["ZCL_A", "ZCL_B"]) g.addNode({ id, kind: "class", object: id, namespace: "Z" });
  g.addEdge({ source: "ZCL_A", target: "ZCL_B", kind: "call-method" });
  assert.deepEqual(run(g).filter((x) => x.rule_id === "talos-dependency-cycle"), []);
});

test("a 50k-deep dependency chain does not overflow the stack (iterative Tarjan)", () => {
  const g = new DependencyGraph();
  const N = 50_000;
  for (let i = 0; i < N; i++) {
    g.addNode({ id: `ZC${i}`, kind: "class", object: `ZC${i}`, namespace: "Z" });
    if (i > 0) g.addEdge({ source: `ZC${i - 1}`, target: `ZC${i}`, kind: "call-method" });
  }
  // close one cycle at the deep end so the SCC logic runs the full chain
  g.addEdge({ source: `ZC${N - 1}`, target: `ZC${N - 2}`, kind: "call-method" });
  const f = run(g); // recursion would throw RangeError here before the fix
  const cyc = f.filter((x) => x.rule_id === "talos-dependency-cycle").map((x) => x.object).sort();
  assert.deepEqual(cyc, [`ZC${N - 2}`, `ZC${N - 1}`].sort());
});

test("high fan-out customer object is flagged", () => {
  const g = new DependencyGraph();
  g.addNode({ id: "ZCL_BIG", kind: "class", object: "ZCL_BIG", namespace: "Z" });
  for (let i = 0; i < 22; i++) {
    const dep = `ZCL_D${i}`;
    g.addNode({ id: dep, kind: "class", object: dep, namespace: "Z" });
    g.addEdge({ source: "ZCL_BIG", target: dep, kind: "call-method" });
  }
  assert.ok(run(g).some((x) => x.rule_id === "talos-high-fan-out" && x.object === "ZCL_BIG"));
});
