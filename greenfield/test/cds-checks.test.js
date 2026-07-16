import { test } from "node:test";
import assert from "node:assert/strict";
import { lintAbapCloud } from "../src/cloud-linter.js";
import { isDdls, isDdlx, uiFeReadinessFindings } from "../src/cds-checks.js";

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
