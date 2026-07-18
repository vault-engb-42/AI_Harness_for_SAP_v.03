import { test } from "node:test";
import assert from "node:assert/strict";
import { validateFeDescriptor } from "../src/fe-descriptor.js";

// G12: the Fiori Elements app-project descriptor gate. A generated manifest.json must be a
// valid FE descriptor bound to the published SRVB service — a List Report + Object Page over a
// main entitySet that is the G6 ZC_ projection. Non-ATC, offline, deterministic. No mocks.

const validManifest = () => ({
  "sap.app": {
    id: "com.harness.travel",
    type: "application",
    dataSources: {
      mainService: {
        uri: "/sap/opu/odata4/sap/zui_travel_o4/srvd/sap/zui_travel/0001/",
        type: "OData",
        settings: { odataVersion: "4.0" },
      },
    },
  },
  "sap.ui5": {
    dependencies: { libs: { "sap.fe.templates": {} } },
    models: { "": { dataSource: "mainService" } },
    routing: {
      routes: [
        { name: "TravelList", pattern: ":?query:", target: "TravelList" },
        { name: "TravelObjectPage", pattern: "Travel({key}):?query:", target: "TravelObjectPage" },
      ],
      targets: {
        TravelList: { type: "Component", name: "sap.fe.templates.ListReport", options: { settings: { entitySet: "Travel" } } },
        TravelObjectPage: { type: "Component", name: "sap.fe.templates.ObjectPage", options: { settings: { entitySet: "Travel" } } },
      },
    },
  },
});

const ids = (r) => r.findings.map((f) => f.rule_id);

test("a complete FE descriptor passes clean", () => {
  const r = validateFeDescriptor({ manifest: validManifest(), entity: "Travel", service: "zui_travel" });
  assert.equal(r.errorCount, 0, JSON.stringify(r.findings));
});

test("a descriptor with no OData dataSource is flagged (not bound to the SRVB service)", () => {
  const m = validManifest();
  delete m["sap.app"].dataSources;
  assert.ok(ids(validateFeDescriptor({ manifest: m })).includes("fe-no-odata-datasource"));
});

test("a descriptor missing the List Report / Object Page FE templates is flagged", () => {
  const m = validManifest();
  m["sap.ui5"].routing.targets.TravelList.name = "my.custom.View";
  m["sap.ui5"].routing.targets.TravelObjectPage.name = "my.custom.Detail";
  const got = ids(validateFeDescriptor({ manifest: m }));
  assert.ok(got.includes("fe-no-list-report") && got.includes("fe-no-object-page"), got.join(","));
});

test("a descriptor with no main entitySet is flagged", () => {
  const m = validManifest();
  delete m["sap.ui5"].routing.targets.TravelList.options.settings.entitySet;
  delete m["sap.ui5"].routing.targets.TravelObjectPage.options.settings.entitySet;
  assert.ok(ids(validateFeDescriptor({ manifest: m })).includes("fe-no-entityset"));
});

test("the entitySet must match the generated projection entity", () => {
  const r = validateFeDescriptor({ manifest: validManifest(), entity: "Booking" });
  assert.ok(ids(r).includes("fe-entityset-projection-mismatch"), JSON.stringify(r.findings));
});

test("the dataSource must reference the generated service when one is given", () => {
  const r = validateFeDescriptor({ manifest: validManifest(), service: "z_other_service" });
  assert.ok(ids(r).includes("fe-datasource-wrong-service"));
});

test("invalid JSON is a descriptor error, not a crash", () => {
  const r = validateFeDescriptor({ manifest: "{ not json" });
  assert.ok(r.errorCount >= 1 && ids(r).includes("fe-manifest-invalid-json"));
});

// G12 adversarial remediation: FE V4 declares the page entity via contextPath (the SAP default
// for UI5 >= 1.94), not always entitySet — and EVERY floorplan target must target the projection.
test("a target may declare its entity via contextPath instead of entitySet (FE V4 default)", () => {
  const m = validManifest();
  for (const t of Object.values(m["sap.ui5"].routing.targets)) {
    delete t.options.settings.entitySet;
    t.options.settings.contextPath = "/Travel";
  }
  const r = validateFeDescriptor({ manifest: m, entity: "Travel" });
  assert.equal(r.errorCount, 0, JSON.stringify(r.findings));
});

test("a navigation-based Object Page (multi-segment contextPath) is not forced to equal the root projection", () => {
  const m = validManifest();
  m["sap.ui5"].routing.targets.TravelObjectPage.options.settings = { contextPath: "/Travel/_Booking" };
  const r = validateFeDescriptor({ manifest: m, entity: "Travel" });
  assert.equal(r.errorCount, 0, JSON.stringify(r.findings));
});

test("EVERY FE target must bind the projection — an Object Page on the ZI_ interface is flagged", () => {
  const m = validManifest();
  m["sap.ui5"].routing.targets.TravelObjectPage.options.settings.entitySet = "ZI_TravelWrong";
  const r = validateFeDescriptor({ manifest: m, entity: "Travel" });
  assert.ok(ids(r).includes("fe-entityset-projection-mismatch"), JSON.stringify(r.findings));
});
