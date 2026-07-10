import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { kahnLevels } from "../src/sched/levels.js";
import { tarjanCondense } from "../src/graph/condense.js";
import { overApproximateEdges } from "../src/graph/augment.js";
import { precedenceEdges } from "../src/graph/build.js";

// §3.1 Stage 3 (L2/L6) — topological levels over the SCC-condensed DAG via Kahn peeling
// (level = longest predecessor chain = earliest wave). Returns the INITIAL in-degree map
// as the seed for the scheduler's resumable live-decrementing counter. Within a level,
// order worst-debt-first: (clean_core_grade D→A, migration_complexity desc, blast desc,
// id asc). Pure; iterative (no recursion at the 100K+-LOC scale).

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = JSON.parse(readFileSync(join(HERE, "fixtures", "analyser-findings.json"), "utf8"));

const cond = (ids, edges) => tarjanCondense(ids, edges);

test("a chain levels 1:1 with the correct in-degree seed", () => {
  const r = kahnLevels(cond(["A", "B", "C"], [["A", "B"], ["B", "C"]]));
  assert.deepEqual(r.levels, [["A"], ["B"], ["C"]]);
  assert.deepEqual(r.levelOf, { A: 0, B: 1, C: 2 });
  assert.deepEqual(r.indegree, { A: 0, B: 1, C: 1 });
});

test("a diamond levels the join at level 2 with in-degree 2", () => {
  const r = kahnLevels(cond(["A", "B", "C", "D"], [["A", "B"], ["A", "C"], ["B", "D"], ["C", "D"]]));
  assert.deepEqual(r.levels[0], ["A"]);
  assert.deepEqual(r.levels[1], ["B", "C"]); // no meta -> id-sort
  assert.deepEqual(r.levels[2], ["D"]);
  assert.equal(r.indegree.D, 2);
});

test("within a level, worst clean_core_grade (D→A) sorts first", () => {
  const r = kahnLevels(cond(["A", "B", "C"], [["A", "B"], ["A", "C"]]), { B: { grade: "A" }, C: { grade: "D" } });
  assert.deepEqual(r.levels[1], ["C", "B"]);
});

test("grade ties break by migration_complexity desc, then blast desc, then id asc", () => {
  const g = cond(["A", "B", "C"], [["A", "B"], ["A", "C"]]);
  assert.deepEqual(kahnLevels(g, { B: { grade: "C", complexity: 1 }, C: { grade: "C", complexity: 5 } }).levels[1], ["C", "B"]);
  assert.deepEqual(
    kahnLevels(g, { B: { grade: "C", complexity: 2, blast: 1 }, C: { grade: "C", complexity: 2, blast: 9 } }).levels[1],
    ["C", "B"],
  );
  assert.deepEqual(kahnLevels(g, { B: { grade: "C" }, C: { grade: "C" } }).levels[1], ["B", "C"]); // full tie -> id
});

test("a multi-member super-node inherits its WORST member's composite key", () => {
  // R -> cyc(A,B) and R -> C; super-node A (members A,B) vs singleton C at level 1
  const g = cond(["R", "A", "B", "C"], [["R", "A"], ["A", "B"], ["B", "A"], ["R", "C"]]);
  const superA = g.superNodes.find((s) => s.id === "A");
  assert.deepEqual(superA.members, ["A", "B"]);
  const r = kahnLevels(g, { A: { grade: "A" }, B: { grade: "D" }, C: { grade: "C" } });
  assert.deepEqual(r.levels[1], ["A", "C"]); // super-A aggregates B's grade D -> beats C's grade C
});

test("isolated nodes are all level 0", () => {
  assert.deepEqual(kahnLevels(cond(["A", "B"], [])).levels, [["A", "B"]]);
});

test("the indegree seed is byte-stable regardless of super-node array order", () => {
  const mk = (superNodes) => JSON.stringify(kahnLevels({ superNodes, edges: [["A", "B"]] }).indegree);
  assert.equal(mk([{ id: "A", members: ["A"] }, { id: "B", members: ["B"] }]), mk([{ id: "B", members: ["B"] }, { id: "A", members: ["A"] }]));
});

test("kahnLevels is deterministic and independent of node/edge input order", () => {
  const c1 = cond(["A", "B", "C", "D"], [["A", "B"], ["A", "C"], ["B", "D"], ["C", "D"]]);
  const c2 = cond(["D", "C", "B", "A"], [["C", "D"], ["B", "D"], ["A", "C"], ["A", "B"]]);
  assert.equal(JSON.stringify(kahnLevels(c1)), JSON.stringify(kahnLevels(c2)));
});

test("fails closed if the condensation is not a DAG (invariant: condense guarantees acyclic)", () => {
  const bad = {
    superNodes: [{ id: "A", members: ["A"] }, { id: "B", members: ["B"] }],
    edges: [["A", "B"], ["B", "A"]],
    superOf: { A: "A", B: "B" },
  };
  assert.throws(() => kahnLevels(bad), /DAG|cycle|acyclic/i);
});

test("the golden fixture levels BOTTOM-UP: leaves first, the entry report alone in the last wave", () => {
  const g = overApproximateEdges({ nodes: DOC.graph.nodes, edges: DOC.graph.edges });
  const c = tarjanCondense(g.nodes.map((n) => n.id), precedenceEdges(g.edges)); // dependency→dependent (ratified 2026-07-11)
  const r = kahnLevels(c, metaFromDoc(DOC));
  assert.equal(Object.keys(r.levelOf).length, c.superNodes.length, "every super-node leveled");
  assert.equal(r.levels.length, 3);
  assert.ok(r.levels[0].includes("KD_GET_FILENAME_ON_F4") && r.levels[0].includes("ZFICO_BTC_CSV_TOP"), "leaves at level 0");
  assert.deepEqual([...r.levels[1]].sort(), ["ZFICO_BTC_CSV_GL.UPLOAD_FILE", "ZFICO_BTC_CSV_SCR"]);
  assert.deepEqual(r.levels[2], ["ZFICO_BTC_CSV_GL"], "the entry report schedules LAST");
  assert.equal(JSON.stringify(r), JSON.stringify(kahnLevels(c, metaFromDoc(DOC))), "deterministic");
});

function metaFromDoc(doc) {
  const cx = Object.fromEntries(doc.modernization_plan.objects.map((o) => [o.object, o.migration_complexity]));
  const bl = Object.fromEntries(doc.blast_radius.map((b) => [b.object, b.affected_program_count]));
  const meta = {};
  for (const n of doc.graph.nodes) meta[n.id] = { grade: n.clean_core_grade, complexity: cx[n.object] || 0, blast: bl[n.object] || 0 };
  return meta;
}
