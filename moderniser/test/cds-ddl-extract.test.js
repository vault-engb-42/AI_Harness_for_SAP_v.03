import { test } from "node:test";
import assert from "node:assert/strict";
import { extractCdsStructure } from "../src/plan/cds-ddl-extract.js";

// B3.5a seam (BUILD_PLAN S7 CORRECTION): a NET-NEW regex CDS-DDL structural extractor. @abaplint parses no
// CDS DDL, and ast-reader/bdef-dcl emit auth/commit/save/edges — NOT the {keys, fields, associations,
// annotations} the conformance gate compares against the ratified Architecture Contract. This fills that gap.

const SRC = `
@AccessControl.authorizationCheck: #CHECK
@EndUserText.label: 'Purchase Order'
define root view entity ZI_PurchaseOrder
  as select from zpo_header
  association [0..*] to ZI_PurchaseOrderItem as _Item
    on $projection.PurchaseOrderId = _Item.PurchaseOrderId
{
  key po_id                       as PurchaseOrderId,
      supplier                    as Supplier,
      @Semantics.amount.currencyCode: 'Currency'
      cast( net_amount as abap.curr( 23, 2 ) ) as NetAmount,
      currency                    as Currency,
      _Item
}
`;

test("extractCdsStructure returns the closed structural shape {keys, fields, associations, annotations}", () => {
  const s = extractCdsStructure(SRC);
  assert.deepEqual(Object.keys(s).sort(), ["annotations", "associations", "entity", "fields", "keys", "source"]);
});

test("keys: the `key`-prefixed elements are the key set (by exposed name)", () => {
  assert.deepEqual(extractCdsStructure(SRC).keys, ["PurchaseOrderId"]);
});

test("fields: each select element → {name (exposed), element (source expr)}; associations exposed in the body are NOT fields", () => {
  const f = extractCdsStructure(SRC).fields;
  const byName = Object.fromEntries(f.map((x) => [x.name, x]));
  assert.ok(byName.PurchaseOrderId, "the key is also a field");
  assert.equal(byName.Supplier.element, "supplier");
  assert.equal(byName.Currency.element, "currency");
  assert.ok(!f.some((x) => x.name === "_Item"), "an exposed association is not a field");
});

test("fields: a cast element carries its type; a plain element has no cast type", () => {
  const byName = Object.fromEntries(extractCdsStructure(SRC).fields.map((x) => [x.name, x]));
  assert.equal(byName.NetAmount.type, "abap.curr( 23, 2 )");
  assert.equal(byName.Supplier.type, null, "a plain projected field has no cast type");
});

test("associations: name + target + cardinality are captured", () => {
  const a = extractCdsStructure(SRC).associations;
  assert.equal(a.length, 1);
  assert.deepEqual(a[0], { name: "_Item", target: "ZI_PurchaseOrderItem", cardinality: "0..*" });
});

test("annotations: entity-level @Namespace.path: value pairs are captured (name + trimmed value)", () => {
  const anns = extractCdsStructure(SRC).annotations;
  const byName = Object.fromEntries(anns.map((x) => [x.name, x.value]));
  assert.equal(byName["AccessControl.authorizationCheck"], "#CHECK");
  assert.equal(byName["EndUserText.label"], "'Purchase Order'");
});

test("entity name + select source are captured (for grounded-ref checks downstream)", () => {
  const s = extractCdsStructure(SRC);
  assert.equal(s.entity, "ZI_PurchaseOrder");
  assert.equal(s.source, "zpo_header");
});

test("deterministic + fails soft on empty/garbage (all arrays empty, never throws)", () => {
  assert.equal(JSON.stringify(extractCdsStructure(SRC)), JSON.stringify(extractCdsStructure(SRC)));
  const empty = extractCdsStructure("not a cds view at all");
  assert.deepEqual(empty.keys, []);
  assert.deepEqual(empty.fields, []);
  assert.deepEqual(empty.associations, []);
  assert.equal(empty.entity, null);
});

test("a view entity with no explicit key still extracts fields (a projection without keys is legal)", () => {
  const src = `define view entity ZI_X as select from zt { alpha as Alpha, beta as Beta }`;
  const s = extractCdsStructure(src);
  assert.deepEqual(s.keys, []);
  assert.deepEqual(s.fields.map((f) => f.name).sort(), ["Alpha", "Beta"]);
});
