import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRegistry } from "../src/abaplint-loader.js";
import { analyzeRegistry } from "../src/semantic.js";
import { bfPack } from "../rules/bf-pack.js";
import { srvbPack } from "../rules/srvb-pack.js";
import { isAlwaysOff, offOwnerOf } from "../src/business-functions.js";

const ids = (f) => f.map((x) => x.rule_id);

// ---- business-function registry (real bundled data) ----

test("the bundled BF registry answers always-off and ownership queries", () => {
  assert.equal(isAlwaysOff("LOG_PP_DOCS_LEGACY"), true);
  assert.equal(isAlwaysOff("FIN_GL_CI_1"), false, "always-on BF is not off");
  assert.equal(offOwnerOf("PP_DOCS_LEGACY"), "LOG_PP_DOCS_LEGACY");
  assert.equal(offOwnerOf("T800A"), undefined, "objects of always-on BFs are not flagged");
});

test("probing an always-off business function is flagged p1 (CLOUD-34)", () => {
  const src = `CLASS zcl_bf DEFINITION PUBLIC FINAL FOR TESTING.
  PUBLIC SECTION.
    METHODS run.
ENDCLASS.
CLASS zcl_bf IMPLEMENTATION.
  METHOD run.
    IF cl_sfw_bf_status_check=>is_active( 'LOG_PP_DOCS_LEGACY' ) = abap_true.
      lv_x = 1.
    ENDIF.
  ENDMETHOD.
ENDCLASS.`;
  const reg = loadRegistry([{ filename: "zcl_bf.clas.abap", source: src }]);
  const f = bfPack.check({ reg, graph: analyzeRegistry(reg) });
  const hit = f.find((x) => x.rule_id === "talos-bf-always-off-probe");
  assert.ok(hit, ids(f).join(","));
  assert.equal(hit.severity, "priority-1");

  const onSrc = src.replace("LOG_PP_DOCS_LEGACY", "FIN_GL_CI_1");
  const reg2 = loadRegistry([{ filename: "zcl_bf.clas.abap", source: onSrc }]);
  const f2 = bfPack.check({ reg: reg2, graph: analyzeRegistry(reg2) });
  assert.ok(!ids(f2).includes("talos-bf-always-off-probe"), "always-on BF probe passes");
});

test("a dependency on an object owned by an always-off BF is flagged p1 (CLOUD-34)", () => {
  const src = `CLASS zcl_dep DEFINITION PUBLIC FINAL FOR TESTING.
  PUBLIC SECTION.
    METHODS run.
ENDCLASS.
CLASS zcl_dep IMPLEMENTATION.
  METHOD run.
    SELECT SINGLE * FROM pp_docs_legacy INTO @DATA(ls).
  ENDMETHOD.
ENDCLASS.`;
  const reg = loadRegistry([{ filename: "zcl_dep.clas.abap", source: src }]);
  const f = bfPack.check({ reg, graph: analyzeRegistry(reg) });
  const hit = f.find((x) => x.rule_id === "talos-bf-owned-object-ref");
  assert.ok(hit, ids(f).join(","));
  assert.match(hit.message, /LOG_PP_DOCS_LEGACY/);
});

// ---- SRVB chain (PERF-21/30) ----

const CDS_NO_PAGING = {
  filename: "zc_orders.ddls.asddls",
  source: `@AccessControl.authorizationCheck: #CHECK
@ObjectModel.usageType.sizeCategory: #XL
define view entity ZC_Orders as select from vbak { key vbeln }`,
};
const CDS_PAGED = {
  filename: "zc_orders.ddls.asddls",
  source: `@AccessControl.authorizationCheck: #CHECK
@UI.presentationVariant: [{ maxItems: 100 }]
define view entity ZC_Orders as select from vbak { key vbeln }`,
};
const SRVD = {
  filename: "zsd_orders.srvd.asrvd",
  source: `@EndUserText.label: 'Orders service'
define service ZSD_ORDERS {
  expose ZC_Orders as Orders;
}`,
};
const SRVB = {
  filename: "zui_orders_o2.srvb.xml",
  source: `<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0" serializer="LCL_OBJECT_SRVB">
 <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
  <asx:values>
   <SRVB><HEADER><SRVB_NAME>ZUI_ORDERS_O2</SRVB_NAME><BINDING_TYPE>ODATA</BINDING_TYPE><BINDING_VERSION>V2</BINDING_VERSION></HEADER>
   <SERVICES><SERVICE><SRVD_NAME>ZSD_ORDERS</SRVD_NAME></SERVICE></SERVICES></SRVB>
  </asx:values>
 </asx:abap>
</abapGit>`,
};

