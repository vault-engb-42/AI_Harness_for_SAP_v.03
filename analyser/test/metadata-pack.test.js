import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("A2: #NOT_REQUIRED is not flagged on a custom entity with a query provider, but is on a plain view", () => {
  // A custom entity enforces authorization in its IF_RAP_QUERY_PROVIDER class, not via a DCL, so
  // @AccessControl.authorizationCheck: #NOT_REQUIRED is the correct, deliberate pattern there.
  const q = findings([cds("zi_q", `@AccessControl.authorizationCheck: #NOT_REQUIRED
@ObjectModel.query.implementedBy: 'ABAP:ZCL_Q'
define custom entity ZI_Q { key id : abap.char(10); }`)]);
  assert.deepEqual(q.filter((x) => x.rule_id === "talos-cds-auth-not-required"), [], "auth enforced in the query provider");

  const plain = findings([cds("zi_p", `@AccessControl.authorizationCheck: #NOT_REQUIRED
define view entity ZI_P as select from vbak { key vbeln }`)]);
  assert.ok(plain.some((x) => x.rule_id === "talos-cds-auth-not-required"), "a plain view with #NOT_REQUIRED is still flagged");
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

test("a draft BDEF guarded by 'total etag' is NOT flagged for missing lockingMode (PERF-23)", () => {
  const b = bdef("zbp_te", `managed implementation in class zbp_te unique;
define behavior for ZI_TE alias TE
with draft
total etag LastChangedAt
{ create; }`);
  assert.ok(!findings([b]).some((x) => x.rule_id === "talos-rap-draft-no-optimistic-lock"), "total etag accepted as the concurrency guard");
});

test("deep-create via association is flagged with the real BDEF grammar (PERF-41)", () => {
  const b = bdef("zbp_dc", `managed implementation in class zbp_dc unique;
define behavior for ZI_DC alias DC
{
  association _Items { create; }
}`);
  const hit = findings([b]).find((x) => x.rule_id === "talos-rap-deep-create-no-cap");
  assert.ok(hit, "association-create detected");
  assert.equal(hit.severity, "priority-3");
});

test("the usage-type contract rules fire on a plain non-private view (PERF-84/26)", () => {
  const f = findings([cds("zi_plain2", `@AccessControl.authorizationCheck: #CHECK
define view entity ZI_Plain2 as select from vbak { key vbeln }`)]);
  for (const id of [
    "talos-cds-missing-service-quality",
    "talos-cds-missing-size-category",
    "talos-cds-missing-data-class",
    "talos-cds-missing-view-enhancement-category",
  ]) {
    assert.ok(f.some((x) => x.rule_id === id), `${id} fires`);
  }
});

test("virtualElement presence is flagged info (PERF-25)", () => {
  const f = findings([cds("zc_ve", `@AccessControl.authorizationCheck: #CHECK
@ObjectModel.virtualElement: true
define view entity ZC_VE as select from vbak { key vbeln }`)]);
  const hit = f.find((x) => x.rule_id === "talos-cds-virtual-element-cost");
  assert.ok(hit);
  assert.equal(hit.severity, "info");
});

test("uncapped composition [0..*] is flagged (PERF-22)", () => {
  const f = findings([cds("zi_comp", `@AccessControl.authorizationCheck: #CHECK
define view entity ZI_Comp as select from vbak
  composition [0..*] of ZI_Item as _Items
{ key vbeln, _Items }`)]);
  assert.ok(f.some((x) => x.rule_id === "talos-cds-expand-no-cardinality-cap"));
});

test("a draft BDEF with an ETag guard is not told to add a non-existent timeout annotation (A1)", () => {
  // talos-rap-draft-lock-no-timeout required @Locking.timeoutSeconds, which does NOT exist in released
  // ABAP Cloud (the draft exclusive-lock timeout is a framework/global setting, not a per-view
  // annotation). A rule requiring a non-existent annotation can never be satisfied and induces a
  // generator to fabricate one — it was removed. The real optimistic-concurrency concern is covered by
  // talos-rap-draft-no-optimistic-lock, which correctly exempts an ETag guard.
  const etag = bdef("zbp_etag", `managed implementation in class zbp_etag unique;
define behavior for ZI_E alias E
with draft
lock master total etag LastChangedAt
{ create; }`);
  const f = findings([etag]);
  assert.deepEqual(f.filter((x) => x.rule_id === "talos-rap-draft-lock-no-timeout"), [], "no non-existent-annotation finding");
  assert.deepEqual(f.filter((x) => x.rule_id === "talos-rap-draft-no-optimistic-lock"), [], "ETag guard exempts the real optimistic-lock rule");
});

test("every metadata rule 'require:' targets a real released SAP annotation (no fabrication-inducing rules)", () => {
  // Guard: a rule that requires a non-existent annotation induces a generator to fabricate it. Every
  // require: path must be a known SAP CDS/RAP annotation. Add a new one here only after verifying it exists.
  const REAL_ANNOTATIONS = new Set([
    "AccessControl.authorizationCheck",
    "ObjectModel.draftEnabled.lockingMode",
    "Analytics.dataCategory",
    "ObjectModel.usageType.serviceQuality",
    "ObjectModel.usageType.sizeCategory",
    "ObjectModel.usageType.dataClass",
    "AbapCatalog.viewEnhancementCategory",
  ]);
  const rules = JSON.parse(readFileSync(new URL("../rules/data/metadata-rules.json", import.meta.url), "utf8"));
  const bad = rules.filter((r) => r.require && !REAL_ANNOTATIONS.has(r.require)).map((r) => `${r.id} -> @${r.require}`);
  assert.deepEqual(bad, [], `rules require a non-existent annotation: ${bad.join(", ")}`);
});

test("managed + unmanaged implementation in one BDEF is flagged priority-1", () => {
  const b = bdef("zbp_m", `managed implementation in class zbp_a unique;
unmanaged implementation in class zbp_b unique;
define behavior for ZI_M alias M { create; }`);
  const hit = findings([b]).find((x) => x.rule_id === "talos-rap-mixed-managed-unmanaged");
  assert.ok(hit);
  assert.equal(hit.severity, "priority-1");
});
