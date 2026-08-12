import { test } from "node:test";
import assert from "node:assert/strict";
import { reachableEvidence, reachableFacts, ownerOf } from "../src/plan/reach.js";

// The shared CPG reachability core. Both fact dimensions ride it — `consumption-facts.js` (what surface an
// object presents) and `persistence-facts.js` (what state it owns) — so a defect here is a defect in every
// recommendation the harness makes. It had no direct suite until F-4.

const graph = (edges, nodes = []) => ({ graph: { nodes, edges } });
const call = (source, target) => ({ source, target, kind: "calls" });
/** Classifier: one fact, emitted for the single marked target. */
const marks = (target, fact) => ({ factsOfEdge: (e) => (e.target === target ? [fact] : []) });

test("a wrapper's caller sees what the wrapper reaches — propagation is the point", () => {
  const doc = graph([call("ZCL_CALLER", "ZCL_WRAP"), call("ZCL_WRAP", "CL_GUI_ALV_GRID")]);
  const out = reachableFacts(doc, { absence: "none", ...marks("CL_GUI_ALV_GRID", "ui_salv") });
  assert.deepEqual(out.ZCL_CALLER, ["ui_salv"]);
  assert.deepEqual(out.ZCL_WRAP, ["ui_salv"]);
});

test("F-4: a THIRD caller of a mutually recursive pair sees the whole component's facts", () => {
  // AY <-> BZ are mutual wrappers; AY holds the grid, BZ holds the table. DW calls AY only.
  // AY demonstrably reaches the table (its own row says so), so DW must reach it too.
  // The memoised walk this replaced cached AY's set while still inside the cycle — incomplete — and
  // served that short answer to DW: a fact that exists, reported absent, to exactly one caller.
  const doc = graph([
    call("AY", "CL_GUI_ALV_GRID"), call("AY", "BZ"),
    call("BZ", "ZTABLE"), call("BZ", "AY"),
    call("DW", "AY"),
  ]);
  const classify = {
    factsOfEdge: (e) => (e.target === "CL_GUI_ALV_GRID" ? ["ui_salv"] : e.target === "ZTABLE" ? ["owns"] : []),
  };
  const out = reachableFacts(doc, { absence: "none", ...classify });
  assert.deepEqual(out.AY, ["owns", "ui_salv"]);
  assert.deepEqual(out.BZ, ["owns", "ui_salv"]);
  assert.deepEqual(out.DW, ["owns", "ui_salv"], "DW calls AY, and AY reaches both — DW cannot see less");
});

test("F-4: every member of a cycle agrees, whichever member the walk happens to enter first", () => {
  // Three-node cycle, one fact each. Entry order is the sorted owner order, which no corpus controls.
  const doc = graph([
    call("N1", "T1"), call("N1", "N2"),
    call("N2", "T2"), call("N2", "N3"),
    call("N3", "T3"), call("N3", "N1"),
  ]);
  const classify = { factsOfEdge: (e) => (/^T\d$/.test(e.target) ? [`f${e.target[1]}`] : []) };
  const out = reachableFacts(doc, { absence: "none", ...classify });
  for (const n of ["N1", "N2", "N3"]) {
    assert.deepEqual(out[n], ["f1", "f2", "f3"], `${n} is mutually reachable with the other two`);
  }
});

test("F-4: a deep call chain answers instead of overflowing the stack", () => {
  // The 100K+ LOC NFR admits chains far longer than a recursive walk's frame budget; the previous
  // implementation threw RangeError between 10k and 20k.
  const DEPTH = 25000;
  const edges = [{ source: "N0", target: "CL_GUI_ALV_GRID", kind: "calls" }];
  for (let i = 1; i < DEPTH; i += 1) edges.push(call(`N${i}`, `N${i - 1}`));
  const out = reachableFacts(graph(edges), { absence: "none", ...marks("CL_GUI_ALV_GRID", "ui_salv") });
  assert.deepEqual(out[`N${DEPTH - 1}`], ["ui_salv"]);
});

test("ownership does not propagate even through a cycle — propagate:false is per-object", () => {
  const doc = graph([call("AY", "ZTABLE"), call("AY", "BZ"), call("BZ", "AY")]);
  const out = reachableFacts(doc, { absence: "none", propagate: false, ...marks("ZTABLE", "owns") });
  assert.deepEqual(out.AY, ["owns"]);
  assert.deepEqual(out.BZ, ["none"], "BZ reaches AY's table but does not OWN it");
});

test("`via` names the immediate callee a reached fact arrived through, so the path is auditable", () => {
  const doc = graph([call("ZCL_CALLER", "ZCL_WRAP"), call("ZCL_WRAP", "CL_GUI_ALV_GRID")]);
  const ev = reachableEvidence(doc, marks("CL_GUI_ALV_GRID", "ui_salv"));
  assert.deepEqual(ev.ZCL_CALLER.direct, []);
  assert.deepEqual(ev.ZCL_CALLER.reached, [{ fact: "ui_salv", via: "ZCL_WRAP" }]);
});

test("every object the CPG contains gets an answer — silence is a fact, never an empty list", () => {
  const doc = graph([call("ZCL_A", "ZCL_B")], [{ id: "ZCL_LONELY" }]);
  const out = reachableFacts(doc, { absence: "no_evidence", ...marks("NOTHING", "x") });
  assert.deepEqual(out.ZCL_LONELY, ["no_evidence"], "a node with no edges still owes an answer");
  assert.deepEqual(out.ZCL_A, ["no_evidence"]);
});

test("ownerOf splits on the first dot — a method belongs to its class", () => {
  assert.equal(ownerOf("ZCL_THING.method"), "ZCL_THING");
  assert.equal(ownerOf("ZCL_THING"), "ZCL_THING");
});
