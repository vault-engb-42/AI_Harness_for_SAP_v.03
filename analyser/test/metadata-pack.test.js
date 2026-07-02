import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRegistry } from "../src/abaplint-loader.js";
import { metadataPack, _resetCache } from "../rules/metadata-pack.js";

function findings(files) {
  _resetCache();
  return metadataPack.check({ reg: loadRegistry(files) });
}
const cds = (name, src) => ({ filename: `${name}.ddls.asddls`, source: src });

test("forbid rule flags @AccessControl.authorizationCheck: #NOT_REQUIRED", () => {
  const f = findings([cds("zi_x", `@AccessControl.authorizationCheck: #NOT_REQUIRED
define view entity ZI_X as select from vbak { key vbeln }`)]);
  const hit = f.find((x) => x.rule_id === "talos-cds-auth-not-required");
  assert.ok(hit, "flagged");
  assert.equal(hit.severity, "priority-2");
  assert.equal(hit.object, "ZI_X");
});

test("require rule flags a CDS with no @AccessControl.authorizationCheck", () => {
  const f = findings([cds("zi_y", `define view entity ZI_Y as select from vbak { key vbeln }`)]);
  assert.ok(f.some((x) => x.rule_id === "talos-cds-missing-access-control"));
});

test("a CDS with a proper #CHECK auth annotation raises neither auth rule", () => {
  const f = findings([cds("zi_z", `@AccessControl.authorizationCheck: #CHECK
define view entity ZI_Z as select from vbak { key vbeln }`)]);
  assert.deepEqual(f.filter((x) => x.rule_id === "talos-cds-auth-not-required"), []);
  assert.deepEqual(f.filter((x) => x.rule_id === "talos-cds-missing-access-control"), []);
});

test("legacy @AbapCatalog.sqlViewName is flagged as deprecation", () => {
  const f = findings([cds("zi_leg", `@AbapCatalog.sqlViewName: 'ZISLEG'
@AccessControl.authorizationCheck: #CHECK
define view ZI_Leg as select from vbak { key vbeln }`)]);
  assert.ok(f.some((x) => x.rule_id === "talos-cds-legacy-sqlview" && x.family === "deprecation"));
});

test("metadata rules do not apply to non-CDS objects", () => {
  const f = findings([{ filename: "zcl_x.clas.abap", source: "CLASS zcl_x DEFINITION PUBLIC.\nENDCLASS.\nCLASS zcl_x IMPLEMENTATION.\nENDCLASS." }]);
  assert.deepEqual(f, []);
});
