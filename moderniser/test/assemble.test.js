import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { assemblePlan } from "../src/sched/assemble.js";
import { canonicalNodeId } from "../src/state/node-id.js";
import { planHash } from "../src/sched/plan.js";

// Plan-freeze ASSEMBLY (§3.1 / §3.3 / §6.3): analyser doc → object graph → SCOPE join →
// precedence orientation → condense → levels → ONE frozen, content-hashed, SELF-CONTAINED
// plan. Everything load-bearing lives ON the hashed nodes: sig-space transitive in-plan
// dependencies (walked THROUGH out-of-plan nodes), super-node-keyed conflict keys
// (§3.1 Stage 4 wiring contract), members + per-member meta, break_gate.

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = JSON.parse(readFileSync(join(HERE, "fixtures", "analyser-findings.json"), "utf8"));

// Driving rules per the ratified definition (highest-severity finding, lex-min tiebreak):
// GL → released-api (P1), SCR → talos-cloud-001-call-function (P1), TOP → 7bit_ascii (its min is P2).
const SIG = {
  GL: canonicalNodeId({ rule: "released-api", entity_name: "ZFICO_BTC_CSV_GL", seam: "ZFICO_BTC_CSV_GL" }),
  SCR: canonicalNodeId({ rule: "talos-cloud-001-call-function", entity_name: "ZFICO_BTC_CSV_SCR", seam: "ZFICO_BTC_CSV_SCR" }),
  TOP: canonicalNodeId({ rule: "7bit_ascii", entity_name: "ZFICO_BTC_CSV_TOP", seam: "ZFICO_BTC_CSV_TOP" }),
};
const byObj = (plan, o) => plan.nodes.find((n) => n.object === o);

/** minimal synthetic analyser doc builder */
function doc({ nodes, edges, planObjects, findings = [] }) {
  return {
    findings,
    graph: { nodes, edges },
    modernization_plan: { objects: planObjects },
  };
}
const gnode = (id, kind = "report") => ({ id, object: id, kind, namespace: "Z" });
const pobj = (object, extra = {}) => ({ object, kind: "report", transformation_count: 1, transformations: [{ rule_id: "r1" }], migration_complexity: 0, ...extra });

test("the golden fixture assembles to a frozen, self-contained 3-node plan in sig space", () => {
  const { plan } = assemblePlan(DOC);
  assert.match(plan.plan_hash, /^[0-9a-f]{64}$/);
  assert.equal(plan.plan_hash, planHash(plan.nodes), "hash matches the stored nodes");
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.nodes), "frozen artifact");
  assert.deepEqual(plan.nodes.map((n) => n.id).sort(), Object.values(SIG).sort(), "ids are canonical sigs");
  assert.deepEqual(byObj(plan, "ZFICO_BTC_CSV_GL").members, ["ZFICO_BTC_CSV_GL"], "singleton super-node");
});

test("waves are the bottom-up scheduler levels (entry report LAST), not the analyser's plan wave", () => {
  const { plan } = assemblePlan(DOC);
  assert.equal(byObj(plan, "ZFICO_BTC_CSV_TOP").wave, 0);
  assert.equal(byObj(plan, "ZFICO_BTC_CSV_SCR").wave, 1, "behind its out-of-plan dep KD_GET in the full graph");
  assert.equal(byObj(plan, "ZFICO_BTC_CSV_GL").wave, 2, "the entry report is the last wave");
});

test("dependencies are transitive IN-PLAN ancestors in sig space (out-of-plan deps drop out)", () => {
  const { plan } = assemblePlan(DOC);
  assert.deepEqual([...byObj(plan, "ZFICO_BTC_CSV_GL").dependencies], [SIG.SCR, SIG.TOP].sort(), "frozen array — deps already sorted by assemble");
  assert.deepEqual(byObj(plan, "ZFICO_BTC_CSV_SCR").dependencies, [], "KD_GET is out-of-plan — no in-plan dep");
  assert.deepEqual(byObj(plan, "ZFICO_BTC_CSV_TOP").dependencies, []);
});

