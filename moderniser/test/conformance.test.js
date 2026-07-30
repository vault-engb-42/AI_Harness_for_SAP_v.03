import { test } from "node:test";
import assert from "node:assert/strict";
import { checkConformance } from "../src/sched/conformance.js";

// B3.5a (BUILD_PLAN S7 / §6.13): the CONFORMANCE gate — post-generation `output ⊨ contract`, CLOSED-WORLD.
// Every pinned object/key/field/association/annotation present, no object/field/API outside the contract,
// every invariants_required satisfied. Distinct from gap-2a lint (Clean-Core rules): "did you build exactly
// what was ratified". Consumes the S7 CDS-DDL extractor for the structural comparison.

const GEN_SOURCE = `
@AccessControl.authorizationCheck: #CHECK
define root view entity ZI_Order
  as select from zorder
  association [0..*] to ZI_OrderItem as _Item on $projection.OrderId = _Item.OrderId
{
  key order_id as OrderId,
      customer  as Customer,
      _Item
}`;

const CONTRACT = {
  node_sig: "sigA", disposition: "re_architect", target: "rap_bo_headless", contract_hash: "h", grounded_at: "T",
  objects: [{
    id: "ZI_Order", kind: "cds",
    spec: {
      keys: ["OrderId"],
      fields: [{ name: "OrderId", element: "order_id", type: null }, { name: "Customer", element: "customer", type: null }],
      associations: [{ name: "_Item", target: "ZI_OrderItem", cardinality: "0..*" }],
      annotations: [{ name: "AccessControl.authorizationCheck", value: "#CHECK" }],
    },
    grounded_apis: ["zorder", "ZI_OrderItem"],
    invariants_required: ["dcl_authorization"],
    depends_on: [],
  }],
};

const genOk = () => ({ objects: [{ id: "ZI_Order", kind: "cds", declared_invariants: ["dcl_authorization"], source: GEN_SOURCE }] });

test("a matching generated set PASSES conformance (closed-world)", () => {
  const res = checkConformance(genOk(), CONTRACT);
  assert.equal(res.ok, true, JSON.stringify(res.violations));
  assert.deepEqual(res.violations, []);
});

test("RED: an EXTRA object not in the contract FAILS (closed-world — no over-generation)", () => {
  const gen = genOk();
  gen.objects.push({ id: "ZI_Sneaky", kind: "cds", declared_invariants: [], source: "define view entity ZI_Sneaky as select from zx { key a as A }" });
  const res = checkConformance(gen, CONTRACT);
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((v) => /ZI_Sneaky/.test(v) && /not in the contract|extra/i.test(v)));
});

test("RED: an UNGROUNDED API (a select source outside grounded_apis) FAILS", () => {
  const gen = genOk();
  gen.objects[0].source = GEN_SOURCE.replace("select from zorder", "select from zorder_shadow_table");
  const res = checkConformance(gen, CONTRACT);
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((v) => /zorder_shadow_table/i.test(v) && /grounded|ungrounded/i.test(v)));
});

test("RED: a MISSING pinned field FAILS", () => {
  const gen = genOk();
  gen.objects[0].source = GEN_SOURCE.replace("customer  as Customer,\n", ""); // drop the Customer field
  const res = checkConformance(gen, CONTRACT);
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((v) => /Customer/.test(v) && /missing/i.test(v)));
});

test("RED: a DROPPED invariant (required but not declared satisfied) FAILS", () => {
  const gen = genOk();
  gen.objects[0].declared_invariants = []; // dcl_authorization required but not satisfied
  const res = checkConformance(gen, CONTRACT);
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((v) => /dcl_authorization/.test(v) && /invariant/i.test(v)));
});

test("RED: a MISSING contract object FAILS", () => {
  const res = checkConformance({ objects: [] }, CONTRACT);
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((v) => /ZI_Order/.test(v) && /missing|absent/i.test(v)));
});

test("checkConformance returns ALL violations (not just the first) and never throws on a malformed source", () => {
  const gen = { objects: [{ id: "ZI_Order", kind: "cds", declared_invariants: [], source: "garbage" }] };
  const res = checkConformance(gen, CONTRACT);
  assert.equal(res.ok, false);
  assert.ok(res.violations.length >= 2, "multiple structural violations reported at once");
});
