import { test } from "node:test";
import assert from "node:assert/strict";
import { lintAbapCloud } from "../src/cloud-linter.js";
import { isDdls, isDdlx, uiFeReadinessFindings, cdsStructureFindings } from "../src/cds-checks.js";

// G6 — @UI Fiori-Elements readiness. A consumption/projection CDS view that carries @UI
// (so it is UI-intended) must have the minimum set for a List Report + Object Page to render
// with NO hand-written UI. The @UI may live inline OR in a companion DDLX (S3). Real DDL, no mocks.

const fullProjection = `@AccessControl.authorizationCheck: #CHECK
@UI: { headerInfo: { typeName: 'Travel', typeNamePlural: 'Travels', title: { value: 'TravelID' } } }
define view entity ZC_Travel as projection on ZI_Travel
{
  @UI.facet: [ { id: 'Travel', type: #IDENTIFICATION_REFERENCE, position: 10 } ]
  @UI: { lineItem: [ { position: 10 } ], identification: [ { position: 10 } ], selectionField: [ { position: 10 } ] }
  key TravelID,
  @UI: { lineItem: [ { position: 20 } ], identification: [ { position: 20 } ] }
  Description
}`;

const finding = (res, id) => res.findings.find((f) => f.rule_id === id);
const file = (name, source) => ({ filename: name, source });

test("isDdls / isDdlx recognise the abapGit extensions", () => {
  assert.equal(isDdls("zc_travel.ddls.asddls"), true);
  assert.equal(isDdls("zc_travel.ddls"), true);
  assert.equal(isDdlx("zc_travel.ddlx.asddlx"), true);
  assert.equal(isDdls("zc_travel.ddlx.asddlx"), false);
});

test("gf-x-ui-fe-readiness is clean for a projection with the full @UI min-set", () => {
  assert.deepEqual(uiFeReadinessFindings([file("zc_travel.ddls.asddls", fullProjection)]), []);
});

test("gf-x-ui-fe-readiness flags a UI-intended projection missing @UI.headerInfo", () => {
  const noHeader = fullProjection.replace(/@UI: \{ headerInfo[^\n]*\n/, "");
  const res = uiFeReadinessFindings([file("zc_travel.ddls.asddls", noHeader)]);
  assert.equal(res.length, 1);
  assert.equal(res[0].rule_id, "gf-x-ui-fe-readiness");
  assert.equal(res[0].severity, "error");
  assert.match(res[0].message, /headerInfo/);
});

test("gf-x-ui-fe-readiness flags a projection missing @UI.lineItem (List Report has no columns)", () => {
  const noLine = fullProjection.replace(/lineItem: \[[^\]]*\],?\s*/g, "");
  const res = uiFeReadinessFindings([file("zc_travel.ddls.asddls", noLine)]);
  assert.equal(res.length, 1);
  assert.match(res[0].message, /lineItem/);
});

test("gf-x-ui-fe-readiness flags a projection missing @UI.selectionField (no filter bar)", () => {
  const noSel = fullProjection.replace(/selectionField: \[[^\]]*\],?\s*/g, "");
  const res = uiFeReadinessFindings([file("zc_travel.ddls.asddls", noSel)]);
  assert.equal(res.length, 1);
  assert.match(res[0].message, /selectionField/);
});

test("S3: @UI split between the projection and a companion DDLX satisfies the min-set", () => {
  const inlinePart = `define view entity ZC_Travel as projection on ZI_Travel
{
  @UI: { lineItem: [ { position: 10 } ], selectionField: [ { position: 10 } ] }
  key TravelID
}`;
  const ddlx = `@Metadata.layer: #CUSTOMER
annotate view ZC_Travel with
{
  @UI.headerInfo: { typeName: 'Travel', typeNamePlural: 'Travels' }
  @UI.identification: [ { position: 10 } ]
  @UI.facet: [ { id: 'x', position: 10 } ]
  TravelID;
}`;
  const res = uiFeReadinessFindings([file("zc_travel.ddls.asddls", inlinePart), file("zc_travel.ddlx.asddlx", ddlx)]);
  assert.deepEqual(res, [], "the DDLX supplies headerInfo + facet/identification the inline projection omits");
});

