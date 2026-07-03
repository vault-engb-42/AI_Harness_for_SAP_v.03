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

// --- conditional (when/unless) rules ---

const bdef = (name, src) => ({ filename: `${name}.bdef.asbdef`, source: src });

test("a draft BDEF without lockingMode is flagged; a non-draft BDEF is not (when-gate)", () => {
  const draft = bdef("zbp_d", `managed implementation in class zbp_d unique;
define behavior for ZI_D alias D
with draft
{ create; }`);
  const plain = bdef("zbp_p", `managed implementation in class zbp_p unique;
define behavior for ZI_P alias P
{ create; }`);
  assert.ok(findings([draft]).some((x) => x.rule_id === "talos-rap-draft-no-optimistic-lock"), "draft flagged");
  assert.ok(!findings([plain]).some((x) => x.rule_id === "talos-rap-draft-no-optimistic-lock"), "non-draft not flagged");
});

test("an analytical CDS without @Analytics.dataCategory is flagged; a plain view is not", () => {
  const analytical = cds("zc_alp", `@UI.headerInfo: { typeName: 'Order' }
@AccessControl.authorizationCheck: #CHECK
define view entity ZC_Alp as select from vbak { key vbeln }`);
  const plain = cds("zi_plain", `@AccessControl.authorizationCheck: #CHECK
define view entity ZI_Plain as select from vbak { key vbeln }`);
  assert.ok(findings([analytical]).some((x) => x.rule_id === "talos-cds-analytical-missing-analytics"));
  assert.ok(!findings([plain]).some((x) => x.rule_id === "talos-cds-analytical-missing-analytics"));
});

test("unless-gate suppresses the rule (private view exempt from usage-type contract)", () => {
  const priv = cds("zp_priv", `@VDM.private: true
@AccessControl.authorizationCheck: #CHECK
define view entity ZP_Priv as select from vbak { key vbeln }`);
  assert.ok(!findings([priv]).some((x) => x.rule_id === "talos-cds-missing-service-quality"));
});

test("early numbering in a BDEF is flagged", () => {
  const b = bdef("zbp_e", `managed implementation in class zbp_e unique;
define behavior for ZI_E alias E
early numbering
{ create; }`);
  assert.ok(findings([b]).some((x) => x.rule_id === "talos-rap-early-numbering"));
});

test("managed + unmanaged implementation in one BDEF is flagged priority-1", () => {
  const b = bdef("zbp_m", `managed implementation in class zbp_a unique;
unmanaged implementation in class zbp_b unique;
define behavior for ZI_M alias M { create; }`);
  const hit = findings([b]).find((x) => x.rule_id === "talos-rap-mixed-managed-unmanaged");
  assert.ok(hit);
  assert.equal(hit.severity, "priority-1");
});