test("a clean out-of-plan object BETWEEN two plan objects does not break the dependency chain", () => {
  // native: B uses CLEAN, CLEAN uses A → precedence: A → CLEAN → B. CLEAN needs no work,
  // but B's transitive in-plan ancestor is A — B must wait for A (closure_green, L2).
  const d = doc({
    nodes: [gnode("A"), gnode("CLEAN"), gnode("B")],
    edges: [{ source: "B", target: "CLEAN", kind: "calls" }, { source: "CLEAN", target: "A", kind: "calls" }],
    planObjects: [pobj("A"), pobj("B")], // CLEAN is NOT in the plan
  });
  const { plan } = assemblePlan(d);
  const sigA = canonicalNodeId({ rule: "r1", entity_name: "A", seam: "A" });
  assert.deepEqual(byObj(plan, "B").dependencies, [sigA], "A reached THROUGH the clean node");
  assert.equal(byObj(plan, "A").dependencies.length, 0);
});

test("conflict keys are super-node-keyed and stored on the hashed nodes (Stage-4 wiring contract)", () => {
  const { plan } = assemblePlan(DOC);
  for (const o of ["ZFICO_BTC_CSV_GL", "ZFICO_BTC_CSV_SCR", "ZFICO_BTC_CSV_TOP"]) {
    assert.deepEqual(byObj(plan, o).conflict_keys, ["pool:ZFICO_BTC_CSV_GL"], `${o} carries the shared pool key`);
  }
});

test("a cycle of two plan objects collapses to ONE break_gate plan node with both pools kept", () => {
  const d = doc({
    nodes: [gnode("ZA"), gnode("ZB")],
    edges: [
      { source: "ZA", target: "ZB", kind: "calls" },
      { source: "ZB", target: "ZA", kind: "calls" }, // cycle
      { source: "ZA", target: "ZINC_A", kind: "includes" }, // ZA's pool
      { source: "ZB", target: "ZINC_B", kind: "includes" }, // ZB's pool
    ],
    planObjects: [pobj("ZA"), pobj("ZB")],
  });
  const { plan } = assemblePlan(d);
  assert.equal(plan.nodes.length, 1, "one super-node plan node");
  const n = plan.nodes[0];
  assert.equal(n.break_gate, true);
  assert.deepEqual([...n.members].sort(), ["ZA", "ZB"]);
  assert.equal(n.id, canonicalNodeId({ rule: "r1", entity_name: "ZA", seam: "ZA" }), "sig of the smallest in-plan member");
  assert.ok(n.conflict_keys.includes("pool:ZA") && n.conflict_keys.includes("pool:ZB"), "BOTH members' pools kept");
});

test("per-member meta rides on the node (self-contained plan — frontier aggregates worst member)", () => {
  const { plan } = assemblePlan(DOC);
  const gl = byObj(plan, "ZFICO_BTC_CSV_GL");
  assert.deepEqual(gl.member_meta, { ZFICO_BTC_CSV_GL: { grade: "D", complexity: 1, blast: 2 } });
});

test("assembly is deterministic — same doc, byte-identical plan (hash included)", () => {
  assert.equal(JSON.stringify(assemblePlan(DOC).plan), JSON.stringify(assemblePlan(DOC).plan));
});

test("runtime.objectToSig maps every in-plan object (incl. cycle members) to its plan node sig", () => {
  const { runtime } = assemblePlan(DOC);
  assert.equal(runtime.objectToSig.ZFICO_BTC_CSV_GL, SIG.GL);
  assert.equal(runtime.objectToSig.ZFICO_BTC_CSV_SCR, SIG.SCR);
});

// --- Rule-11 review remediations ---

