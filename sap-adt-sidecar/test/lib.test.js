import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeError, classifyError } from "../lib/security.js";
import { parseSetCookies, cookieHeader, isValidCsrfToken, buildBaseUrl, withSapClient } from "../lib/session-utils.js";
import { escapeXml, parseAdtXml, findAll, attr } from "../lib/adt-xml.js";
import { ATC_SOURCE_URI, SOURCE_URI, OBJECT_URI, ACTIVATION, CREATION } from "../lib/adt-uris.js";

// ---- ADT object-URI maps (adt-uris.js) ----

test("SRVD is covered symmetrically across the object-URI maps", () => {
  // SRVD is lock/update (OBJECT_URI), activatable (ACTIVATION) and readable
  // (SOURCE_URI) — so it must also be single-object ATC-checkable. The ATC source
  // URI is identical to the read source URI for every other type.
  assert.ok(OBJECT_URI.SRVD && ACTIVATION.SRVD && SOURCE_URI.SRVD, "SRVD present in object/activation/source maps");
  assert.ok(ATC_SOURCE_URI.SRVD, "SRVD must have an ATC source URI");
  assert.equal(ATC_SOURCE_URI.SRVD("ZUI_X"), SOURCE_URI.SRVD("ZUI_X"), "ATC source URI matches the read source URI");
});

// G3: SRVD must also be CREATABLE (it was in every map EXCEPT CREATION — an existing
// SRVD was updatable/activatable but a new one could not be created). Grounded on
// abap-adt-api objectcreator.ts: srvd/sources collection, srvd:srvdSource root, srvdSourceType="S".
test("G3: SRVD is creatable — present in CREATION with the grounded srvd root", () => {
  assert.ok(CREATION.SRVD, "SRVD must be in CREATION");
  assert.equal(CREATION.SRVD.collection, "/sap/bc/adt/ddic/srvd/sources");
  assert.match(CREATION.SRVD.root, /srvdSource/i);
  assert.match(CREATION.SRVD.extra, /srvdSourceType/i);
});

// G3: TABL (DDIC database table) is source-based — wired symmetrically across ALL five
// maps. Grounded: /sap/bc/adt/ddic/tables, adtcore:type TABL/DT, create root blue:blueSource.
test("G3: TABL is wired across all five object-URI maps (source-based DDIC table)", () => {
  assert.ok(OBJECT_URI.TABL && ACTIVATION.TABL && SOURCE_URI.TABL && ATC_SOURCE_URI.TABL && CREATION.TABL, "TABL in all five maps");
  assert.equal(ACTIVATION.TABL.type, "TABL/DT");
  assert.equal(ATC_SOURCE_URI.TABL("ZFOO"), SOURCE_URI.TABL("ZFOO"), "ATC source URI matches the read source URI");
  assert.match(OBJECT_URI.TABL("ZFOO"), /\/sap\/bc\/adt\/ddic\/tables\/zfoo$/);
  assert.match(CREATION.TABL.root, /blueSource/i);
});

// G3: SRVB (service binding) is create/activate-wired but CONFIG-ONLY — it has no
// /source/main (abap-adt-api parses it as a config tree), so it must NOT be in the
// source maps. Grounded: /sap/bc/adt/businessservices/bindings, type SRVB/SVB.
test("G3: SRVB is create/activate-wired but config-only (no source/main)", () => {
  assert.ok(OBJECT_URI.SRVB && ACTIVATION.SRVB && CREATION.SRVB, "SRVB in object/activation/creation maps");
  assert.equal(ACTIVATION.SRVB.type, "SRVB/SVB");
  assert.match(OBJECT_URI.SRVB("ZUI_X_O4"), /\/sap\/bc\/adt\/businessservices\/bindings\/zui_x_o4$/);
  assert.ok(CREATION.SRVB.binding, "SRVB CREATION spec must flag a binding (config) create body");
  assert.ok(!SOURCE_URI.SRVB, "SRVB must NOT be in SOURCE_URI — config-only, no /source/main");
  assert.ok(!ATC_SOURCE_URI.SRVB, "SRVB must NOT be in ATC_SOURCE_URI — config-only");
});

// ---- security (ported from adapter.py _sanitize_error/_classify_error) ----

test("sanitizeError redacts credential-bearing URLs", () => {
  const out = sanitizeError("connect to https://user:pass@host:443/sap failed");
  assert.ok(!out.includes("user:pass"), out);
  assert.ok(out.includes("https://***@"), out);
});

