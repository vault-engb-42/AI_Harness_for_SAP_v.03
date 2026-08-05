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
  // ZFREE is an interface, so the classifier gives it `refactor` — a BUILDABLE disposition. That matters
  // since S5: a node the classifier could not classify (the `seal` fallthrough) is now held for manual
  // review rather than dispatched, so a default-shaped node would be excluded for that reason instead and
  // the dynamic-seal veto under test here would not be what the assertion proved.
  const d = doc({
    nodes: [gnode("ZS"), gnode("ZFREE", "interface")],
    edges: [],
    planObjects: [pobj("ZS"), pobj("ZFREE", { kind: "interface" })],
  });
  const { plan } = assemblePlan(d, { augment: { seals: { ZS: true } } });
  const ready = nextDispatch(plan, initRun(plan));
  assert.deepEqual(ready.map((s) => plan.nodes.find((n) => n.id === s).object), ["ZFREE"], "ZS is sealed out");
});

test("S5 a node the classifier SEALED (no clear signal) is held for manual review, never dispatched", async () => {
  const { initRun, nextDispatch } = await import("../src/sched/loop.js");
  const { driveDecision } = await import("../src/sched/drive.js");
  // Two default-shaped report nodes: no findings, no target → the classifier's `seal` fallthrough
  // ("no clear disposition signal — manual review"). Before S5 these were handed to the generator.
  const d = doc({ nodes: [gnode("ZA"), gnode("ZB")], edges: [], planObjects: [pobj("ZA"), pobj("ZB")] });
  const { plan } = assemblePlan(d);
  assert.ok(plan.nodes.every((n) => n.disposition === "seal"), "precondition: the classifier sealed them");
  const state = initRun(plan);
  assert.deepEqual(nextDispatch(plan, state), [], "a sealed-by-disposition node never reaches the frontier");
  assert.equal(driveDecision(plan, state).action, "await_human", "it surfaces as the human seam gate");
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

// --- B1: the analyser signal set rides the (hashed) plan node, unioned across super-node members ---

test("the plan node carries finding_families + driving_rule_ids, union-aggregated across super-node members", () => {
  const d = doc({
    nodes: [gnode("ZA"), gnode("ZB")],
    edges: [
      { source: "ZA", target: "ZB", kind: "calls" },
      { source: "ZB", target: "ZA", kind: "calls" }, // cycle → one super-node
    ],
    planObjects: [pobj("ZA"), pobj("ZB")],
    findings: [
      { object: "ZA", rule_id: "talos-cloud-006-write", family: "deprecation", atc_priority: "P1" },
      { object: "ZB", rule_id: "talos-legacy-ui-rollup", family: "clean-core", atc_priority: "P2" },
    ],
  });
  const n = assemblePlan(d).plan.nodes[0];
  assert.deepEqual([...n.members].sort(), ["ZA", "ZB"], "one super-node");
  assert.deepEqual(n.finding_families, ["clean-core", "deprecation"], "union of member families, sorted");
  assert.deepEqual(n.driving_rule_ids, ["talos-cloud-006-write", "talos-legacy-ui-rollup"], "union of member rule_ids, sorted");
});

test("the signal-set fields ride plan_hash (present on the golden plan) + schema_version is bumped to 1.1.0", () => {
  const { plan } = assemblePlan(DOC);
  const gl = byObj(plan, "ZFICO_BTC_CSV_GL");
  assert.ok(Array.isArray(gl.finding_families) && gl.finding_families.length > 0, "GL carries families");
  assert.ok(Array.isArray(gl.driving_rule_ids) && gl.driving_rule_ids.length > 0, "GL carries rule_ids");
  assert.equal(plan.plan_hash, planHash(plan.nodes), "the new fields are covered by plan_hash");
  assert.equal(plan.schema_version, "1.6.0", "node-schema enrichment (B1 signals + B2 disposition + object_kind + disposition_hints + P1 disposition_evidence + P3 disposition provenance)");
});

// --- B2: the plan-time disposition rides the frozen node ---

test("every plan node carries a classified disposition + siblings + modernization_target (rides plan_hash)", () => {
  const { plan } = assemblePlan(DOC); // abap_fico: 3 reports, all Fiori Elements App target, classic-UI findings
  for (const n of plan.nodes) {
    assert.ok(["refactor", "re_architect", "rebuild", "replace", "retire", "seal"].includes(n.disposition), `${n.object} has a disposition`);
    assert.equal(typeof n.disposition_rationale, "string");
    assert.ok(n.disposition_confidence >= 0 && n.disposition_confidence <= 1);
    assert.ok(["auto", "prompt"].includes(n.disposition_autonomy));
    assert.equal(typeof n.disposition_reversible, "boolean");
    assert.equal(n.modernization_target, "Fiori Elements App");
  }
  // GL carries the classic-UI WRITE signal → re_architect, and re_architect never auto-applies
  const gl = byObj(plan, "ZFICO_BTC_CSV_GL");
  assert.equal(gl.disposition, "re_architect");
  assert.equal(gl.disposition_autonomy, "prompt");
  assert.equal(plan.plan_hash, planHash(plan.nodes), "disposition_* are covered by plan_hash");
});

// B2-generalisation — an archetype the two example fixtures NEVER exercised, classified end-to-end via a hint.
test("GENERALISATION: a dynpro screen (unseen archetype) enriches to a ui_rearch hint → re_architect", () => {
  const d = doc({
    nodes: [gnode("ZSD_ORDER_SCR")],
    edges: [],
    planObjects: [pobj("ZSD_ORDER_SCR", { kind: "report", modernization_target: "Fiori Elements App" })],
    findings: [
      { object: "ZSD_ORDER_SCR", rule_id: "talos-s4-004", family: "deprecation", atc_priority: "P1", message: "Dynpro screen flow logic — no successor in ABAP Cloud (S4-004)" },
    ],
  });
  const n = assemblePlan(d).plan.nodes[0];
  assert.ok(n.disposition_hints.includes("ui_rearch"), "the dynpro finding's MESSAGE enriched to a ui_rearch hint — no rule_id was hand-picked");
  assert.equal(n.disposition, "re_architect", "classified via the hint, generalising to an unseen archetype");
});

// --- P3 / S-b: the operator's disposition OVERRIDE re-assembles into a NEW frozen plan ---
// The override is applied AFTER the classifier and rides plan_hash, so a changed disposition is a
// REPLAN (a new plan identity), never an in-place mutation of a frozen node and never a state-level
// shadow value that would let state and plan disagree about what is being built.

const OVERRIDE = { disposition: "retire", decided_by: "panos", decided_at: "2026-08-05T10:00:00.000Z" };

test("with no overrides every node is provenanced to the classifier", () => {
  const { plan } = assemblePlan(DOC);
  for (const n of plan.nodes) {
    assert.equal(n.disposition_source, "classifier");
    assert.equal(n.disposition_decided_by, null);
  }
});

test("an override REPLACES the classified disposition and stamps the accountable human onto the frozen node", () => {
  const { plan } = assemblePlan(DOC, { dispositionOverrides: { [SIG.GL]: OVERRIDE } });
  const gl = byObj(plan, "ZFICO_BTC_CSV_GL");
  assert.equal(gl.disposition, "retire", "the human's decision, not the classifier's re_architect");
  assert.equal(gl.disposition_source, "operator_override");
  assert.equal(gl.disposition_decided_by, "panos");
  assert.equal(gl.disposition_autonomy, "auto", "the gate exists to obtain a human decision — it has one, so it must not re-prompt for it");
  assert.equal(gl.disposition_reversible, false, "reversibility follows the NEW disposition, not the old one");
  assert.equal(gl.disposition_target, null, "the classifier's target was reasoned for a disposition that no longer applies");
  assert.match(gl.disposition_rationale, /re_architect/, "the superseded recommendation stays legible in the proof bundle");
  assert.deepEqual(byObj(plan, "ZFICO_BTC_CSV_SCR").disposition_source, "classifier", "an override touches only its own node");
});

test("the override rides plan_hash — a changed disposition is a NEW plan identity", () => {
  const base = assemblePlan(DOC).plan;
  const { plan } = assemblePlan(DOC, { dispositionOverrides: { [SIG.GL]: OVERRIDE } });
  assert.equal(plan.plan_hash, planHash(plan.nodes), "provenance + disposition are covered by the hash");
  assert.notEqual(plan.plan_hash, base.plan_hash, "the same doc under a different human decision is a different plan");
});

test("deterministic: the same doc + the same overrides re-freeze byte-identically", () => {
  const a = assemblePlan(DOC, { dispositionOverrides: { [SIG.GL]: OVERRIDE } }).plan;
  const b = assemblePlan(DOC, { dispositionOverrides: { [SIG.GL]: OVERRIDE } }).plan;
  assert.equal(a.plan_hash, b.plan_hash);
  assert.equal(JSON.stringify(a.nodes), JSON.stringify(b.nodes));
});

test("the registry-grounded evidence survives an override — it describes the object, not the decision", () => {
  const { plan } = assemblePlan(DOC, { dispositionOverrides: { [SIG.GL]: OVERRIDE } });
  const gl = byObj(plan, "ZFICO_BTC_CSV_GL");
  assert.ok(gl.disposition_evidence, "P1 evidence is still on the node");
  assert.ok(Array.isArray(gl.disposition_evidence.no_successor_refs));
});

test("fail closed: an override for a sig that is not in the plan is refused, never silently dropped", () => {
  // A human's recorded decision evaporating without a word is the exact failure P3 exists to remove.
  assert.throws(
    () => assemblePlan(DOC, { dispositionOverrides: { "sig-not-in-this-plan": OVERRIDE } }),
    /not a plan node/,
  );
});
