import { test } from "node:test";
import assert from "node:assert/strict";
import { creationBody, createObject } from "../handlers/write.js";
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
