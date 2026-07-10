import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildObjectGraph } from "../src/graph/build.js";

// §6.2 / §3.1 — collapse the analyser's method/form-level CPG (graph.nodes/edges) into the
// OBJECT-level dependency graph the scheduler operates on (a "node" is a CPG object; a RAP
// artifact-set is one super-node, L1). Mirrors analyser html-graph.js `objectLevelGraph`,
// but PRESERVES edge kinds (the moderniser needs `includes` for program-pool derivation,
// `uses-table` for blast/DDIC). Pure; deterministic (sorted).

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = JSON.parse(readFileSync(join(HERE, "fixtures", "analyser-findings.json"), "utf8"));

test("nodes with the same object collapse to one; intra-object edges are dropped", () => {
  const doc = {
    graph: {
      nodes: [
        { id: "P", object: "P", kind: "report", namespace: "Z", rank: 0.5 },
        { id: "P.F1", object: "P", kind: "form", namespace: "Z", rank: 0.9 },
        { id: "Q", object: "Q", kind: "table", namespace: "sap", rank: 0.2 },
      ],
      edges: [{ source: "P", target: "P.F1", kind: "calls" }], // intra-object → self-loop → dropped
    },
  };
  const g = buildObjectGraph(doc);
  assert.deepEqual(g.nodes.map((n) => n.id), ["P", "Q"]);
  assert.deepEqual(g.edges, []);
});

test("inter-object edges are preserved with their kind, collapsed to object endpoints", () => {
  const doc = {
    graph: {
      nodes: [
        { id: "P", object: "P", kind: "report", namespace: "Z" },
        { id: "P.F1", object: "P", kind: "form", namespace: "Z" },
        { id: "T", object: "T", kind: "table", namespace: "sap" },
      ],
      edges: [{ source: "P.F1", target: "T", kind: "uses-table" }],
    },
  };
  assert.deepEqual(buildObjectGraph(doc).edges, [{ source: "P", target: "T", kind: "uses-table" }]);
});

test("parallel edges of the same kind dedupe; different kinds are kept distinct", () => {
  const doc = {
    graph: {
      nodes: [{ id: "A", object: "A", kind: "report", namespace: "Z" }, { id: "B", object: "B", kind: "report", namespace: "Z" }],
      edges: [
        { source: "A", target: "B", kind: "calls" },
        { source: "A", target: "B", kind: "calls" },
        { source: "A", target: "B", kind: "includes" },
      ],
    },
  };
  assert.deepEqual(buildObjectGraph(doc).edges, [
    { source: "A", target: "B", kind: "calls" },
    { source: "A", target: "B", kind: "includes" },
  ]);
});

test("object attributes: kind/namespace from the id===object node, rank = max over the object's nodes", () => {
  const doc = {
    graph: {
      nodes: [
        { id: "P.F1", object: "P", kind: "form", namespace: "Z", rank: 0.9 },
        { id: "P", object: "P", kind: "report", namespace: "Z", rank: 0.4 },
      ],
      edges: [],
    },
  };
  const p = buildObjectGraph(doc).nodes[0];
  assert.equal(p.kind, "report", "prefer the object's own top node, not a form");
  assert.equal(p.rank, 0.9, "max rank across the object's nodes");
});

test("an edge endpoint object with no node of its own still appears as a node", () => {
  const doc = {
    graph: {
      nodes: [{ id: "A", object: "A", kind: "report", namespace: "Z" }],
      edges: [{ source: "A", target: "X", kind: "call-function" }], // X has no node
    },
  };
  const g = buildObjectGraph(doc);
  assert.ok(g.nodes.some((n) => n.id === "X"));
  assert.deepEqual(g.edges, [{ source: "A", target: "X", kind: "call-function" }]);
});

test("buildObjectGraph is deterministic and independent of node/edge input order", () => {
  const g1 = buildObjectGraph(DOC);
  const shuffled = { graph: { nodes: [...DOC.graph.nodes].reverse(), edges: [...DOC.graph.edges].reverse() } };
  assert.equal(JSON.stringify(g1), JSON.stringify(buildObjectGraph(shuffled)));
});

test("kind/namespace of an object with NO id===object node is deterministic (min-by-id sub-node)", () => {
  const mk = (nodes) => buildObjectGraph({ graph: { nodes, edges: [] } }).nodes[0];
  const a = mk([{ id: "C.M1", object: "C", kind: "method", namespace: "sap" }, { id: "C.EVT", object: "C", kind: "event", namespace: "Z" }]);
  const b = mk([{ id: "C.EVT", object: "C", kind: "event", namespace: "Z" }, { id: "C.M1", object: "C", kind: "method", namespace: "sap" }]);
  assert.equal(a.kind, b.kind, "kind independent of input order");
  assert.equal(a.namespace, b.namespace);
  assert.equal(a.kind, "event", "C.EVT sorts before C.M1 → its attrs win");
});

test("the golden ZFICO fixture collapses to 11 objects with the expected inter-object edges", () => {
  const g = buildObjectGraph(DOC);
  assert.equal(g.nodes.length, 11, "18 CPG nodes (7 forms under GL) → 11 objects");
  const ids = g.nodes.map((n) => n.id);
  assert.ok(ids.includes("ZFICO_BTC_CSV_GL") && ids.includes("ZFICO_BTC_CSV_SCR") && ids.includes("ZFICO_BTC_CSV_TOP"));
  const has = (s, t, k) => g.edges.some((e) => e.source === s && e.target === t && e.kind === k);
  assert.ok(has("ZFICO_BTC_CSV_GL", "ZFICO_BTC_CSV_SCR", "includes"), "GL includes SCR");
  assert.ok(has("ZFICO_BTC_CSV_GL", "SKB1", "uses-table"), "GL uses SKB1");
  assert.ok(has("ZFICO_BTC_CSV_SCR", "KD_GET_FILENAME_ON_F4", "call-function"), "SCR calls KD_GET");
  assert.ok(!g.edges.some((e) => e.source === e.target), "no self-loops (forms collapsed into GL)");
  // GL is the entry (nothing points to it) — top-down scheduler convention, §3.1
  assert.ok(!g.edges.some((e) => e.target === "ZFICO_BTC_CSV_GL"), "GL has no in-edges (in-degree-0 root)");
});