test("sanitizeError redacts leaked X-SAP headers and truncates to 500", () => {
  const out = sanitizeError("X-SAP-Password: hunter2 and X-SAP-User: alice " + "x".repeat(600));
  assert.ok(!out.includes("hunter2"), out);
  assert.ok(!out.includes("alice"), out);
  assert.ok(out.length <= 500);
});

test("classifyError maps auth/connect/other to 401/502/500", () => {
  assert.equal(classifyError("HTTP 401 Unauthorized"), 401);
  assert.equal(classifyError("could not connect: host unreachable"), 502);
  assert.equal(classifyError("something else broke"), 500);
});

// ---- session-utils ----

test("parseSetCookies splits on the FIRST '=' only (base64 values survive)", () => {
  const jar = parseSetCookies(["SAP_SESSIONID_A1=abc==def; path=/; HttpOnly", "sap-usercontext=sap-client=100; path=/"]);
  assert.equal(jar.SAP_SESSIONID_A1, "abc==def");
  assert.equal(jar["sap-usercontext"], "sap-client=100");
});

test("cookieHeader joins the jar", () => {
  assert.equal(cookieHeader({ a: "1", b: "2" }), "a=1; b=2");
  assert.equal(cookieHeader({}), "");
});

test("isValidCsrfToken rejects placeholders", () => {
  assert.equal(isValidCsrfToken("Required"), false);
  assert.equal(isValidCsrfToken("fetch"), false);
  assert.equal(isValidCsrfToken("Fetch"), false);
  assert.equal(isValidCsrfToken(""), false);
  assert.equal(isValidCsrfToken(undefined), false);
  assert.equal(isValidCsrfToken("wLLNyBpDDLx4RhTvbCbjhw=="), true);
});

test("buildBaseUrl keeps an explicit scheme, defaults to https, appends port", () => {
  assert.equal(buildBaseUrl("myhost", "44300"), "https://myhost:44300");
  assert.equal(buildBaseUrl("http://legacy", "8000"), "http://legacy:8000");
  assert.equal(buildBaseUrl("https://secure.example", "443"), "https://secure.example:443");
});

test("withSapClient appends the sap-client query param correctly", () => {
  assert.equal(withSapClient("/sap/bc/adt/discovery", "100"), "/sap/bc/adt/discovery?sap-client=100");
  assert.equal(withSapClient("/x?a=1", "200"), "/x?a=1&sap-client=200");
});

// ---- adt-xml ----

test("escapeXml escapes the five XML metacharacters", () => {
  assert.equal(escapeXml(`a<b>&"c'`), "a&lt;b&gt;&amp;&quot;c&apos;");
});

test("parseAdtXml + findAll are namespace-agnostic (SAP prefixes vary by release)", () => {
  const xml = `<?xml version="1.0"?>
<chkrun:checkRunReports xmlns:chkrun="http://www.sap.com/adt/checkrun">
  <chkrun:checkReport chkrun:reporter="abapCheckRun">
    <chkrun:checkMessageList>
      <chkrun:checkMessage chkrun:uri="/sap/bc/adt/oo/classes/zcl_x/source/main#start=7,0" chkrun:type="E" chkrun:shortText="Syntax error"/>
      <chkrun:checkMessage chkrun:uri="/x#start=9,0" chkrun:type="W" chkrun:shortText="Warn"/>
    </chkrun:checkMessageList>
  </chkrun:checkReport>
</chkrun:checkRunReports>`;
  const doc = parseAdtXml(xml);
  const msgs = findAll(doc, "checkMessage");
  assert.equal(msgs.length, 2);
  assert.equal(attr(msgs[0], "type"), "E");
  assert.match(attr(msgs[0], "uri"), /#start=7/);
  assert.equal(attr(msgs[1], "shortText"), "Warn");
});

test("findAll reaches nested atom-style elements regardless of prefix", () => {
  const xml = `<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">
  <adtcore:objectReference adtcore:uri="/sap/bc/adt/oo/classes/zcl_a" adtcore:name="ZCL_A" adtcore:type="CLAS/OC" adtcore:description="d"/>
</adtcore:objectReferences>`;
  const refs = findAll(parseAdtXml(xml), "objectReference");
  assert.equal(refs.length, 1);
  assert.equal(attr(refs[0], "name"), "ZCL_A");
});
