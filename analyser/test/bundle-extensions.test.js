import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { filesFromBundle } from "../src/modes.js";
import { analyzePackage } from "../src/orchestrator.js";

// R7 (Arc C adversarial pass, confirmed by probe 2026-08-09): the bundle loader admitted only
// .abap / .asddls / .asbdef / .asdcls / .acds. A generated RAP surface also contains the SERVICE and
// METADATA artifacts — .srvd (service definition), .srvb (service binding), .asddlx (metadata extension)
// and .asdbtab (DB table) — so those files were dropped before analysis and graded by nothing.
//
// The service binding is the OData exposure surface: it is what P2's "Use as Remote API" contract and the
// Clean-Core gate exist to check. Dropping it meant the moderniser's final review rendered a verdict over a
// partially-read surface while appearing to read all of it. The analyser was always able to grade these —
// probed: a real .srvd/.srvb/.asddlx/.asdbtab set yields check_ddic + tabl_enhancement_category — so the
// gap was one array, not a missing capability.

function bundleWith(files) {
  const dir = mkdtempSync(join(tmpdir(), "bundle-ext-"));
  mkdirSync(dir, { recursive: true });
  for (const [name, src] of Object.entries(files)) writeFileSync(join(dir, name), src, "utf8");
  return dir;
}

const RAP_SURFACE = {
  "zi_x.ddls.asddls": `@AccessControl.authorizationCheck: #CHECK
@EndUserText.label: 'Item'
define view entity ZI_X as select from sflight { key carrid as Carrid }`,
  "zc_x.ddlx.asddlx": `@Metadata.layer: #CORE
annotate entity ZC_X with { @UI.lineItem: [{ position: 10 }] Carrid; }`,
  "ztx.tabl.asdbtab": `@EndUserText.label : 'Item table'
define table ztx { key client : abap.clnt not null; key id : abap.char(10) not null; }`,
  "zui_x.srvd.srvd": `@EndUserText.label: 'Item service'
define service ZUI_X { expose ZC_X as Item; }`,
  "zui_x_o4.srvb.srvb": `<?xml version="1.0" encoding="utf-8"?><abapGit version="v1.0.0"><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><SRVB><SERVICE_BINDING>ZUI_X_O4</SERVICE_BINDING><BINDING_TYPE>ODATA_V4_UI</BINDING_TYPE></SRVB></asx:values></asx:abap></abapGit>`,
};

test("the loader admits the whole generated RAP surface, service and metadata artifacts included", () => {
  const files = filesFromBundle(bundleWith(RAP_SURFACE));
  const names = files.map((f) => f.filename);
  for (const expected of Object.keys(RAP_SURFACE)) {
    assert.ok(
      names.some((n) => n.endsWith(expected)),
      `${expected} was dropped before analysis — it would be generated and graded by nothing`,
    );
  }
});

test("the service binding — the OData exposure surface — reaches the analyser", () => {
  // Named separately because this is the one with a security contract behind it: P2 grades a remote-API
  // exposure, and it cannot grade a file it never receives.
  const files = filesFromBundle(bundleWith(RAP_SURFACE));
  assert.ok(files.some((f) => f.filename.endsWith(".srvb.srvb")), "the service binding must be loaded");
  assert.ok(files.some((f) => f.filename.endsWith(".srvd.srvd")), "the service definition must be loaded");
});

test("analysing the widened surface stays sound — no crash, findings still produced", () => {
  const files = filesFromBundle(bundleWith(RAP_SURFACE));
  const doc = analyzePackage(files, { package: "r7" });
  assert.ok(Array.isArray(doc.findings), "the widened set still analyses");
  assert.equal(
    doc.findings.filter((f) => f.rule_id === "abaplint_engine_error").length,
    0,
    "and the new file types do not crash the engine",
  );
});

test("an unrelated file type is still ignored — the widening is a list, not a free-for-all", () => {
  const files = filesFromBundle(bundleWith({ ...RAP_SURFACE, "notes.md": "# not source", "build.log": "x" }));
  const names = files.map((f) => f.filename);
  assert.ok(!names.some((n) => n.endsWith(".md")), "markdown is not ABAP source");
  assert.ok(!names.some((n) => n.endsWith(".log")), "logs are not ABAP source");
});
