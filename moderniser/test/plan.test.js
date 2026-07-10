import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { freezePlan, planHash, replan } from "../src/sched/plan.js";
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
