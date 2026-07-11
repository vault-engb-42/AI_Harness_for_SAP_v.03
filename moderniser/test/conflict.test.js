import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildConflictGraph } from "../src/graph/conflict.js";

// §3.1 Stage 4 (L4) — the CONFLICT graph. Reference-edge independence is insufficient:
// two nodes also conflict if they share a program pool (function-group co-tenancy), a
// DDIC object or its base (append/include), a lock object, a number-range, or a transport.
// Represented as per-node `keysOf` (frontier's DIRECT-conflict check — no O(k^2) clique),
// `buckets` (nodes per shared resource, for observability + collapse), and `groups`
// (transitive co-tenant clusters ≥2 that must move together). Pure; metadata injected by
// SCOPE — absent on the raw CPG.

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = JSON.parse(readFileSync(join(HERE, "fixtures", "analyser-findings.json"), "utf8"));

test("keysOf lists each node's namespaced resource keys, sorted; keyless nodes are []", () => {
  const g = buildConflictGraph([{ id: "A", program_pool: "P", ddic: ["T"] }, { id: "B" }]);
  assert.deepEqual(g.keysOf.A, ["ddic:T", "pool:P"]);
  assert.deepEqual(g.keysOf.B, []);
});

test("all five conflict sources are recognised (function_group aliases program pool)", () => {
  const keys = (extra) => buildConflictGraph([{ id: "A", ...extra }]).keysOf.A;
  assert.deepEqual(keys({ program_pool: "G" }), ["pool:G"]);
  assert.deepEqual(keys({ function_group: "G" }), ["pool:G"]);
  assert.deepEqual(keys({ ddic: ["T"] }), ["ddic:T"]);
  assert.deepEqual(keys({ locks: ["L"] }), ["lock:L"]);
  assert.deepEqual(keys({ number_ranges: ["N"] }), ["nr:N"]);
  assert.deepEqual(keys({ transport: "TR" }), ["tr:TR"]);
});

test("buckets group node ids by shared resource key, sorted", () => {
  const g = buildConflictGraph([{ id: "A", program_pool: "P" }, { id: "B", program_pool: "P" }, { id: "C", ddic: ["T"] }]);
  assert.deepEqual(g.buckets["pool:P"], ["A", "B"]);
  assert.deepEqual(g.buckets["ddic:T"], ["C"]);
});

test("groups are transitive connected components of size >=2; singletons excluded", () => {
  const g = buildConflictGraph([
    { id: "A", program_pool: "P" },
    { id: "B", program_pool: "P", ddic: ["T"] },
    { id: "C", ddic: ["T"] },
    { id: "X" },
  ]);
  assert.deepEqual(g.groups, [["A", "B", "C"]]);
  assert.ok(!g.groups.flat().includes("X"));
});

test("nodes sharing no resource form no group", () => {
  assert.deepEqual(buildConflictGraph([{ id: "A", program_pool: "P1" }, { id: "B", program_pool: "P2" }]).groups, []);
});

test("buildConflictGraph is deterministic and independent of node input order", () => {
  const nodes = [{ id: "A", program_pool: "P" }, { id: "B", ddic: ["T"] }, { id: "C", program_pool: "P", ddic: ["T"] }];
  assert.equal(JSON.stringify(buildConflictGraph(nodes)), JSON.stringify(buildConflictGraph([...nodes].reverse())));
});

test("the raw golden CPG (no resource metadata) yields empty buckets and groups", () => {
  const g = buildConflictGraph(DOC.graph.nodes);
  assert.deepEqual(g.buckets, {});
  assert.deepEqual(g.groups, []);
  assert.equal(Object.keys(g.keysOf).length, DOC.graph.nodes.length, "every node present");
  assert.ok(Object.values(g.keysOf).every((k) => k.length === 0), "all keyless");
});

test("program_pools[] (plural, super-node-keyed) contributes every pool as a key", () => {
  // §3.1 Stage 4 wiring contract: a super-node aggregates its members' resources — a
  // 2-pool SCC must carry BOTH pool keys, or its conflicts are silently lost.
  const g = buildConflictGraph([
    { id: "S1", program_pools: ["POOL_A", "POOL_B"] },
    { id: "X", program_pool: "POOL_B" },
  ]);
  assert.deepEqual(g.keysOf.S1, ["pool:POOL_A", "pool:POOL_B"]);
  assert.deepEqual(g.groups, [["S1", "X"]], "S1 conflicts with X via its second pool");
});

test("a large co-tenant bucket stays LINEAR — no O(k^2) clique materialisation", () => {
  const n = 2000;
  const nodes = Array.from({ length: n }, (_, i) => ({ id: "F" + String(i).padStart(5, "0"), program_pool: "SAPLBIG" }));
  const g = buildConflictGraph(nodes);
  assert.equal(g.buckets["pool:SAPLBIG"].length, n, "one bucket with k members (not k^2 edges)");
  assert.equal(g.groups.length, 1);
  assert.equal(g.groups[0].length, n);
});
