import { test } from "node:test";
import assert from "node:assert/strict";
import { creationBody, createObject, publishBody, bindingProtocol, publishUrl } from "../handlers/write.js";
import { CREATION } from "../lib/adt-uris.js";

// G3: create-body construction is a PURE function so it can be asserted offline (no SAP).
// Source-based types (CLAS/…/DDLS/SRVD/TABL) get the generic adtcore shell — created
// empty, then source PUT. A service binding (SRVB) is config-only (no /source/main), so it
// carries its binding + referenced service definition in the creation body itself. Grounded
// on abap-adt-api objectcreator.ts. Real function, no mocks.

test("creationBody builds a generic adtcore shell for a source-based type (SRVD)", () => {
  const xml = creationBody(CREATION.SRVD, { name: "z_svc", description: "svc", responsible: "dev", pkg: "$tmp" });
  assert.match(xml, /<srvd:srvdSource\b/, "root element is srvd:srvdSource");
  assert.match(xml, /srvd:srvdSourceType="S"/, "carries the required srvdSourceType attr");
  assert.match(xml, /adtcore:name="Z_SVC"/, "object name is upper-cased");
  assert.match(xml, /<adtcore:packageRef adtcore:name="\$TMP"\/>/, "package ref is upper-cased");
});

test("creationBody builds a config body with a binding + service ref for SRVB (config-only)", () => {
  const xml = creationBody(CREATION.SRVB, { name: "zui_x_o4", responsible: "dev", pkg: "$tmp", service_definition: "zui_x" });
  assert.match(xml, /<srvb:serviceBinding\b/, "root element is srvb:serviceBinding");
  assert.match(xml, /<srvb:serviceDefinition adtcore:name="ZUI_X"\/>/, "references the exposed service definition");
  assert.match(xml, /srvb:type="ODATA"/, "binding type ODATA");
  assert.match(xml, /srvb:category="1"/, "category 1 = UI (Fiori Elements default)");
  assert.match(xml, /srvb:version="V4"/, "default protocol V4");
});

test("creationBody builds the blue:blueSource shell for TABL and escapes XML metacharacters", () => {
  const xml = creationBody(CREATION.TABL, { name: "z_t", description: 'a<b>&"', responsible: "dev", pkg: "$tmp" });
  assert.match(xml, /<blue:blueSource\b/, "root element is blue:blueSource");
  assert.match(xml, /adtcore:description="a&lt;b&gt;&amp;&quot;"/, "description metacharacters are escaped");
});

test("createObject fails closed when an SRVB is created without its service_definition", async () => {
  // The guard runs before any session use, so a throwaway session is never touched — this
  // exercises the real fail-closed path, not a mock. Prevents a self-referential SRVD ref.
  await assert.rejects(
    () => createObject({}, { name: "ZUI_X_O4", type: "SRVB", package: "$TMP" }),
    /service binding \(SRVB\) requires service_definition/,
    "SRVB create without service_definition must be refused",
  );
});

// G10: the SRVB binding type is parameterizable — OData V4 UI (default), V2 UI, or V4 Web API.
test("creationBody maps binding_type ODATA_V2_UI to a V2 UI binding", () => {
  const xml = creationBody(CREATION.SRVB, { name: "z_o2", responsible: "dev", pkg: "$tmp", service_definition: "z", binding_type: "ODATA_V2_UI" });
  assert.match(xml, /srvb:version="V2"/, "V2 protocol");
  assert.match(xml, /srvb:category="1"/, "category 1 = UI");
});

test("creationBody maps binding_type ODATA_V4_WEBAPI to a V4 Web-API binding (category 0)", () => {
  const xml = creationBody(CREATION.SRVB, { name: "z_o4w", responsible: "dev", pkg: "$tmp", service_definition: "z", binding_type: "ODATA_V4_WEBAPI" });
  assert.match(xml, /srvb:version="V4"/, "V4 protocol");
  assert.match(xml, /srvb:category="0"/, "category 0 = Web API");
});

// G10: publishing a service binding is a DISTINCT action AFTER activation — an SCGR object
// reference POSTed to the protocol-correct publishjobs endpoint.
test("publishBody builds an SCGR object reference for the service binding", () => {
  const xml = publishBody("zui_x_o4");
  assert.match(xml, /<adtcore:objectReference[^>]*adtcore:name="ZUI_X_O4"/, "references the binding by upper-cased name");
  assert.match(xml, /adtcore:type="SCGR"/, "publishes the service group (SCGR)");
});

test("publishBody omits the SCGR type for a V2 binding (V2 identifies by servicename query params)", () => {
  // V4 registers a service GROUP (SCGR); V2 registers a service, identified by the
  // servicename/serviceversion query params (publishUrl) — its objectReference carries
  // the name only, with NO adtcore:type, matching the grounded abap-adt-api form.
  const v4 = publishBody("z_o4", "V4");
  assert.match(v4, /adtcore:type="SCGR"/, "V4 keeps the service-group (SCGR) type");
  const v2 = publishBody("z_o2", "V2");
  assert.match(v2, /adtcore:name="Z_O2"/, "V2 still references the binding by name");
  assert.doesNotMatch(v2, /adtcore:type=/, "V2 objectReference carries no adtcore:type");
});

test("bindingProtocol reads the protocol from a binding config, defaulting to V4", () => {
  const cfg = (v) => `<srvb:serviceBinding xmlns:srvb="x"><srvb:binding srvb:type="ODATA" srvb:version="${v}" srvb:category="1"/></srvb:serviceBinding>`;
  assert.equal(bindingProtocol(cfg("V4")), "V4");
  assert.equal(bindingProtocol(cfg("V2")), "V2");
  assert.equal(bindingProtocol(`<srvb:serviceBinding/>`), "V4", "default when no binding version is present");
});

test("publishUrl selects the protocol-correct publish endpoint (V2 uses the odatav2 job with query params)", () => {
  assert.match(publishUrl("z_o4", "V4"), /\/sap\/bc\/adt\/businessservices\/odatav4\/publishjobs$/);
  assert.match(publishUrl("z_o2", "V2"), /\/sap\/bc\/adt\/businessservices\/odatav2\/publishjobs\?servicename=Z_O2&serviceversion=0001/);
});