test("an exposed entity without a paging policy is flagged through the SRVB chain (PERF-21)", () => {
  const f = srvbPack.check({ reg: loadRegistry([SRVB, SRVD, CDS_NO_PAGING]) });
  assert.ok(ids(f).includes("talos-srvb-no-paging-policy"), ids(f).join(","));
});

test("a large entity over OData V2 advises cursor paging (PERF-30)", () => {
  const f = srvbPack.check({ reg: loadRegistry([SRVB, SRVD, CDS_NO_PAGING]) });
  assert.ok(ids(f).includes("talos-srvb-offset-paging"));
});

test("a paged entity raises neither SRVB finding; an incomplete chain stays silent", () => {
  const paged = srvbPack.check({ reg: loadRegistry([SRVB, SRVD, CDS_PAGED]) });
  assert.deepEqual(ids(paged), []);
  const incomplete = srvbPack.check({ reg: loadRegistry([SRVB, SRVD]) }); // CDS missing
  assert.deepEqual(ids(incomplete), []);
});

// F6: the SRVB->SRVD join must match the <SRVD_NAME> element, not a raw
// substring. A binding for ZSD_ORDERS_EXT must NOT over-join the unrelated
// base service ZSD_ORDERS (whose name is a substring of the bound name).
test("the SRVB->SRVD join matches <SRVD_NAME>, not a raw substring (F6)", () => {
  const srvbExt = {
    filename: "zui_ext_o2.srvb.xml",
    source: `<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0" serializer="LCL_OBJECT_SRVB">
 <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
  <asx:values>
   <SRVB><HEADER><SRVB_NAME>ZUI_EXT_O2</SRVB_NAME><BINDING_TYPE>ODATA</BINDING_TYPE><BINDING_VERSION>V2</BINDING_VERSION></HEADER>
   <SERVICES><SERVICE><SRVD_NAME>ZSD_ORDERS_EXT</SRVD_NAME></SERVICE></SERVICES></SRVB>
  </asx:values>
 </asx:abap>
</abapGit>`,
  };
  const srvdExt = { filename: "zsd_orders_ext.srvd.asrvd", source: `define service ZSD_ORDERS_EXT {\n  expose ZC_Ext as Ext;\n}` };
  const srvdBase = { filename: "zsd_orders.srvd.asrvd", source: `define service ZSD_ORDERS {\n  expose ZC_Base as Base;\n}` };
  const cdsExtPaged = { filename: "zc_ext.ddls.asddls", source: `@UI.presentationVariant: [{ maxItems: 100 }]\ndefine view entity ZC_Ext as select from vbak { key vbeln }` };
  const cdsBaseUnpaged = { filename: "zc_base.ddls.asddls", source: `@AccessControl.authorizationCheck: #CHECK\ndefine view entity ZC_Base as select from vbak { key vbeln }` };
  const f = srvbPack.check({ reg: loadRegistry([srvbExt, srvdExt, srvdBase, cdsExtPaged, cdsBaseUnpaged]) });
  // Binding references only ZSD_ORDERS_EXT (paged) -> zero findings; the
  // substring bug would over-join ZSD_ORDERS (base, unpaged) -> false PERF-21.
  assert.deepEqual(ids(f), [], JSON.stringify(f.map((x) => x.message)));
});

// F7: the CDS must resolve by its entity name (what the SRVD exposes), even
// when the DDLS source/object name differs from it — otherwise a fully
// in-bundle chain is silently missed.
test("the SRVB chain resolves the CDS by entity name, not just DDLS source name (F7)", () => {
  const srvb = {
    filename: "zui_x_o2.srvb.xml",
    source: `<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0" serializer="LCL_OBJECT_SRVB">
 <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
  <asx:values>
   <SRVB><HEADER><SRVB_NAME>ZUI_X_O2</SRVB_NAME><BINDING_TYPE>ODATA</BINDING_TYPE><BINDING_VERSION>V2</BINDING_VERSION></HEADER>
   <SERVICES><SERVICE><SRVD_NAME>ZSD_X</SRVD_NAME></SERVICE></SERVICES></SRVB>
  </asx:values>
 </asx:abap>
</abapGit>`,
  };
  const srvd = { filename: "zsd_x.srvd.asrvd", source: `define service ZSD_X {\n  expose ZC_Orders as Orders;\n}` };
  // DDLS source name (ZI_ORDERS_DDL) differs from the exposed entity (ZC_Orders)
  const cds = { filename: "zi_orders_ddl.ddls.asddls", source: `@AccessControl.authorizationCheck: #CHECK\ndefine view entity ZC_Orders as select from vbak { key vbeln }` };
  const f = srvbPack.check({ reg: loadRegistry([srvb, srvd, cds]) });
  assert.ok(ids(f).includes("talos-srvb-no-paging-policy"), JSON.stringify(f.map((x) => x.message)));
});
