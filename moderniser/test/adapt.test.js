import { test } from "node:test";
import assert from "node:assert/strict";
import { augmentFromCpg } from "../src/graph/adapt.js";
import { assemblePlan } from "../src/sched/assemble.js";

// D5 (operator-ratified 2026-07-13; closes F9 + F12): the Stage-1 seam CONTRACT. augment's
// node-level scan output (seals keyed by CPG node id; synthetic targets as raw tokens) can
// never feed assemblePlan's OBJECT-level opts.augment shape directly — the adapter collapses
// node→object, normalises target tokens into object-id space, and seals the SOURCE object on
// any unresolvable target (over-approximate, never a silently dropped edge). assemblePlan
// fail-closes on anything that still misses the object graph.

const gnode = (id, object) => ({ id, object: object ?? id.split(".")[0], kind: "report", namespace: "Z" });
const pobj = (object) => ({ object, kind: "report", transformation_count: 1, transformations: [{ rule_id: "r1" }], migration_complexity: 0 });
const doc = ({ nodes, edges = [], planObjects }) => ({ findings: [], graph: { nodes, edges }, modernization_plan: { objects: planObjects } });

test("a sealed CPG member node seals its OWNING OBJECT in the emitted shape", () => {
  const d = doc({ nodes: [gnode("ZA"), gnode("ZA.FORM1"), gnode("ZB")], planObjects: [pobj("ZA"), pobj("ZB")] });
  const { seals, edges } = augmentFromCpg(d, { "ZA.FORM1": "CALL FUNCTION lv_fm EXPORTING x = 1." });
  assert.deepEqual(seals, { ZA: true }, "node-level seal collapsed to the object");
  assert.deepEqual(edges, []);
});

test("a class-method handler token normalises to the owning class object; the edge reaches assemble", () => {
  const d = doc({
    nodes: [gnode("ZA"), gnode("ZB")],
    edges: [{ source: "ZA", target: "ZB", kind: "calls" }],
    planObjects: [pobj("ZA"), pobj("ZB")],
  });
  const aug = augmentFromCpg(d, { ZB: "SET HANDLER za=>on_done FOR lo." });
  assert.deepEqual(aug.edges, [{ source: "ZB", target: "ZA", kind: "set-handler", synthetic: true }]);
  assert.deepEqual(aug.seals, {});
  // end-to-end (the F9/F12 probe): the synthetic back-edge closes the cycle → ONE break_gate super-node
  const { plan } = assemblePlan(d, { augment: aug });
  assert.equal(plan.nodes.length, 1);
  assert.equal(plan.nodes[0].break_gate, true, "the cycle Tarjan exists to catch is CAUGHT");
  assert.deepEqual(plan.nodes[0].members, ["ZA", "ZB"]);
});

test("a bare form resolves against the EMITTING object's member set — intra-object emits no edge", () => {
  const d = doc({ nodes: [gnode("ZA"), gnode("ZA.MAIN"), gnode("ZA.UPD_DB")], planObjects: [pobj("ZA")] });
  const { seals, edges } = augmentFromCpg(d, { "ZA.MAIN": "PERFORM upd_db ON COMMIT." });
  assert.deepEqual(edges, [], "program-local late call — no object-level dependency");
  assert.deepEqual(seals, {}, "resolved, nothing to seal");
});

test("an UNRESOLVABLE target seals the SOURCE object — never a dangling edge (L5)", () => {
  const d = doc({ nodes: [gnode("ZA"), gnode("ZA.MAIN")], planObjects: [pobj("ZA")] });
  // no ZA.FRM_GONE member and no known object of that name
  const bare = augmentFromCpg(d, { "ZA.MAIN": "PERFORM frm_gone ON COMMIT." });
  assert.deepEqual(bare.edges, []);
  assert.deepEqual(bare.seals, { ZA: true }, "unresolvable bare form → seal");
  // unknown class in a handler token → same fail direction
  const cls = augmentFromCpg(d, { "ZA.MAIN": "SET HANDLER zcl_gone=>on_done FOR lo." });
  assert.deepEqual(cls.edges, []);
  assert.deepEqual(cls.seals, { ZA: true });
});

