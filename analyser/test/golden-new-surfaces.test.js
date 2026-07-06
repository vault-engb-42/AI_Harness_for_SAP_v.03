import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { analyzePackage } from "../src/orchestrator.js";
import { validateFindings } from "../src/validate-findings.js";
import { tabl, field } from "./helpers/abapgit-xml.js";

// Golden coverage for the 8 packs added 2026-07-04 (ddic, rap-context, srvb,
// bf, flow, clone, intf, test-quality). The pack unit tests exercise each in
// isolation; THIS suite proves they fire END-TO-END through analyzePackage
// (parse -> CPG -> rules -> assemble) on the new surfaces (DDIC XML, SRVB
// chain, cross-artifact BDEF, ...) and that the assembled document is
// schema-valid, deterministic, and free of out-of-schema finding keys.
// Presence-based (robust to rule growth), not a brittle full snapshot.

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(readFileSync(join(HERE, "..", "..", ".claude", "schemas", "analyser-findings.schema.json"), "utf8"));
const ALLOWED_FINDING_KEYS = new Set(Object.keys(SCHEMA.properties.findings.items.properties));

const SRVB = `<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0" serializer="LCL_OBJECT_SRVB">
 <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
  <asx:values>
   <SRVB><HEADER><SRVB_NAME>ZUI_ORDERS_O2</SRVB_NAME><BINDING_TYPE>ODATA</BINDING_TYPE><BINDING_VERSION>V2</BINDING_VERSION></HEADER>
   <SERVICES><SERVICE><SRVD_NAME>ZSD_ORDERS</SRVD_NAME></SERVICE></SERVICES></SRVB>
  </asx:values>
 </asx:abap>
</abapGit>`;

const FILES = [
  // ddic-pack (PERF-53): a cluster table
  tabl("ZT_CLUST", { category: "CLUSTER", fields: [field("MANDT", true, "MANDT"), field("F1", true)] }),
  // rap-context (CC-3): strict(2) BDEF joined to its impl class using CALL TRANSACTION
  { filename: "zbp_strict.bdef.asbdef", source: `managed implementation in class zbp_strict unique;\nstrict ( 2 );\ndefine behavior for ZI_S alias S\n{ create; }` },
  { filename: "zbp_strict.clas.abap", source: `CLASS zbp_strict DEFINITION PUBLIC FINAL.\n  PUBLIC SECTION.\n    METHODS run.\nENDCLASS.\nCLASS zbp_strict IMPLEMENTATION.\n  METHOD run.\n    CALL TRANSACTION 'VA01'.\n  ENDMETHOD.\nENDCLASS.` },
  // srvb-pack (PERF-21): SRVB -> SRVD -> unpaged CDS chain
  { filename: "zui_orders_o2.srvb.xml", source: SRVB },
  { filename: "zsd_orders.srvd.asrvd", source: `define service ZSD_ORDERS {\n  expose ZC_Orders as Orders;\n}` },
  { filename: "zc_orders.ddls.asddls", source: `@AccessControl.authorizationCheck: #CHECK\ndefine view entity ZC_Orders as select from vbak { key vbeln }` },
  // bf-pack (CLOUD-34): probe of an always-off business function
  { filename: "zcl_bf.clas.abap", source: `CLASS zcl_bf DEFINITION PUBLIC FINAL.\n  PUBLIC SECTION.\n    METHODS run.\nENDCLASS.\nCLASS zcl_bf IMPLEMENTATION.\n  METHOD run.\n    IF cl_sfw_bf_status_check=>is_active( 'LOG_PP_DOCS_LEGACY' ) = abap_true.\n      lv_x = 1.\n    ENDIF.\n  ENDMETHOD.\nENDCLASS.` },
  // flow-pack (CLOUD-28): 3 legacy-UI statements
  { filename: "zcl_ui.clas.abap", source: `CLASS zcl_ui DEFINITION PUBLIC FINAL.\n  PUBLIC SECTION.\n    METHODS run.\nENDCLASS.\nCLASS zcl_ui IMPLEMENTATION.\n  METHOD run.\n    WRITE 'a'.\n    WRITE 'b'.\n    WRITE 'c'.\n  ENDMETHOD.\nENDCLASS.` },
  // clone-pack (HARDY-2): a 6-line block duplicated across two methods
  { filename: "zcl_dup.clas.abap", source: `CLASS zcl_dup DEFINITION PUBLIC FINAL.\n  PUBLIC SECTION.\n    METHODS m1.\n    METHODS m2.\nENDCLASS.\nCLASS zcl_dup IMPLEMENTATION.\n  METHOD m1.\n    lv_a = 1.\n    lv_b = 2.\n    lv_c = lv_a + lv_b.\n    lv_d = lv_c * 2.\n    lv_e = lv_d - 1.\n    lv_f = lv_e + 3.\n  ENDMETHOD.\n  METHOD m2.\n    lv_a = 1.\n    lv_b = 2.\n    lv_c = lv_a + lv_b.\n    lv_d = lv_c * 2.\n    lv_e = lv_d - 1.\n    lv_f = lv_e + 3.\n  ENDMETHOD.\nENDCLASS.` },
  // intf-pack (PERF-47): a table-returning interface method with no paging param
  { filename: "zif_rd.intf.abap", source: `INTERFACE zif_rd PUBLIC.\n  METHODS get_all RETURNING VALUE(rt) TYPE STANDARD TABLE.\nENDINTERFACE.` },
  // test-quality-pack (CLEAN-015): a FOR TESTING method with no assertion
  { filename: "zcl_calc.clas.abap", source: `CLASS zcl_calc DEFINITION PUBLIC FINAL CREATE PUBLIC.\n  PUBLIC SECTION.\n    METHODS add IMPORTING iv_a TYPE i iv_b TYPE i RETURNING VALUE(rv) TYPE i.\nENDCLASS.\nCLASS zcl_calc IMPLEMENTATION.\n  METHOD add.\n    rv = iv_a + iv_b.\n  ENDMETHOD.\nENDCLASS.` },
  { filename: "zcl_calc.clas.testclasses.abap", source: `CLASS ltcl_calc DEFINITION FINAL FOR TESTING DURATION SHORT RISK LEVEL HARMLESS.\n  PRIVATE SECTION.\n    METHODS test_empty FOR TESTING.\nENDCLASS.\nCLASS ltcl_calc IMPLEMENTATION.\n  METHOD test_empty.\n    DATA(lo) = NEW zcl_calc( ).\n  ENDMETHOD.\nENDCLASS.` },
];

