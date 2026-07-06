import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeError, classifyError } from "../lib/security.js";
import { parseSetCookies, cookieHeader, isValidCsrfToken, buildBaseUrl, withSapClient } from "../lib/session-utils.js";
import { escapeXml, parseAdtXml, findAll, attr } from "../lib/adt-xml.js";

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