// GAP 4 - the seal must carry its REASON to the object level too, or the plan node inherits a bare
// boolean and the human confirming the seam has nothing to confirm against. `seals` itself is NOT widened:
// four tests above assert its exact shape and assemble consumes it with `=== true`, so the reasons ride a
// parallel map rather than breaking a settled contract for no gain.
test("a seal carries its REASON to the object level, for BOTH ways an object can seal", () => {
  const d = doc({ nodes: [gnode("ZA"), gnode("ZA.FORM1"), gnode("ZB")], planObjects: [pobj("ZA"), pobj("ZB")] });
  const scanned = augmentFromCpg(d, { "ZA.FORM1": "CALL FUNCTION lv_fm EXPORTING x = 1." });
  assert.deepEqual(scanned.seals, { ZA: true }, "the existing contract is untouched");
  assert.equal(scanned.seal_reasons.ZA.length, 1);
  assert.equal(scanned.seal_reasons.ZA[0].kind, "dynamic-construct");
  assert.match(scanned.seal_reasons.ZA[0].snippet, /CALL FUNCTION lv_fm/, "the line itself, so no second lookup");

  // The OTHER seal path: an edge whose target cannot be resolved seals the SOURCE. It has its own cause and
  // must not reach the human as an unexplained seal just because the scanner was not what sealed it.
  const e = doc({ nodes: [gnode("ZA"), gnode("ZA.MAIN")], planObjects: [pobj("ZA")] });
  const unresolvable = augmentFromCpg(e, { "ZA.MAIN": "PERFORM frm_gone ON COMMIT." });
  assert.deepEqual(unresolvable.seals, { ZA: true });
  assert.equal(unresolvable.seal_reasons.ZA[0].kind, "unresolvable-edge-target");
  assert.match(unresolvable.seal_reasons.ZA[0].snippet, /FRM_GONE/i, "and names the target it could not resolve");
});

test("the plan node carries the seal reasons, so the seam gate can state its evidence", () => {
  const d = doc({ nodes: [gnode("ZA"), gnode("ZA.FORM1")], planObjects: [pobj("ZA")] });
  const aug = augmentFromCpg(d, { "ZA.FORM1": "CALL FUNCTION lv_fm EXPORTING x = 1." });
  const { plan } = assemblePlan(d, { augment: aug });
  const node = plan.nodes.find((n) => n.object === "ZA");
  assert.equal(node.dynamic_seal, "NEEDS_MANUAL_SEAM");
  assert.ok(node.dynamic_seal_reasons?.length >= 1, `the plan node must carry WHY: ${JSON.stringify(node.dynamic_seal_reasons)}`);
  assert.equal(node.dynamic_seal_reasons[0].kind, "dynamic-construct");
});

test("adapter output is deterministic: deduped and sorted", () => {
  const d = doc({
    nodes: [gnode("ZA"), gnode("ZB"), gnode("ZC")],
    planObjects: [pobj("ZA"), pobj("ZB"), pobj("ZC")],
  });
  const src = "SET HANDLER zc=>e1 FOR lo. SET HANDLER zb=>e2 FOR lo. SET HANDLER zc=>e1 FOR lo2.";
  const a1 = augmentFromCpg(d, { ZA: src });
  assert.deepEqual(a1.edges.map((e) => e.target), ["ZB", "ZC"], "sorted, duplicate collapsed");
  assert.equal(JSON.stringify(a1), JSON.stringify(augmentFromCpg(d, { ZA: src })), "byte-stable");
});

test("assemblePlan FAIL-CLOSES on augment input that misses the object graph (F12)", () => {
  const d = doc({ nodes: [gnode("ZA")], planObjects: [pobj("ZA")] });
  assert.throws(
    () => assemblePlan(d, { augment: { seals: { "ZA.FORM1": true }, edges: [] } }),
    /seal|object/i,
    "a node-level seal key can never silently no-op again",
  );
  assert.throws(
    () => assemblePlan(d, { augment: { seals: {}, edges: [{ source: "ZA", target: "ZB_FORM", kind: "x" }] } }),
    /edge|unknown|endpoint/i,
    "a dangling edge endpoint can never be silently dropped again",
  );
});
