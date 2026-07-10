import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { nextFrontier } from "../src/sched/frontier.js";
import { tarjanCondense } from "../src/graph/condense.js";
import { overApproximateEdges } from "../src/graph/augment.js";
import { kahnLevels } from "../src/sched/levels.js";

// §3.1 Stage 5 (L2 + L4) — the scheduling loop's frontier selector. A super-node is READY
// iff: status PENDING, its dependency closure is green (live in-degree counter == 0), it is
// not dynamic-sealed, and not parked. Ready nodes are ordered worst-debt-first, then picked
// greedily while INDEPENDENT in BOTH the reference DAG and the conflict graph, up to the
// generator team-size cap. Pure function of the scheduler state.

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = JSON.parse(readFileSync(join(HERE, "fixtures", "analyser-findings.json"), "utf8"));
const SEAL = "NEEDS_MANUAL_SEAM";

/** minimal state builder — PENDING everywhere, in-degree 0, no conflicts, no cap */
function state(superNodes, edges = [], over = {}) {
  const ids = superNodes.map((s) => s.id);
  return {
    condensation: { superNodes, edges },
    conflict: { keysOf: Object.fromEntries(ids.map((id) => [id, []])) },
    status: Object.fromEntries(ids.map((id) => [id, "PENDING"])),
    indegree: Object.fromEntries(ids.map((id) => [id, 0])),
    park: [],
    meta: {},
    teamSize: Infinity,
    ...over,
  };
}

test("all PENDING, in-degree-0, unsealed, unparked nodes are selected (id order, no meta)", () => {
  assert.deepEqual(nextFrontier(state([{ id: "A" }, { id: "B" }, { id: "C" }])), ["A", "B", "C"]);
});

test("closure-green gate: a node whose live in-degree counter is > 0 is not ready", () => {
  const st = state([{ id: "A" }, { id: "B" }], [["A", "B"]], { indegree: { A: 0, B: 1 } });
  assert.deepEqual(nextFrontier(st), ["A"]);
});

test("status gate: only PENDING nodes are eligible", () => {
  const st = state([{ id: "A" }, { id: "B" }], [], { status: { A: "GREEN", B: "PENDING" } });
  assert.deepEqual(nextFrontier(st), ["B"]);
});

test("seal gate: a dynamic-sealed super-node is excluded (NEEDS_MANUAL_SEAM)", () => {
  assert.deepEqual(nextFrontier(state([{ id: "A", dynamic_seal: SEAL }, { id: "B" }])), ["B"]);
});

test("park gate: a parked node is excluded", () => {
  assert.deepEqual(nextFrontier(state([{ id: "A" }, { id: "B" }], [], { park: ["A"] })), ["B"]);
});

test("team-size cap bounds the frontier to the worst N", () => {
  const nodes = [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }, { id: "E" }];
  assert.deepEqual(nextFrontier(state(nodes, [], { teamSize: 2 })), ["A", "B"]);
});

test("worst-debt-first: grade D sorts ahead of C ahead of A", () => {
  const st = state([{ id: "A" }, { id: "B" }, { id: "C" }], [], {
    meta: { A: { grade: "A" }, B: { grade: "D" }, C: { grade: "C" } },
  });
  assert.deepEqual(nextFrontier(st), ["B", "C", "A"]);
});

test("conflict independence: two ready co-tenants cannot share one frontier — worst wins", () => {
  const st = state([{ id: "A" }, { id: "B" }], [], {
    conflict: { keysOf: { A: ["pool:P"], B: ["pool:P"] } },
    meta: { A: { grade: "D" }, B: { grade: "A" } },
  });
  assert.deepEqual(nextFrontier(st), ["A"], "B is deferred this round — it shares pool:P with the chosen A");
});

test("conflict is DIRECT resource sharing, not transitive group membership", () => {
  // A~B via pool:P, B~C via ddic:T; A and C share nothing directly, so they MAY co-generate.
  const st = state([{ id: "A" }, { id: "B" }, { id: "C" }], [], {
    conflict: { keysOf: { A: ["pool:P"], B: ["pool:P", "ddic:T"], C: ["ddic:T"] } },
  });
  // id-order pick: A chosen; B shares pool:P with A -> skipped; C shares nothing with A -> chosen.
  assert.deepEqual(nextFrontier(st), ["A", "C"]);
});

test("readiness fails closed when a node has no in-degree entry (the seed must be complete)", () => {
  const st = state([{ id: "A" }, { id: "B" }]);
  delete st.indegree.A;
  assert.deepEqual(nextFrontier(st), ["B"], "A is excluded — a missing counter is treated as not-ready");
});

test("reference independence is enforced defensively even if state is inconsistent", () => {
  // A->B ref edge with BOTH in-degree 0 (an inconsistent state); the guard must still hold.
  const st = state([{ id: "A" }, { id: "B" }], [["A", "B"]], { meta: { A: { grade: "D" }, B: { grade: "A" } } });
  assert.deepEqual(nextFrontier(st), ["A"]);
});

test("nextFrontier is deterministic and independent of super-node input order", () => {
  const mk = (ns) => state(ns, [], { meta: { A: { grade: "C" }, B: { grade: "D" }, C: { grade: "A" } } });
  assert.deepEqual(nextFrontier(mk([{ id: "A" }, { id: "B" }, { id: "C" }])), nextFrontier(mk([{ id: "C" }, { id: "B" }, { id: "A" }])));
});

test("resumable-counter flow over the golden fixture: root first, then its freed successors", () => {
  const g = overApproximateEdges({ nodes: DOC.graph.nodes, edges: DOC.graph.edges });
  const cond = tarjanCondense(g.nodes.map((n) => n.id), g.edges.map((e) => [e.source, e.target]));
  const meta = metaFromDoc(DOC);
  const st = state(cond.superNodes, cond.edges, { indegree: { ...kahnLevels(cond, meta).indegree }, meta, teamSize: 100 });

  assert.deepEqual(nextFrontier(st), ["ZFICO_BTC_CSV_GL"], "the entry report is the only ready root");

  // mark the root green exactly as the loop's live counter would (decrement each successor)
  st.status.ZFICO_BTC_CSV_GL = "GREEN";
  for (const [u, v] of cond.edges) if (u === "ZFICO_BTC_CSV_GL") st.indegree[v] -= 1;

  const f2 = nextFrontier(st);
  assert.ok(!f2.includes("ZFICO_BTC_CSV_GL"), "the green root is gone");
  assert.ok(f2.includes("ZFICO_BTC_CSV_SCR"), "a successor whose only in-edge was the root is freed");
  assert.ok(f2.includes("ZFICO_BTC_CSV_GL.BDC_OPEN"), "a called FORM is freed");
  assert.ok(!f2.includes("KD_GET_FILENAME_ON_F4"), "still blocked: its in-edge is from SCR, not the root");
  assert.ok(!f2.includes("CL_GUI_FRONTEND_SERVICES.GUI_UPLOAD"), "still blocked: in-edge is from a FORM");
});

function metaFromDoc(doc) {
  const cx = Object.fromEntries(doc.modernization_plan.objects.map((o) => [o.object, o.migration_complexity]));
  const bl = Object.fromEntries(doc.blast_radius.map((b) => [b.object, b.affected_program_count]));
  const meta = {};
  for (const n of doc.graph.nodes) meta[n.id] = { grade: n.clean_core_grade, complexity: cx[n.object] || 0, blast: bl[n.object] || 0 };
  return meta;
}