test("a non-UI interface view (ZI_, no @UI, not a projection) is never flagged", () => {
  const iface = `@AccessControl.authorizationCheck: #CHECK
define view entity ZI_Travel as select from /dmo/travel
{ key travel_id as TravelID, description as Description }`;
  assert.deepEqual(uiFeReadinessFindings([file("zi_travel.ddls.asddls", iface)]), []);
});

test("uiFeReadinessFindings is wired into lintAbapCloud", () => {
  const noHeader = fullProjection.replace(/@UI: \{ headerInfo[^\n]*\n/, "");
  assert.ok(finding(lintAbapCloud([file("zc_travel.ddls.asddls", noHeader)]), "gf-x-ui-fe-readiness"));
});

// --- G6c: adversarial-review remediation (comment + field-name FP/FN) ---

test("G6c: a CDS field NAMED LineItem does not satisfy the @UI.lineItem annotation (FN)", () => {
  const src = `@UI: { headerInfo: { typeName: 'X' } }
define view entity ZC_DocItem as projection on ZI_DocItem
{
  @UI: { selectionField: [ { position: 10 } ], identification: [ { position: 10 } ] }
  @UI.facet: [ { id: 'x', position: 10 } ]
  key DocID,
  LineItem
}`;
  const res = uiFeReadinessFindings([file("zc_docitem.ddls.asddls", src)]);
  assert.equal(res.length, 1, "no @UI.lineItem annotation — the field name must not count");
  assert.match(res[0].message, /lineItem/);
});

test("G6c: a projection whose only @UI is inside a // comment is NOT flagged (Web-API, FP)", () => {
  const src = `// no @UI here — this projection backs a Web API only
define view entity ZC_TravelApi as projection on ZI_Travel
{ key TravelID, Description }`;
  assert.deepEqual(uiFeReadinessFindings([file("zc_travelapi.ddls.asddls", src)]), []);
});

test("G6c: a commented-out @UI.lineItem does NOT count as present (FN)", () => {
  const src = `@UI: { headerInfo: { typeName: 'X' } }
define view entity ZC_Travel as projection on ZI_Travel
{
  @UI: { selectionField: [ { position: 10 } ], identification: [ { position: 10 } ] }
  @UI.facet: [ { id: 'x', position: 10 } ]
  // @UI: { lineItem: [ { position: 10 } ] }
  key TravelID
}`;
  const res = uiFeReadinessFindings([file("zc_travel.ddls.asddls", src)]);
  assert.equal(res.length, 1, "a commented-out lineItem is not a live annotation");
  assert.match(res[0].message, /lineItem/);
});

// --- G9: CDS BO-structure integrity (composition/association graph across all DDLS) ---

const ve = (name, body) => file(`${name.toLowerCase()}.ddls.asddls`, body);
const ruleIds = (fs) => fs.map((f) => f.rule_id);

test("G9 gf-x-cds-composition-no-back-association: a composed child with no `association to parent` (HIGH)", () => {
  const files = [
    ve("ZI_Travel", "define root view entity ZI_Travel as select from ztravel {\n  key travel_id as TravelId,\n  composition [0..*] of ZI_Booking as _Booking\n}"),
    ve("ZI_Booking", "define view entity ZI_Booking as select from zbooking {\n  key booking_id as BookingId\n}"),
  ];
  assert.ok(ruleIds(cdsStructureFindings(files)).includes("gf-x-cds-composition-no-back-association"));
});

test("G9: clean when the composed child declares `association to parent`", () => {
  const files = [
    ve("ZI_Travel", "define root view entity ZI_Travel as select from ztravel {\n  key travel_id as TravelId,\n  composition [0..*] of ZI_Booking as _Booking\n}"),
    ve("ZI_Booking", "define view entity ZI_Booking as select from zbooking\n  association to parent ZI_Travel as _Travel on $projection.TravelId = _Travel.TravelId\n{\n  key booking_id as BookingId\n}"),
  ];
  const got = ruleIds(cdsStructureFindings(files));
  assert.ok(!got.includes("gf-x-cds-composition-no-back-association"), got.join(","));
});

test("G9 gf-x-cds-node-no-key: a view entity with no key element", () => {
  const files = [ve("ZI_NoKey", "define view entity ZI_NoKey as select from zt {\n  field1 as Field1\n}")];
  assert.ok(ruleIds(cdsStructureFindings(files)).includes("gf-x-cds-node-no-key"));
});

test("G9 gf-x-cds-root-not-declared: a composition parent not declared `root`", () => {
  const files = [
    ve("ZI_Travel", "define view entity ZI_Travel as select from ztravel {\n  key travel_id as TravelId,\n  composition [0..*] of ZI_Booking as _Booking\n}"),
    ve("ZI_Booking", "define view entity ZI_Booking as select from zbooking\n  association to parent ZI_Travel as _Travel\n{\n  key booking_id as BookingId\n}"),
  ];
  assert.ok(ruleIds(cdsStructureFindings(files)).includes("gf-x-cds-root-not-declared"));
});

test("G9 gf-x-cds-projection-not-on-interface: a ZC_ projection built on another projection", () => {
  const files = [ve("ZC_Travel", "define view entity ZC_Travel as projection on ZC_Other {\n  key TravelId\n}")];
  assert.ok(ruleIds(cdsStructureFindings(files)).includes("gf-x-cds-projection-not-on-interface"));
});

test("G9: a projection on a ZI_ interface is clean; cdsStructureFindings is wired into lintAbapCloud", () => {
  const clean = ve("ZC_Travel", "define view entity ZC_Travel as projection on ZI_Travel {\n  key TravelId\n}");
  assert.ok(!ruleIds(cdsStructureFindings([clean])).includes("gf-x-cds-projection-not-on-interface"));
  assert.ok(finding(lintAbapCloud([ve("ZI_NoKey", "define view entity ZI_NoKey as select from zt { field1 as F }")]), "gf-x-cds-node-no-key"), "wired into lintAbapCloud");
});

// --- G9c: adversarial remediation — structural keywords inside annotation STRING literals ---
test("G9c: a label containing 'composition of X' does not fake a composition (string-literal FP)", () => {
  const files = [ve("ZI_MatComp", "@EndUserText.label: 'Composition of Material'\ndefine view entity ZI_MatComp as select from zmatcomp {\n  key matnr as Material,\n  pct as Percentage\n}")];
  const got = ruleIds(cdsStructureFindings(files));
  assert.ok(!got.includes("gf-x-cds-root-not-declared") && !got.includes("gf-x-cds-composition-no-back-association"), got.join(","));
});

test("G9c: a label containing 'key of' does not fake a key element (string-literal FN)", () => {
  const files = [ve("ZI_NoKey", "@EndUserText.label: 'the key of everything'\ndefine view entity ZI_NoKey as select from zt {\n  field1 as Field1\n}")];
  assert.ok(ruleIds(cdsStructureFindings(files)).includes("gf-x-cds-node-no-key"));
});

test("G9c: a label naming the parent does not fake the back-association (string-literal FN)", () => {
  const files = [
    ve("ZI_Travel", "define root view entity ZI_Travel as select from ztravel {\n  key travel_id as TravelId,\n  composition [0..*] of ZI_Booking as _Booking\n}"),
    ve("ZI_Booking", "@EndUserText.label: 'the association to parent ZI_Travel is TODO'\ndefine view entity ZI_Booking as select from zbooking {\n  key booking_id as BookingId\n}"),
  ];
  assert.ok(ruleIds(cdsStructureFindings(files)).includes("gf-x-cds-composition-no-back-association"));
});

// --- G11: positive extension rule — an EXTEND VIEW ENTITY needs an @AbapCatalog.viewEnhancement-
// Category base (NOT @Metadata.allowExtensions, which is for DDLX metadata extensions) ---
test("G11 gf-x-cds-extend-base-not-extensible: extending a #NONE base (not field-extensible) is flagged", () => {
  const files = [
    ve("ZI_Travel", "@AbapCatalog.viewEnhancementCategory: [#NONE]\ndefine view entity ZI_Travel as select from ztravel { key travel_id as TravelId }"),
    ve("ZX_Travel_Ext", "extend view entity ZI_Travel with {\n  newfield as NewField\n}"),
  ];
  assert.ok(ruleIds(cdsStructureFindings(files)).includes("gf-x-cds-extend-base-not-extensible"));
});

test("G11: extending a viewEnhancementCategory base (#PROJECTION_LIST) is clean, even with no @Metadata.allowExtensions (no FP)", () => {
  const files = [
    ve("ZI_Travel", "@AbapCatalog.viewEnhancementCategory: [#PROJECTION_LIST]\ndefine view entity ZI_Travel as select from ztravel { key travel_id as TravelId }"),
    ve("ZX_Travel_Ext", "extend view entity ZI_Travel with {\n  newfield as NewField\n}"),
  ];
  assert.ok(!ruleIds(cdsStructureFindings(files)).includes("gf-x-cds-extend-base-not-extensible"));
});

test("G11: @Metadata.allowExtensions is NOT the field-extend prerequisite — such a base is still flagged (no FN)", () => {
  const files = [
    ve("ZI_Travel", "@Metadata.allowExtensions: true\ndefine view entity ZI_Travel as select from ztravel { key travel_id as TravelId }"),
    ve("ZX_Travel_Ext", "extend view entity ZI_Travel with {\n  newfield as NewField\n}"),
  ];
  assert.ok(ruleIds(cdsStructureFindings(files)).includes("gf-x-cds-extend-base-not-extensible"));
});

test("G11: extensibility.extensible:false overrides the enhancement category (flagged)", () => {
  const files = [
    ve("ZI_Travel", "@AbapCatalog.viewEnhancementCategory: [#PROJECTION_LIST]\n@AbapCatalog.extensibility.extensible: false\ndefine view entity ZI_Travel as select from ztravel { key travel_id as TravelId }"),
    ve("ZX_Travel_Ext", "extend view entity ZI_Travel with {\n  newfield as NewField\n}"),
  ];
  assert.ok(ruleIds(cdsStructureFindings(files)).includes("gf-x-cds-extend-base-not-extensible"));
});

test("G11: extending an external/released base (not in the generated set) is not judged offline", () => {
  const files = [ve("ZX_Ext", "extend view entity I_ReleasedSAPView with {\n  newfield as NewField\n}")];
  assert.ok(!ruleIds(cdsStructureFindings(files)).includes("gf-x-cds-extend-base-not-extensible"));
});

test("G11c: a viewEnhancementCategory base with /* */ straddling annotation strings stays recognized (string-safe, no FP)", () => {
  const files = [
    ve("ZI_Travel", "@EndUserText.label: '/*'\n@AbapCatalog.viewEnhancementCategory: [#PROJECTION_LIST]\n@EndUserText.quickInfo: '*/'\ndefine view entity ZI_Travel as select from ztravel { key id as Id }"),
    ve("ZX_Ext", "extend view entity ZI_Travel with {\n  newf as NewF\n}"),
  ];
  assert.ok(!ruleIds(cdsStructureFindings(files)).includes("gf-x-cds-extend-base-not-extensible"));
});
