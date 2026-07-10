import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildConflictGraph } from "../src/graph/conflict.js";

// §3.1 Stage 4 (L4) — the CONFLICT graph. Reference-edge independence is insufficient:
// two nodes also conflict if they share a program pool (function-group co-tenancy), a
// DDIC object or its base (append/include), a lock object, a number-range, or a transport.
// Undirected. Returns direct-conflict `adjacency` (frontier's both-graph independence),
// transitive `groups` (co-tenant clusters that must move together), per-edge `reasons`.
// Pure; resource metadata is injected (populated later by SCOPE) — absent on the raw CPG.

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = JSON.parse(readFileSync(join(HERE, "fixtures", "analyser-findings.json"), "utf8"));
const ek = (a, b) => JSON.stringify([a, b]);

test("two nodes sharing a program pool get one undirected conflict edge", () => {
  const g = buildConflictGraph([{ id: "A", program_pool: "SAPLZFG" }, { id: "B", program_pool: "SAPLZFG" }, { id: "C" }]);
  assert.deepEqual(g.edges, [["A", "B"]]);
  assert.deepEqual(g.adjacency, { A: ["B"], B: ["A"], C: [] });
  assert.deepEqual(g.reasons[ek("A", "B")], ["pool:SAPLZFG"]);
});

test("shared DDIC / lock / number-range / transport each form a conflict edge", () => {
  const mk = (extra) => buildConflictGraph([{ id: "A", ...extra }, { id: "B", ...extra }]).edges;
  assert.deepEqual(mk({ ddic: ["SKB1"] }), [["A", "B"]]);
  assert.deepEqual(mk({ locks: ["EZ_ZFI"] }), [["A", "B"]]);
  assert.deepEqual(mk({ number_ranges: ["NR01"] }), [["A", "B"]]);
  assert.deepEqual(mk({ transport: "DEVK900001" }), [["A", "B"]]);
});

test("nodes sharing no resource have no conflict edge or group", () => {
  const g = buildConflictGraph([{ id: "A", program_pool: "P1" }, { id: "B", program_pool: "P2" }]);
  assert.deepEqual(g.edges, []);
  assert.deepEqual(g.groups, []);
});

test("an edge's reasons list ALL shared resources, sorted", () => {
  const g = buildConflictGraph([{ id: "A", program_pool: "P", ddic: ["T"] }, { id: "B", program_pool: "P", ddic: ["T"] }]);
  assert.deepEqual(g.reasons[ek("A", "B")], ["ddic:T", "pool:P"]);
});

test("groups are transitive connected components; direct adjacency is NOT transitive", () => {
  const g = buildConflictGraph([
    { id: "A", program_pool: "P" },
    { id: "B", program_pool: "P", ddic: ["T"] },
    { id: "C", ddic: ["T"] },
  ]);
  assert.deepEqual(g.groups, [["A", "B", "C"]], "transitive co-tenant cluster");
  assert.deepEqual(g.adjacency.A, ["B"], "A and C share nothing directly");
  assert.deepEqual(g.adjacency.B, ["A", "C"]);
  assert.deepEqual(g.edges, [["A", "B"], ["B", "C"]]);
});

test("three co-pool nodes form a clique and a single group", () => {
  const g = buildConflictGraph([{ id: "A", program_pool: "P" }, { id: "B", program_pool: "P" }, { id: "C", program_pool: "P" }]);
  assert.deepEqual(g.edges, [["A", "B"], ["A", "C"], ["B", "C"]]);
  assert.deepEqual(g.groups, [["A", "B", "C"]]);
});

test("an isolated node is in no group", () => {
  const g = buildConflictGraph([{ id: "A", program_pool: "P" }, { id: "B", program_pool: "P" }, { id: "X" }]);
  assert.deepEqual(g.groups, [["A", "B"]]);
  assert.ok(!g.groups.flat().includes("X"));
});

test("buildConflictGraph is deterministic and independent of node input order", () => {
  const nodes = [{ id: "A", program_pool: "P" }, { id: "B", ddic: ["T"] }, { id: "C", program_pool: "P", ddic: ["T"] }];
  assert.equal(JSON.stringify(buildConflictGraph(nodes)), JSON.stringify(buildConflictGraph([...nodes].reverse())));
});

test("the raw golden CPG (no resource metadata) has an empty conflict graph", () => {
  const g = buildConflictGraph(DOC.graph.nodes);
  assert.deepEqual(g.edges, []);
  assert.deepEqual(g.groups, []);
  assert.ok(Object.values(g.adjacency).every((a) => a.length === 0));
  assert.equal(Object.keys(g.adjacency).length, DOC.graph.nodes.length, "every node present, all isolated");
});