test("a RAP Business Object target expands to the L1 artifact-set skeleton in transport order", () => {
  const d = doc({
    nodes: [gnode("ZRAP")],
    edges: [],
    planObjects: [pobj("ZRAP", { modernization_target: "RAP Business Object" })],
  });
  const n = assemblePlan(d).plan.nodes[0];
  assert.deepEqual(
    n.artifacts,
    [
      { obj_type: "cds", transport_rank: 1, name: null },
      { obj_type: "dcls", transport_rank: 2, name: null },
      { obj_type: "ddlx", transport_rank: 3, name: null },
      { obj_type: "intf", transport_rank: 4, name: null },
      { obj_type: "class", transport_rank: 5, name: null },
      { obj_type: "bdef", transport_rank: 6, name: null },
      { obj_type: "srvd", transport_rank: 7, name: null },
      { obj_type: "srvb", transport_rank: 8, name: null },
      { obj_type: "test_class", transport_rank: 9, name: null },
    ],
    "L1/D2: the FULL Clean-Core surface as ONE super-node (incl. DCL, metadata ext, service def+binding); names are filled at TRANSFORM",
  );
});

test("a non-RAP target carries a single-artifact skeleton of its own kind", () => {
  const { plan } = assemblePlan(DOC); // GL targets a Fiori Elements App
  assert.deepEqual(byObj(plan, "ZFICO_BTC_CSV_GL").artifacts, [{ obj_type: "report", transport_rank: 1, name: null }]);
});

test("opts.augment threads Stage-1 seals and synthetic edges into the assembled plan", () => {
  const d = doc({
    nodes: [gnode("ZA"), gnode("ZB")],
    edges: [{ source: "ZA", target: "ZB", kind: "calls" }],
    planObjects: [pobj("ZA"), pobj("ZB")],
  });
  // a dynamic CALL FUNCTION <var> in ZB sealed it; a synthetic back-edge closes a cycle
  const { plan } = assemblePlan(d, {
    augment: { seals: { ZB: true }, edges: [{ source: "ZB", target: "ZA", kind: "perform-on-commit", synthetic: true }] },
  });
  assert.equal(plan.nodes.length, 1, "the synthetic back-edge closed a cycle → one super-node");
  assert.equal(plan.nodes[0].break_gate, true);
  assert.equal(plan.nodes[0].dynamic_seal, "NEEDS_MANUAL_SEAM", "a sealed member seals the super-node");
});

test("a sealed plan node is never dispatched (the frontier veto is reachable end-to-end)", async () => {
  const { initRun, nextDispatch } = await import("../src/sched/loop.js");
  const d = doc({
    nodes: [gnode("ZS"), gnode("ZFREE")],
    edges: [],
    planObjects: [pobj("ZS"), pobj("ZFREE")],
  });
  const { plan } = assemblePlan(d, { augment: { seals: { ZS: true } } });
  const ready = nextDispatch(plan, initRun(plan));
  assert.deepEqual(ready.map((s) => plan.nodes.find((n) => n.id === s).object), ["ZFREE"], "ZS is sealed out");
});

test("member transports become tr: conflict keys (Stage-4 'shares a transport')", () => {
  const d = doc({
    nodes: [gnode("ZX"), gnode("ZY")],
    edges: [],
    planObjects: [pobj("ZX"), pobj("ZY")],
  });
  const { plan } = assemblePlan(d, { transportOf: { ZX: "DEVK900001", ZY: "DEVK900001" } });
  for (const o of ["ZX", "ZY"]) assert.ok(byObj(plan, o).conflict_keys.includes("tr:DEVK900001"), o);
});

test("a plan object missing from the CPG fails closed with a NAMED error, not a TypeError", () => {
  const d = doc({ nodes: [gnode("ZA")], edges: [], planObjects: [pobj("ZA"), pobj("ZGHOST")] });
  assert.throws(() => assemblePlan(d), /ZGHOST.*graph|graph.*ZGHOST/i);
});
