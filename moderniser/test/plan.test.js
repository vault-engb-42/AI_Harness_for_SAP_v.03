import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { freezePlan, planHash, replan, savePlan, loadPlan } from "../src/sched/plan.js";
import { canonicalNodeId } from "../src/state/node-id.js";

// §3.1 / §6.3 — freeze the condensed DAG + wave assignment into an immutable,
// content-hashed plan; the hash must be reproducible regardless of discovery order.
// Exercised against the golden fixture (toy ZFICO_BTC — see fixtures/README.md).

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = JSON.parse(readFileSync(join(HERE, "fixtures", "analyser-findings.json"), "utf8"));

// Light JOIN from the fixture's modernization_plan -> plan nodes. SCOPE will do this
// fully later; here we only need id + wave to exercise freeze/replan.
function nodesFromDoc(doc) {
  return doc.modernization_plan.objects.map((o) => ({
    id: canonicalNodeId({ rule: o.transformations[0]?.rule_id ?? "no-finding", entity_name: o.object, seam: o.object }),
    object: o.object,
    kind: o.kind,
    wave: o.wave,
    dependencies: o.dependencies,
  }));
}

test("freezePlan produces a content-hashed, versioned artifact from the golden fixture", () => {
  const nodes = nodesFromDoc(DOC);
  const plan = freezePlan({ nodes });
  assert.match(plan.plan_hash, /^[0-9a-f]{64}$/);
  assert.ok(plan.schema_version, "carries schema_version");
  assert.equal(plan.nodes.length, DOC.modernization_plan.objects.length);
  assert.equal(plan.waves.length, DOC.modernization_plan.summary.wave_count);
});

test("plan_hash is reproducible + independent of node discovery order", () => {
  const nodes = nodesFromDoc(DOC);
  const h1 = freezePlan({ nodes }).plan_hash;
  const h2 = freezePlan({ nodes: [...nodes].reverse() }).plan_hash;
  assert.equal(h1, h2, "node input order must not change the hash");
  assert.equal(h1, planHash(nodes));
});

test("plan_hash changes when a node's wave moves", () => {
  const nodes = nodesFromDoc(DOC);
  const base = freezePlan({ nodes }).plan_hash;
  const moved = nodes.map((n, i) => (i === 0 ? { ...n, wave: n.wave + 5 } : n));
  assert.notEqual(base, freezePlan({ nodes: moved }).plan_hash);
});

test("replan flags a gate only when a COMMITTED node's wave moves (§6.3)", () => {
  const nodes = nodesFromDoc(DOC);
  const prev = freezePlan({ nodes });
  const moved = nodes.map((n, i) => (i === 0 ? { ...n, wave: n.wave + 3 } : n));
  const next = freezePlan({ nodes: moved });
  const movedId = nodes[0].id;
  assert.equal(replan(prev, next, (id) => id === movedId).replan_required, true, "committed move -> gate");
  assert.equal(replan(prev, next, () => false).replan_required, false, "uncommitted move -> silent");
});

test("freezePlan fails closed on a node with a missing / invalid wave or id", () => {
  assert.throws(() => freezePlan({ nodes: [{ id: "a" }] }), /wave/);
  assert.throws(() => freezePlan({ nodes: [{ id: "a", wave: -1 }] }), /wave/);
  assert.throws(() => freezePlan({ nodes: [{ id: "", wave: 0 }] }), /id/);
});

test("plan_hash is independent of a node's dependency-array order (a set, not a list)", () => {
  const a = [{ id: "n1", wave: 0, dependencies: ["X", "Y"] }, { id: "n2", wave: 1, dependencies: [] }];
  const b = [{ id: "n1", wave: 0, dependencies: ["Y", "X"] }, { id: "n2", wave: 1, dependencies: [] }];
  assert.equal(freezePlan({ nodes: a }).plan_hash, freezePlan({ nodes: b }).plan_hash);
});

test("freezePlan is deep-frozen and immune to caller mutation after the fact", () => {
  const inNodes = [{ id: "n1", wave: 0 }, { id: "n2", wave: 1 }];
  const plan = freezePlan({ nodes: inNodes });
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.nodes), "artifact + nodes frozen");
  inNodes[0].wave = 99; // mutate the caller's copy
  assert.notEqual(plan.nodes.find((n) => n.id === "n1").wave, 99, "plan holds an independent copy");
  assert.equal(plan.plan_hash, planHash(plan.nodes), "hash still matches the stored nodes");
});

test("savePlan + loadPlan round-trips and fails closed on tamper / unknown version", () => {
  const dir = join(tmpdir(), `mod-plan-${process.pid}-${process.hrtime()[1]}`);
  try {
    const plan = freezePlan({ nodes: nodesFromDoc(DOC) });
    savePlan("r1", plan, dir);
    assert.equal(loadPlan("r1", dir).plan_hash, plan.plan_hash, "round-trip verifies");
    // wave flipped without re-hashing -> fail closed
    const tampered = { ...plan, nodes: plan.nodes.map((n, i) => (i === 0 ? { ...n, wave: n.wave + 7 } : n)) };
    writeFileSync(join(dir, "plan", "r2.plan.json"), JSON.stringify(tampered), "utf8");
    assert.throws(() => loadPlan("r2", dir), /mismatch/);
    // unknown schema major -> fail closed
    writeFileSync(join(dir, "plan", "r3.plan.json"), JSON.stringify({ ...plan, schema_version: "9.0.0" }), "utf8");
    assert.throws(() => loadPlan("r3", dir), /schema_version/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("replan surfaces added / removed and gates on a removed committed node", () => {
  const nodes = nodesFromDoc(DOC);
  const prev = freezePlan({ nodes });
  const next = freezePlan({ nodes: nodes.slice(1) }); // drop nodes[0]
  const droppedId = nodes[0].id;
  const r = replan(prev, next, (id) => id === droppedId);
  assert.deepEqual(r.removed, [droppedId]);
  assert.deepEqual(r.removed_committed, [droppedId]);
  assert.equal(r.replan_required, true, "dropping a committed node gates");
  assert.equal(replan(prev, next, () => false).replan_required, false, "dropping an uncommitted node is silent");
  const extra = { id: "z".repeat(64), wave: 0 };
  const grown = freezePlan({ nodes: [...nodes, extra] });
  assert.deepEqual(replan(prev, grown, () => true).added, [extra.id]);
});