const OPTS = { source_system: "DEV100", package: "ZGOLDEN_NEW", generated_at: "2026-07-04T00:00:00Z" };
const doc = analyzePackage(FILES, OPTS);
const ruleIds = new Set(doc.findings.map((f) => f.rule_id));

test("the new-surface golden document is schema-valid", () => {
  const { valid, errors } = validateFindings(doc);
  assert.ok(valid, errors.join("; "));
});

test("analysis of the new surfaces is deterministic (byte-identical output)", () => {
  assert.equal(JSON.stringify(analyzePackage(FILES, OPTS)), JSON.stringify(analyzePackage(FILES, OPTS)));
});

test("every emitted finding uses only schema-allowed keys (additionalProperties guard)", () => {
  // The in-house validator does not enforce additionalProperties; this guard
  // catches a pack that adds a field a real JSON-schema validator would reject.
  for (const f of doc.findings) {
    for (const k of Object.keys(f)) {
      assert.ok(ALLOWED_FINDING_KEYS.has(k), `finding ${f.rule_id} has out-of-schema key '${k}'`);
    }
  }
});

test("each of the 8 new packs fires end-to-end through analyzePackage", () => {
  const expected = {
    "ddic-pack (PERF-53)": "talos-tabl-cluster-pool",
    "rap-context (CC-3)": "talos-strict-call-transaction",
    "srvb-pack (PERF-21)": "talos-srvb-no-paging-policy",
    "bf-pack (CLOUD-34)": "talos-bf-always-off-probe",
    "flow-pack (CLOUD-28)": "talos-legacy-ui-rollup",
    "clone-pack (HARDY-2)": "talos-duplicate-block",
    "intf-pack (PERF-47)": "talos-intf-read-no-paging",
    "test-quality-pack (CLEAN-015)": "talos-test-no-assert",
  };
  for (const [label, id] of Object.entries(expected)) {
    assert.ok(ruleIds.has(id), `${label} did not fire through the pipeline: ${id}`);
  }
});
