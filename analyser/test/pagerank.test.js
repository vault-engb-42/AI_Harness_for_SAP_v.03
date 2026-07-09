import { test } from "node:test";
import assert from "node:assert/strict";
import { pageRank } from "../src/pagerank.js";

// PageRank over the CPG (arch spec §3.C top_objects / §3.D priority_rank), per
// TALOS_ANALYSER_INTERNALS.md §5: power iteration keyed by node id, damping 0.85,
// dangling mass redistributed, phantom endpoints for unresolved edges. Pure +
// deterministic.

test("pageRank ranks a hub (2 incoming) above its symmetric sources; scores sum to 1", () => {
  const g = {
    nodes: [{ id: "A" }, { id: "B" }, { id: "C" }],
    edges: [
      { source: "A", target: "B", kind: "calls" },
      { source: "C", target: "B", kind: "calls" },
    ],
  };
  const r = pageRank(g);
  assert.ok(r.get("B") > r.get("A"), "the hub outranks its sources");
  assert.ok(Math.abs(r.get("A") - r.get("C")) < 1e-12, "symmetric sources rank equal");
  assert.ok(Math.abs([...r.values()].reduce((a, b) => a + b, 0) - 1) < 1e-6, "scores form a distribution (sum 1)");
});

test("pageRank ranks phantom edge endpoints not present in nodes", () => {
  const r = pageRank({ nodes: [{ id: "A" }], edges: [{ source: "A", target: "PHANTOM", kind: "calls" }] });
  assert.ok(r.has("PHANTOM"), "an unresolved edge target still gets a rank");
});

test("pageRank is deterministic and total on the empty graph", () => {
  const g = { nodes: [{ id: "A" }, { id: "B" }], edges: [{ source: "A", target: "B", kind: "calls" }] };
  assert.deepEqual([...pageRank(g).entries()], [...pageRank(g).entries()]);
  assert.deepEqual([...pageRank({ nodes: [], edges: [] }).entries()], []);
});
