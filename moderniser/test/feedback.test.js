import { test } from "node:test";
import assert from "node:assert/strict";
import { minFeedbackArcSet, elsOrder, backEdges } from "../src/graph/feedback.js";
import { tarjanCondense } from "../src/graph/condense.js";

// §3.1 Stage 2 mega-SCC seam / §3.4 #4 (L5) — a cycle super-node above SESSION_BUDGET is
// never "atomic": greedy Eades–Lin–Smyth ordering → back-edges = cut candidates → the
// FEWEST cuts such that every residual sub-component fits the budget, ranked with an
// evidence-based confidence (how much each cut shrinks the blob). Pure, ITERATIVE (scale
// NFR), deterministic. The human approves a CUT, not an ordering.

const ring = (ids) => ids.map((id, i) => [id, ids[(i + 1) % ids.length]]);

test("elsOrder is a total, deterministic arrangement; removing its back-edges yields a DAG", () => {
  const nodes = ["A", "B", "C", "D", "E"];
  const edges = [...ring(["A", "B", "C"]), ["C", "D"], ["D", "E"], ["E", "C"], ["A", "D"]];
  const order = elsOrder(nodes, edges);
  assert.deepEqual([...order].sort(), [...nodes].sort(), "every node placed exactly once");
  assert.deepEqual(order, elsOrder([...nodes].reverse(), [...edges].reverse()), "input-order independent");
  const backs = backEdges(order, edges);
  const kept = edges.filter(([u, v]) => !backs.some(([bu, bv]) => bu === u && bv === v));
  assert.ok(isAcyclic(nodes, kept), "the defining FAS property: order-violating edges removed → DAG");
});

test("an SCC within budget needs no seams", () => {
  const r = minFeedbackArcSet({ members: ["A", "B"], edges: [["A", "B"], ["B", "A"]] }, 2);
  assert.deepEqual(r.seams, []);
  assert.deepEqual(r.sub_components, [["A", "B"]]);
});

test("a 2-cycle over budget cuts exactly one edge into two singletons", () => {
  const r = minFeedbackArcSet({ members: ["A", "B"], edges: [["A", "B"], ["B", "A"]] }, 1);
  assert.equal(r.seams.length, 1);
  assert.deepEqual(r.sub_components, [["A"], ["B"]]);
  assert.equal(r.seams[0].rank, 1);
  assert.ok(r.seams[0].confidence > 0 && r.seams[0].confidence <= 1);
});

test("a pure ring needs ONE cut regardless of budget (a single cut breaks the whole cycle)", () => {
  const ids = ["N1", "N2", "N3", "N4", "N5", "N6"];
  const r = minFeedbackArcSet({ members: ids, edges: ring(ids) }, 3);
  assert.equal(r.seams.length, 1, "fewest cuts — never more than the cycle structure demands");
  assert.ok(r.sub_components.every((c) => c.length <= 3));
  assert.equal(r.sub_components.flat().length, 6, "every member lands in a component");
});

test("interlocked rings (figure-8) need two cuts", () => {
  const edges = [...ring(["A", "B", "C"]), ...ring(["C", "D", "E"])]; // shared node C
  const r = minFeedbackArcSet({ members: ["A", "B", "C", "D", "E"], edges }, 1);
  assert.equal(r.seams.length, 2, "one cut per elementary cycle");
  assert.ok(r.sub_components.every((c) => c.length === 1));
});

test("seams are ranked in cut order with evidence-based confidence fields", () => {
  const edges = [...ring(["A", "B", "C", "D"]), ...ring(["D", "E", "F", "G"])];
  const r = minFeedbackArcSet({ members: ["A", "B", "C", "D", "E", "F", "G"], edges }, 2);
  assert.deepEqual(r.seams.map((s) => s.rank), r.seams.map((_, i) => i + 1));
  for (const s of r.seams) {
    assert.ok(typeof s.source === "string" && typeof s.target === "string");
    assert.ok(s.confidence >= 0 && s.confidence <= 1, "confidence = how much the cut shrinks the blob");
  }
});

test("a no-shrink cut reports HONEST confidence 0 with a structural marker — never a fabricated floor", () => {
  // K4 complete digraph (both directions): early cuts cannot shrink the SCC yet.
  const ids = ["A", "B", "C", "D"];
  const edges = [];
  for (const u of ids) for (const v of ids) if (u !== v) edges.push([u, v]);
  const r = minFeedbackArcSet({ members: ids, edges }, 2);
  const structural = r.seams.filter((s) => s.structural === true);
  assert.ok(structural.length > 0, "a dense blob has cuts that break structure without shrinking the blob yet");
  for (const s of structural) assert.equal(s.confidence, 0, "no shrink → 0, indistinguishable-from-evidence floors forbidden");
  const shrinking = r.seams.filter((s) => s.structural !== true);
  assert.ok(shrinking.length > 0 && shrinking.every((s) => s.confidence > 0), "real shrink → real confidence");
  assert.ok(r.sub_components.every((c) => c.length <= 2), "budget still met");
});

test("the result composes with tarjanCondense: applying the seams leaves no over-budget SCC", () => {
  // a dense blob: ring of 9 + reverse chords
  const ids = Array.from({ length: 9 }, (_, i) => "Z" + i);
  const edges = [...ring(ids), ["Z4", "Z1"], ["Z7", "Z3"], ["Z8", "Z2"]];
  const budget = 3;
  const r = minFeedbackArcSet({ members: ids, edges }, budget);
  const cut = new Set(r.seams.map((s) => JSON.stringify([s.source, s.target])));
  const kept = edges.filter((e) => !cut.has(JSON.stringify(e)));
  const c = tarjanCondense(ids, kept);
  assert.ok(c.superNodes.every((s) => s.members.length <= budget), "every residual SCC fits the session budget");
  assert.deepEqual(r.sub_components, c.superNodes.map((s) => s.members), "reported components match the real condensation");
});

test("deterministic and input-order independent end to end", () => {
  const ids = ["A", "B", "C", "D", "E", "F"];
  const edges = [...ring(ids), ["D", "B"], ["F", "C"]];
  const a = minFeedbackArcSet({ members: ids, edges }, 2);
  const b = minFeedbackArcSet({ members: [...ids].reverse(), edges: [...edges].reverse() }, 2);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("fails closed on a bad budget; foreign edges and self-loops are ignored", () => {
  for (const bad of [0, -1, 1.5, NaN, undefined]) {
    assert.throws(() => minFeedbackArcSet({ members: ["A"], edges: [] }, bad), /budget/i, String(bad));
  }
  assert.throws(() => minFeedbackArcSet({ members: [], edges: [] }, 2), /members/i);
  const r = minFeedbackArcSet({ members: ["A", "B"], edges: [["A", "X"], ["A", "A"], ["A", "B"], ["B", "A"]] }, 2);
  assert.deepEqual(r.sub_components, [["A", "B"]], "foreign/self edges do not distort the SCC");
});

test("no spread-crash above the engine's argument ceiling: a 130000-node SCC seams cleanly", () => {
  // Rule-11 finding: Math.max(...130k superNodes) RangeError'd — the largest-SCC
  // computation must be a loop. A ring has exactly ONE back-edge candidate, so this stays fast.
  const N = 130000;
  const ids = Array.from({ length: N }, (_, i) => "m" + String(i).padStart(6, "0"));
  const r = minFeedbackArcSet({ members: ids, edges: ring(ids) }, 65000);
  assert.equal(r.seams.length, 1);
  assert.ok(r.sub_components.every((c) => c.length <= 65000));
});

test("iterative at scale: a 20000-node ring with chords seams without stack overflow", () => {
  const N = 20000;
  const ids = Array.from({ length: N }, (_, i) => "n" + String(i).padStart(6, "0"));
  const edges = ring(ids);
  for (let i = 0; i < N; i += 500) edges.push([ids[(i + 250) % N], ids[i]]); // 40 reverse chords
  const r = minFeedbackArcSet({ members: ids, edges }, 1000);
  assert.ok(r.seams.length >= 1);
  assert.ok(r.sub_components.every((c) => c.length <= 1000));
});

function isAcyclic(nodes, edges) {
  const indeg = new Map(nodes.map((n) => [n, 0]));
  const adj = new Map(nodes.map((n) => [n, []]));
  for (const [u, v] of edges) { adj.get(u).push(v); indeg.set(v, indeg.get(v) + 1); }
  const q = nodes.filter((n) => indeg.get(n) === 0);
  let seen = 0;
  while (q.length) {
    const n = q.pop();
    seen += 1;
    for (const w of adj.get(n)) { indeg.set(w, indeg.get(w) - 1); if (indeg.get(w) === 0) q.push(w); }
  }
  return seen === nodes.length;
}
