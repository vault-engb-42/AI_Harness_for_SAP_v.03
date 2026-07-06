import { test } from "node:test";
import assert from "node:assert/strict";
import { lintAbapCloud, formatViolationsForRepair } from "../src/cloud-linter.js";

// GF-2 — the dedicated ABAP-Cloud generation linter. Parser-based (@abaplint/core
// library, greenfield's own loader), NOT the analyser. Every test lints REAL ABAP
// source through the real parser — no mocks. One trigger + one clean sample per
// rule proves the rule fires on the anti-pattern and stays silent on clean code.

/** @returns {string[]} the distinct rule_ids present in a lint result */
function ruleIds(res) {
  return [...new Set(res.findings.map((f) => f.rule_id))];
}
/** @returns {object|undefined} the first finding for a rule_id */
function finding(res, ruleId) {
  return res.findings.find((f) => f.rule_id === ruleId);
}

// ---------------------------------------------------------------- CLOUD-forbidden

test("gf-cloud-no-tables fires on a TABLES declaration", () => {
  const res = lintAbapCloud([{ filename: "zr_x.prog.abap", source: "REPORT zr_x.\nTABLES vbak." }]);
  const f = finding(res, "gf-cloud-no-tables");
  assert.ok(f, "TABLES must be flagged");
  assert.equal(f.severity, "error");
  assert.equal(f.family, "abap-cloud");
});

test("gf-cloud-no-write fires on WRITE list output", () => {
  const res = lintAbapCloud([{ filename: "zr_x.prog.abap", source: "REPORT zr_x.\nSTART-OF-SELECTION.\n  WRITE 'hi'." }]);
  assert.equal(finding(res, "gf-cloud-no-write")?.severity, "error");
});

test("gf-cloud-no-native-sql fires on EXEC SQL", () => {
  const res = lintAbapCloud([{ filename: "zr_x.prog.abap", source: "REPORT zr_x.\nSTART-OF-SELECTION.\n  EXEC SQL.\n  ENDEXEC." }]);
  assert.equal(finding(res, "gf-cloud-no-native-sql")?.severity, "error");
});

test("gf-cloud-no-dynpro fires on CALL SCREEN and SET SCREEN", () => {
  const res = lintAbapCloud([{ filename: "zr_x.prog.abap", source: "REPORT zr_x.\nSTART-OF-SELECTION.\n  CALL SCREEN 100.\n  SET SCREEN 200." }]);
  assert.equal(finding(res, "gf-cloud-no-dynpro")?.severity, "error");
});

test("gf-cloud-no-call-transaction fires on CALL TRANSACTION", () => {
  const res = lintAbapCloud([{ filename: "zr_x.prog.abap", source: "REPORT zr_x.\nSTART-OF-SELECTION.\n  CALL TRANSACTION 'VA01'." }]);
  assert.equal(finding(res, "gf-cloud-no-call-transaction")?.severity, "error");
});

test("gf-cloud-call-function is a WARNING on CALL FUNCTION", () => {
  const res = lintAbapCloud([{ filename: "zr_x.prog.abap", source: "REPORT zr_x.\nSTART-OF-SELECTION.\n  CALL FUNCTION 'Z_FM'." }]);
  assert.equal(finding(res, "gf-cloud-call-function")?.severity, "warning");
});

test("gf-cloud-with-header-line fires on WITH HEADER LINE", () => {
  const res = lintAbapCloud([{ filename: "zr_x.prog.abap", source: "REPORT zr_x.\nDATA itab TYPE TABLE OF string WITH HEADER LINE." }]);
  assert.equal(finding(res, "gf-cloud-with-header-line")?.severity, "error");
});

test("clean ABAP-Cloud class raises no CLOUD-forbidden finding", () => {
  const src = "CLASS zcl_ok DEFINITION PUBLIC FINAL CREATE PUBLIC.\n  PUBLIC SECTION.\n    METHODS run RETURNING VALUE(rv) TYPE i.\nENDCLASS.\nCLASS zcl_ok IMPLEMENTATION.\n  METHOD run.\n    rv = 1.\n  ENDMETHOD.\nENDCLASS.";
  const res = lintAbapCloud([{ filename: "zcl_ok.clas.abap", source: src }]);
  const forbidden = ["gf-cloud-no-tables", "gf-cloud-no-write", "gf-cloud-no-native-sql", "gf-cloud-no-dynpro", "gf-cloud-no-call-transaction", "gf-cloud-with-header-line"];
  assert.deepEqual(ruleIds(res).filter((r) => forbidden.includes(r)), []);
});

// ---------------------------------------------------------------- performance / loop

test("gf-cloud-select-star fires on SELECT *", () => {
  const res = lintAbapCloud([{ filename: "zr_x.prog.abap", source: "REPORT zr_x.\nSTART-OF-SELECTION.\n  SELECT SINGLE * FROM vbak INTO @DATA(ls) WHERE vbeln = '1'." }]);
  assert.equal(finding(res, "gf-cloud-select-star")?.severity, "warning");
});

test("gf-perf-select-in-loop fires on SELECT inside LOOP", () => {
  const src = "REPORT zr_x.\nDATA lt TYPE TABLE OF string.\nSTART-OF-SELECTION.\n  LOOP AT lt INTO DATA(w).\n    SELECT SINGLE vbeln FROM vbak INTO @DATA(v) WHERE vbeln = @w.\n  ENDLOOP.";
  const res = lintAbapCloud([{ filename: "zr_x.prog.abap", source: src }]);
  assert.equal(finding(res, "gf-perf-select-in-loop")?.severity, "warning");
});

test("a SELECT outside any loop does NOT raise select-in-loop", () => {
  const res = lintAbapCloud([{ filename: "zr_x.prog.abap", source: "REPORT zr_x.\nSTART-OF-SELECTION.\n  SELECT SINGLE vbeln FROM vbak INTO @DATA(v) WHERE vbeln = '1'." }]);
  assert.equal(finding(res, "gf-perf-select-in-loop"), undefined);
});

// ---------------------------------------------------------------- invariant

test("gf-inv-commit-in-loop fires on COMMIT WORK inside LOOP", () => {
  const src = "REPORT zr_x.\nDATA lt TYPE TABLE OF string.\nSTART-OF-SELECTION.\n  LOOP AT lt INTO DATA(w).\n    COMMIT WORK.\n  ENDLOOP.";
  const res = lintAbapCloud([{ filename: "zr_x.prog.abap", source: src }]);
  assert.equal(finding(res, "gf-inv-commit-in-loop")?.severity, "error");
});

test("gf-inv-authcheck-no-subrc fires when SY-SUBRC is not checked", () => {
  const src = "REPORT zr_x.\nSTART-OF-SELECTION.\n  AUTHORITY-CHECK OBJECT 'S_X' ID 'ACTVT' FIELD '03'.\n  WRITE 'ok'.";
  const res = lintAbapCloud([{ filename: "zr_x.prog.abap", source: src }]);
  assert.equal(finding(res, "gf-inv-authcheck-no-subrc")?.severity, "warning");
});

test("AUTHORITY-CHECK followed by IF sy-subrc is clean", () => {
  const src = "REPORT zr_x.\nSTART-OF-SELECTION.\n  AUTHORITY-CHECK OBJECT 'S_X' ID 'ACTVT' FIELD '03'.\n  IF sy-subrc <> 0.\n    RETURN.\n  ENDIF.";
  const res = lintAbapCloud([{ filename: "zr_x.prog.abap", source: src }]);
  assert.equal(finding(res, "gf-inv-authcheck-no-subrc"), undefined);
});

test("gf-x-authcheck-subrc-after-write fires when SY-SUBRC is tested only AFTER a protected write (ordering)", () => {
  const body = "    DATA ls TYPE vbak.\n    AUTHORITY-CHECK OBJECT 'S_X' ID 'ACTVT' FIELD '03'.\n    INSERT vbak FROM ls.\n    IF sy-subrc <> 0.\n      RETURN.\n    ENDIF.";
  const res = lintAbapCloud([{ filename: "zcl_x.clas.abap", source: clazz(body) }]);
  assert.equal(finding(res, "gf-x-authcheck-subrc-after-write")?.severity, "error");
  assert.equal(finding(res, "gf-inv-authcheck-no-subrc"), undefined, "the ordering rule fires, not the presence rule");
});

test("AUTHORITY-CHECK with SY-SUBRC tested BEFORE the write is clean (correct gate order)", () => {
  const body = "    DATA ls TYPE vbak.\n    AUTHORITY-CHECK OBJECT 'S_X' ID 'ACTVT' FIELD '03'.\n    IF sy-subrc <> 0.\n      RETURN.\n    ENDIF.\n    INSERT vbak FROM ls.";
  const res = lintAbapCloud([{ filename: "zcl_x.clas.abap", source: clazz(body) }]);
  assert.equal(finding(res, "gf-x-authcheck-subrc-after-write"), undefined);
  assert.equal(finding(res, "gf-inv-authcheck-no-subrc"), undefined);
});

test("a MODIFY on a declared local internal table is not a 'protected write' for the ordering rule", () => {
  const body = "    DATA lt TYPE TABLE OF string.\n    DATA ls TYPE string.\n    AUTHORITY-CHECK OBJECT 'S_X' ID 'ACTVT' FIELD '03'.\n    MODIFY TABLE lt FROM ls.\n    IF sy-subrc <> 0.\n      RETURN.\n    ENDIF.";
  const res = lintAbapCloud([{ filename: "zcl_x.clas.abap", source: clazz(body) }]);
  assert.equal(finding(res, "gf-x-authcheck-subrc-after-write"), undefined, "an itab MODIFY is not a persistence write; subrc-after is fine");
});

// ---------------------------------------------------------------- rap-odata

test("gf-rap-direct-db-write fires on a direct INSERT to a DDIC table", () => {
  const src = "CLASS zcl_x DEFINITION PUBLIC FINAL CREATE PUBLIC.\n  PUBLIC SECTION.\n    METHODS save.\nENDCLASS.\nCLASS zcl_x IMPLEMENTATION.\n  METHOD save.\n    DATA ls TYPE vbak.\n    INSERT vbak FROM ls.\n  ENDMETHOD.\nENDCLASS.";
  const res = lintAbapCloud([{ filename: "zcl_x.clas.abap", source: src }]);
  assert.equal(finding(res, "gf-rap-direct-db-write")?.severity, "warning");
});

test("a MODIFY on a declared local internal table is NOT a direct DB write", () => {
  const src = "CLASS zcl_x DEFINITION PUBLIC FINAL CREATE PUBLIC.\n  PUBLIC SECTION.\n    METHODS save.\nENDCLASS.\nCLASS zcl_x IMPLEMENTATION.\n  METHOD save.\n    DATA lt TYPE TABLE OF string.\n    DATA ls TYPE string.\n    MODIFY TABLE lt FROM ls.\n  ENDMETHOD.\nENDCLASS.";
  const res = lintAbapCloud([{ filename: "zcl_x.clas.abap", source: src }]);
  assert.equal(finding(res, "gf-rap-direct-db-write"), undefined);
});

// ---------------------------------------------------------------- cds

test("gf-cds-classic-view fires on DEFINE VIEW without ENTITY", () => {
  const res = lintAbapCloud([{ filename: "zi_v.ddls.asddls", source: "define view zi_v as select from vbak { key vbeln }" }]);
  assert.equal(finding(res, "gf-cds-classic-view")?.severity, "error");
});

test("a CDS view ENTITY is clean", () => {
  const res = lintAbapCloud([{ filename: "zi_v.ddls.asddls", source: "define view entity zi_v as select from vbak { key vbeln }" }]);
  assert.equal(finding(res, "gf-cds-classic-view"), undefined);
});

// ---------------------------------------------------------------- anti-pattern (HARDY)

test("gf-hardy-test-no-assert fires on a FOR TESTING method with no assertion", () => {
  const main = "CLASS zcl_calc DEFINITION PUBLIC FINAL CREATE PUBLIC.\n  PUBLIC SECTION.\n    METHODS add RETURNING VALUE(rv) TYPE i.\nENDCLASS.\nCLASS zcl_calc IMPLEMENTATION.\n  METHOD add.\n    rv = 2.\n  ENDMETHOD.\nENDCLASS.";
  const testcls = "CLASS ltc_calc DEFINITION FOR TESTING RISK LEVEL HARMLESS DURATION SHORT FINAL.\n  PRIVATE SECTION.\n    METHODS t1 FOR TESTING.\nENDCLASS.\nCLASS ltc_calc IMPLEMENTATION.\n  METHOD t1.\n    DATA(x) = 1 + 1.\n  ENDMETHOD.\nENDCLASS.";
  const res = lintAbapCloud([
    { filename: "zcl_calc.clas.abap", source: main },
    { filename: "zcl_calc.clas.testclasses.abap", source: testcls },
  ]);
  assert.equal(finding(res, "gf-hardy-test-no-assert")?.severity, "warning");
});

test("a FOR TESTING method that asserts is clean", () => {
  const main = "CLASS zcl_calc DEFINITION PUBLIC FINAL CREATE PUBLIC.\n  PUBLIC SECTION.\n    METHODS add RETURNING VALUE(rv) TYPE i.\nENDCLASS.\nCLASS zcl_calc IMPLEMENTATION.\n  METHOD add.\n    rv = 2.\n  ENDMETHOD.\nENDCLASS.";
  const testcls = "CLASS ltc_calc DEFINITION FOR TESTING RISK LEVEL HARMLESS DURATION SHORT FINAL.\n  PRIVATE SECTION.\n    METHODS t1 FOR TESTING.\nENDCLASS.\nCLASS ltc_calc IMPLEMENTATION.\n  METHOD t1.\n    cl_abap_unit_assert=>assert_equals( act = 2 exp = 2 ).\n  ENDMETHOD.\nENDCLASS.";
  const res = lintAbapCloud([
    { filename: "zcl_calc.clas.abap", source: main },
    { filename: "zcl_calc.clas.testclasses.abap", source: testcls },
  ]);
  assert.equal(finding(res, "gf-hardy-test-no-assert"), undefined);
});

// ---------------------------------------------------------------- released-api (GF-1 link)

test("gf-ground-deprecated fires on a deprecated SAP ref and names the successor", () => {
  const src = "CLASS zcl_g DEFINITION PUBLIC FINAL CREATE PUBLIC.\n  PUBLIC SECTION.\n    METHODS run.\nENDCLASS.\nCLASS zcl_g IMPLEMENTATION.\n  METHOD run.\n    DATA lo TYPE REF TO cl_a4c_bc_factory.\n  ENDMETHOD.\nENDCLASS.";
  const res = lintAbapCloud([{ filename: "zcl_g.clas.abap", source: src }]);
  const f = finding(res, "gf-ground-deprecated");
  assert.equal(f?.severity, "error");
  assert.match(f.message, /CL_BCFG_CD_REUSE_API_FACTORY/);
});

test("gf-ground-not-released fires on a notToBeReleased SAP ref", () => {
  const src = "CLASS zcl_g DEFINITION PUBLIC FINAL CREATE PUBLIC.\n  PUBLIC SECTION.\n    METHODS run.\nENDCLASS.\nCLASS zcl_g IMPLEMENTATION.\n  METHOD run.\n    DATA lv TYPE ci_dcls_chk.\n  ENDMETHOD.\nENDCLASS.";
  const res = lintAbapCloud([{ filename: "zcl_g.clas.abap", source: src }]);
  assert.equal(finding(res, "gf-ground-not-released")?.severity, "error");
});

test("gf-ground-no-api fires (error) on a noAPI SAP ref", () => {
  const src = "CLASS zcl_g DEFINITION PUBLIC FINAL CREATE PUBLIC.\n  PUBLIC SECTION.\n    METHODS run.\nENDCLASS.\nCLASS zcl_g IMPLEMENTATION.\n  METHOD run.\n    DATA lo TYPE REF TO cf_rebd_building.\n  ENDMETHOD.\nENDCLASS.";
  const res = lintAbapCloud([{ filename: "zcl_g.clas.abap", source: src }]);
  assert.equal(finding(res, "gf-ground-no-api")?.severity, "error");
});

test("gf-ground-classic-api fires (info) on a classicAPI SAP ref", () => {
  const src = "CLASS zcl_g DEFINITION PUBLIC FINAL CREATE PUBLIC.\n  PUBLIC SECTION.\n    METHODS run.\nENDCLASS.\nCLASS zcl_g IMPLEMENTATION.\n  METHOD run.\n    DATA lo TYPE REF TO clg_bsp_call.\n  ENDMETHOD.\nENDCLASS.";
  const res = lintAbapCloud([{ filename: "zcl_g.clas.abap", source: src }]);
  assert.equal(finding(res, "gf-ground-classic-api")?.severity, "info");
});

// ---------------------------------------------------------------- Batch 2: obsolete syntax

/** wrap method-body statements in a minimal valid ABAP-Cloud class */
function clazz(body) {
  return `CLASS zcl_x DEFINITION PUBLIC FINAL CREATE PUBLIC.\n  PUBLIC SECTION.\n    METHODS run.\nENDCLASS.\nCLASS zcl_x IMPLEMENTATION.\n  METHOD run.\n${body}\n  ENDMETHOD.\nENDCLASS.`;
}

test("gf-clean-no-create-object fires on CREATE OBJECT (CLEAN-001)", () => {
  const res = lintAbapCloud([{ filename: "zcl_x.clas.abap", source: clazz("    DATA lo TYPE REF TO object.\n    CREATE OBJECT lo.") }]);
  assert.equal(finding(res, "gf-clean-no-create-object")?.severity, "error");
});

test("gf-clean-no-concatenate fires on CONCATENATE (CLEAN-004)", () => {
  const res = lintAbapCloud([{ filename: "zcl_x.clas.abap", source: clazz("    DATA lv TYPE string.\n    CONCATENATE 'a' 'b' INTO lv.") }]);
  assert.equal(finding(res, "gf-clean-no-concatenate")?.severity, "error");
});

test("gf-clean-no-move-to fires on MOVE … TO (CLEAN-007)", () => {
  const res = lintAbapCloud([{ filename: "zcl_x.clas.abap", source: clazz("    DATA lv TYPE string.\n    DATA lv2 TYPE string.\n    MOVE lv TO lv2.") }]);
  assert.equal(finding(res, "gf-clean-no-move-to")?.severity, "error");
});

test("gf-clean-no-call-method fires on CALL METHOD (CLEAN-008)", () => {
  const res = lintAbapCloud([{ filename: "zcl_x.clas.abap", source: clazz("    DATA lo TYPE REF TO zcl_x.\n    CALL METHOD lo->run( ).") }]);
  assert.equal(finding(res, "gf-clean-no-call-method")?.severity, "error");
});

test("gf-clean-no-form fires on a FORM subroutine (CLEAN-010)", () => {
  const res = lintAbapCloud([{ filename: "zr_x.prog.abap", source: "REPORT zr_x.\nFORM foo.\nENDFORM." }]);
  assert.equal(finding(res, "gf-clean-no-form")?.severity, "error");
});

test("modern ABAP (NEW, string template, =, direct call) raises no Batch-2 finding — guards hold", () => {
  const body = "    DATA lo TYPE REF TO zcl_x.\n    DATA lv TYPE string.\n    DATA lv2 TYPE string.\n    lo = NEW #( ).\n    lv = |{ lv2 }|.\n    lv2 = lv.\n    lo->run( ).";
  const res = lintAbapCloud([{ filename: "zcl_x.clas.abap", source: clazz(body) }]);
  const batch2 = ["gf-clean-no-create-object", "gf-clean-no-concatenate", "gf-clean-no-move-to", "gf-clean-no-call-method", "gf-clean-no-form"];
  assert.deepEqual(ruleIds(res).filter((r) => batch2.includes(r)), [], "plain '=' (kind Move) and direct call (kind Call) must not over-fire");
});

// ---------------------------------------------------------------- Batch 1: restricted-ABAP + Clean-Core hard blockers

test("gf-cloud-no-describe-lines fires on DESCRIBE TABLE … LINES (CLOUD-008)", () => {
  const res = lintAbapCloud([{ filename: "zcl_x.clas.abap", source: clazz("    DATA lt TYPE STANDARD TABLE OF string.\n    DATA lv TYPE i.\n    DESCRIBE TABLE lt LINES lv.") }]);
  assert.equal(finding(res, "gf-cloud-no-describe-lines")?.severity, "error");
});

test("gf-cloud-no-get-reference fires on GET REFERENCE OF (CLOUD-009)", () => {
  const res = lintAbapCloud([{ filename: "zcl_x.clas.abap", source: clazz("    DATA lv TYPE i.\n    DATA lo TYPE REF TO data.\n    GET REFERENCE OF lv INTO lo.") }]);
  assert.equal(finding(res, "gf-cloud-no-get-reference")?.severity, "error");
});

test("gf-cloud-no-read-report fires on READ REPORT (CLOUD-010)", () => {
  const res = lintAbapCloud([{ filename: "zr_x.prog.abap", source: "REPORT zr_x.\nDATA lt TYPE STANDARD TABLE OF string.\nSTART-OF-SELECTION.\n  READ REPORT 'ZR_Y' INTO lt." }]);
  assert.equal(finding(res, "gf-cloud-no-read-report")?.severity, "error");
});

test("gf-cloud-no-break-point fires on BREAK-POINT (CLOUD-011)", () => {
  const res = lintAbapCloud([{ filename: "zcl_x.clas.abap", source: clazz("    BREAK-POINT.") }]);
  assert.equal(finding(res, "gf-cloud-no-break-point")?.severity, "error");
});

test("gf-cloud-no-using-client fires on USING CLIENT (CLOUD-013)", () => {
  const res = lintAbapCloud([{ filename: "zr_x.prog.abap", source: "REPORT zr_x.\nSTART-OF-SELECTION.\n  DELETE FROM t000 USING CLIENT '100' WHERE mandt = '100'." }]);
  assert.equal(finding(res, "gf-cloud-no-using-client")?.severity, "error");
});

test("gf-cloud-no-classic-alv fires on CL_SALV_TABLE=>FACTORY (CLOUD-015)", () => {
  const res = lintAbapCloud([{ filename: "zcl_x.clas.abap", source: clazz("    cl_salv_table=>factory( ).") }]);
  assert.equal(finding(res, "gf-cloud-no-classic-alv")?.severity, "error");
});

test("gf-cloud-no-enhancement-point fires on ENHANCEMENT-POINT and -SECTION (CLOUD-019)", () => {
  const p = lintAbapCloud([{ filename: "zr_p.prog.abap", source: "REPORT zr_p.\nENHANCEMENT-POINT zx SPOTS zz." }]);
  assert.equal(finding(p, "gf-cloud-no-enhancement-point")?.severity, "error");
  const s = lintAbapCloud([{ filename: "zr_s.prog.abap", source: "REPORT zr_s.\nENHANCEMENT-SECTION zs SPOTS zz.\nEND-ENHANCEMENT-SECTION." }]);
  assert.ok(finding(s, "gf-cloud-no-enhancement-point"), "ENHANCEMENT-SECTION also flagged by the same rule");
});

test("gf-cloud-no-mod-marker fires on a SAP modification marker (CLOUD-020)", () => {
  const res = lintAbapCloud([{ filename: "zr_x.prog.abap", source: "REPORT zr_x.\n*$*$-Start: (1)---------------\nSTART-OF-SELECTION." }]);
  assert.equal(finding(res, "gf-cloud-no-mod-marker")?.severity, "error");
});

test("gf-cloud-no-perform-sap fires on PERFORM … IN PROGRAM (CLOUD-022)", () => {
  const res = lintAbapCloud([{ filename: "zcl_x.clas.abap", source: clazz("    PERFORM foo IN PROGRAM saplzx.") }]);
  assert.equal(finding(res, "gf-cloud-no-perform-sap")?.severity, "error");
});

test("gf-cloud-no-internal-badi fires on INTERFACES IF_EX_*INTERNAL* (CLOUD-026)", () => {
  const src = "CLASS zcl_b DEFINITION PUBLIC.\n  PUBLIC SECTION.\n    INTERFACES if_ex_sap_internal_badi.\nENDCLASS.\nCLASS zcl_b IMPLEMENTATION.\nENDCLASS.";
  const res = lintAbapCloud([{ filename: "zcl_b.clas.abap", source: src }]);
  assert.equal(finding(res, "gf-cloud-no-internal-badi")?.severity, "error");
});

test("gf-cloud-no-leave fires on LEAVE PROGRAM (classic program flow)", () => {
  const res = lintAbapCloud([{ filename: "zr_x.prog.abap", source: "REPORT zr_x.\nSTART-OF-SELECTION.\n  LEAVE PROGRAM." }]);
  assert.equal(finding(res, "gf-cloud-no-leave")?.severity, "error");
});

test("Batch-1 guards hold: local PERFORM, normal INTERFACES, lines( ) raise nothing", () => {
  const body = "    DATA lt TYPE STANDARD TABLE OF string.\n    DATA lv TYPE i.\n    lv = lines( lt ).\n    PERFORM foo.";
  const res = lintAbapCloud([{ filename: "zcl_x.clas.abap", source: clazz(body) }]);
  assert.equal(finding(res, "gf-cloud-no-perform-sap"), undefined, "local PERFORM (no IN PROGRAM) must not fire");
  assert.equal(finding(res, "gf-cloud-no-describe-lines"), undefined, "lines( ) is not DESCRIBE");
  const norm = "CLASS zcl_n DEFINITION PUBLIC FINAL CREATE PUBLIC.\n  PUBLIC SECTION.\n    INTERFACES if_my_normal.\nENDCLASS.\nCLASS zcl_n IMPLEMENTATION.\nENDCLASS.";
  assert.equal(finding(lintAbapCloud([{ filename: "zcl_n.clas.abap", source: norm }]), "gf-cloud-no-internal-badi"), undefined, "a normal INTERFACES must not fire internal-badi");
});

// ---------------------------------------------------------------- Batch 3: cloud-runtime + Clean-Core warnings

test("gf-cloud-message-type fires on MESSAGE … TYPE (CLOUD-004)", () => {
  const res = lintAbapCloud([{ filename: "zcl_x.clas.abap", source: clazz("    MESSAGE 'hi' TYPE 'E'.") }]);
  assert.equal(finding(res, "gf-cloud-message-type")?.severity, "warning");
});

test("gf-cloud-class-not-final fires on a non-FINAL/ABSTRACT class (CLOUD-005), FINAL is clean", () => {
  const nf = "CLASS zcl_a DEFINITION PUBLIC.\n  PUBLIC SECTION.\nENDCLASS.\nCLASS zcl_a IMPLEMENTATION.\nENDCLASS.";
  assert.equal(finding(lintAbapCloud([{ filename: "zcl_a.clas.abap", source: nf }]), "gf-cloud-class-not-final")?.severity, "warning");
  assert.equal(finding(lintAbapCloud([{ filename: "zcl_x.clas.abap", source: clazz("") }]), "gf-cloud-class-not-final"), undefined, "a FINAL class is clean");
});

test("gf-cloud-fs-type-any fires on FIELD-SYMBOLS TYPE ANY but not TYPE ANY TABLE (CLOUD-007)", () => {
  assert.equal(finding(lintAbapCloud([{ filename: "zcl_x.clas.abap", source: clazz("    FIELD-SYMBOLS <fs> TYPE any.") }]), "gf-cloud-fs-type-any")?.severity, "warning");
  assert.equal(finding(lintAbapCloud([{ filename: "zcl_x.clas.abap", source: clazz("    FIELD-SYMBOLS <ft> TYPE ANY TABLE.") }]), "gf-cloud-fs-type-any"), undefined);
});

test("gf-cloud-no-compute fires on COMPUTE (CLOUD-017)", () => {
  const res = lintAbapCloud([{ filename: "zcl_x.clas.abap", source: clazz("    DATA lv TYPE i.\n    COMPUTE lv = 1 + 2.") }]);
  assert.equal(finding(res, "gf-cloud-no-compute")?.severity, "warning");
});

test("gf-cloud-sy-time-direct fires on a direct SY-UZEIT read (CLOUD-016)", () => {
  const res = lintAbapCloud([{ filename: "zcl_x.clas.abap", source: clazz("    DATA lv TYPE t.\n    lv = sy-uzeit.") }]);
  assert.equal(finding(res, "gf-cloud-sy-time-direct")?.severity, "warning");
});

test("gf-cloud-no-user-exit fires on FORM USEREXIT_ (CLOUD-027)", () => {
  const res = lintAbapCloud([{ filename: "zr_x.prog.abap", source: "REPORT zr_x.\nFORM userexit_save.\nENDFORM." }]);
  assert.equal(finding(res, "gf-cloud-no-user-exit")?.severity, "warning");
});

test("gf-cloud-legacy-ui fires on a Web Dynpro reference (CLOUD-028)", () => {
  const res = lintAbapCloud([{ filename: "zcl_x.clas.abap", source: clazz("    DATA lo TYPE REF TO if_wd_component.") }]);
  assert.equal(finding(res, "gf-cloud-legacy-ui")?.severity, "warning");
});

test("gf-cloud-ci-include fires on INCLUDE STRUCTURE CI_ (CLOUD-029)", () => {
  const res = lintAbapCloud([{ filename: "zr_x.prog.abap", source: "REPORT zr_x.\nSTART-OF-SELECTION.\n  INCLUDE STRUCTURE ci_cobl." }]);
  assert.equal(finding(res, "gf-cloud-ci-include")?.severity, "warning");
});

test("gf-cloud-segw-bopf fires on a /IWBEP/ reference (CLOUD-030)", () => {
  const res = lintAbapCloud([{ filename: "zcl_x.clas.abap", source: clazz("    DATA lo TYPE REF TO /iwbep/cl_mgw_abs_data.") }]);
  assert.equal(finding(res, "gf-cloud-segw-bopf")?.severity, "warning");
});

// ---------------------------------------------------------------- Batch 4: Clean-ABAP style

test("gf-clean-hungarian fires on a Hungarian-prefixed DATA name, not a content name (CLEAN-002)", () => {
  assert.equal(finding(lintAbapCloud([{ filename: "zcl_x.clas.abap", source: clazz("    DATA lt_foo TYPE i.") }]), "gf-clean-hungarian")?.severity, "warning");
  assert.equal(finding(lintAbapCloud([{ filename: "zcl_x.clas.abap", source: clazz("    DATA orders TYPE i.") }]), "gf-clean-hungarian"), undefined);
});

test("gf-clean-standalone-data fires on standalone typed DATA, not on inline DATA( ) (CLEAN-003)", () => {
  assert.equal(finding(lintAbapCloud([{ filename: "zcl_x.clas.abap", source: clazz("    DATA orders TYPE i.") }]), "gf-clean-standalone-data")?.severity, "warning");
  assert.equal(finding(lintAbapCloud([{ filename: "zcl_x.clas.abap", source: clazz("    DATA(orders) = 1.") }]), "gf-clean-standalone-data"), undefined);
});

test("gf-clean-bool-literal fires on an 'X' boolean literal (CLEAN-005)", () => {
  const res = lintAbapCloud([{ filename: "zcl_x.clas.abap", source: clazz("    DATA flag TYPE abap_bool.\n    flag = 'X'.") }]);
  assert.equal(finding(res, "gf-clean-bool-literal")?.severity, "warning");
});

test("gf-clean-raise-exc-type fires on RAISE EXCEPTION TYPE, not on RAISE EXCEPTION NEW (CLEAN-006)", () => {
  assert.equal(finding(lintAbapCloud([{ filename: "zcl_x.clas.abap", source: clazz("    RAISE EXCEPTION TYPE cx_sy_zerodivide.") }]), "gf-clean-raise-exc-type")?.severity, "warning");
  assert.equal(finding(lintAbapCloud([{ filename: "zcl_x.clas.abap", source: clazz("    RAISE EXCEPTION NEW cx_sy_zerodivide( ).") }]), "gf-clean-raise-exc-type"), undefined);
});

test("gf-clean-redundant-exporting fires on ( EXPORTING … ) in a call (CLEAN-009)", () => {
  const res = lintAbapCloud([{ filename: "zcl_x.clas.abap", source: clazz("    DATA lo TYPE REF TO zcl_x.\n    lo->run( EXPORTING iv = 1 ).") }]);
  assert.equal(finding(res, "gf-clean-redundant-exporting")?.severity, "warning");
});

// ---------------------------------------------------------------- Batch 5: complexity + test-quality

/** class with a single `run` method (signature + body configurable) */
function methodClass(body, sig = "METHODS run.") {
  return `CLASS zcl_x DEFINITION PUBLIC FINAL CREATE PUBLIC.\n  PUBLIC SECTION.\n    ${sig}\nENDCLASS.\nCLASS zcl_x IMPLEMENTATION.\n  METHOD run.\n${body}\n  ENDMETHOD.\nENDCLASS.`;
}
/** a CLAS main + its testclasses include, as the two files of one object */
function classWithTest(mainBody, testBody, pubSig = "METHODS run.") {
  return [
    { filename: "zcl_calc.clas.abap", source: `CLASS zcl_calc DEFINITION PUBLIC FINAL CREATE PUBLIC.\n  PUBLIC SECTION.\n    ${pubSig}\nENDCLASS.\nCLASS zcl_calc IMPLEMENTATION.\n${mainBody}\nENDCLASS.` },
    { filename: "zcl_calc.clas.testclasses.abap", source: `CLASS ltc_calc DEFINITION FOR TESTING RISK LEVEL HARMLESS DURATION SHORT FINAL.\n  PRIVATE SECTION.\n    METHODS t1 FOR TESTING.\nENDCLASS.\nCLASS ltc_calc IMPLEMENTATION.\n  METHOD t1.\n${testBody}\n  ENDMETHOD.\nENDCLASS.` },
  ];
}

test("gf-cx-method-length fires on a >40-statement method (CLEAN-011)", () => {
  const res = lintAbapCloud([{ filename: "zcl_x.clas.abap", source: methodClass(Array(41).fill("    rv = 1.").join("\n"), "METHODS run RETURNING VALUE(rv) TYPE i.") }]);
  assert.equal(finding(res, "gf-cx-method-length")?.severity, "warning");
});

test("gf-cx-param-count fires on a method with >3 IMPORTING params (CLEAN-012)", () => {
  const res = lintAbapCloud([{ filename: "zcl_x.clas.abap", source: methodClass("    rv = ia.", "METHODS run IMPORTING ia TYPE i ib TYPE i ic TYPE i id TYPE i RETURNING VALUE(rv) TYPE i.") }]);
  assert.equal(finding(res, "gf-cx-param-count")?.severity, "warning");
});

test("gf-cx-cyclomatic fires on a method with >10 decision points (CLEAN-013)", () => {
  const res = lintAbapCloud([{ filename: "zcl_x.clas.abap", source: methodClass(Array(11).fill("    IF rv > 0.\n    ENDIF.").join("\n"), "METHODS run RETURNING VALUE(rv) TYPE i.") }]);
  assert.equal(finding(res, "gf-cx-cyclomatic")?.severity, "warning");
});

test("gf-cx-nesting-depth fires on >4 nested blocks (CLEAN-014)", () => {
  const body = Array(5).fill("    IF rv > 0.").join("\n") + "\n    rv = 1.\n" + Array(5).fill("    ENDIF.").join("\n");
  const res = lintAbapCloud([{ filename: "zcl_x.clas.abap", source: methodClass(body, "METHODS run RETURNING VALUE(rv) TYPE i.") }]);
  assert.equal(finding(res, "gf-cx-nesting-depth")?.severity, "warning");
});

test("a small, flat method raises no complexity finding", () => {
  const res = lintAbapCloud([{ filename: "zcl_x.clas.abap", source: methodClass("    rv = 1.", "METHODS run RETURNING VALUE(rv) TYPE i.") }]);
  for (const r of ["gf-cx-method-length", "gf-cx-param-count", "gf-cx-cyclomatic", "gf-cx-nesting-depth"]) assert.equal(finding(res, r), undefined);
});

test("gf-test-assert-count fires on a test method with >3 assertions (CLEAN-018)", () => {
  const asserts = Array(4).fill("    cl_abap_unit_assert=>assert_equals( act = 1 exp = 1 ).").join("\n");
  const res = lintAbapCloud(classWithTest("  METHOD run.\n    rv = 1.\n  ENDMETHOD.", asserts, "METHODS run RETURNING VALUE(rv) TYPE i."));
  assert.equal(finding(res, "gf-test-assert-count")?.severity, "warning");
});

test("gf-test-too-many-calls fires on a test with >3 production calls (CLEAN-017)", () => {
  const body = "    DATA(lo) = NEW zcl_calc( ).\n    lo->run( ).\n    lo->run( ).\n    lo->run( ).\n    lo->run( ).";
  const res = lintAbapCloud(classWithTest("  METHOD run.\n    rv = 1.\n  ENDMETHOD.", body, "METHODS run RETURNING VALUE(rv) TYPE i."));
  assert.equal(finding(res, "gf-test-too-many-calls")?.severity, "warning");
});

test("gf-test-instantiates-prod fires when a test does NEW zcl_… (CLEAN-016)", () => {
  const body = "    cl_abap_unit_assert=>assert_equals( act = NEW zcl_calc( )->run( ) exp = 1 ).";
  const res = lintAbapCloud(classWithTest("  METHOD run.\n    rv = 1.\n  ENDMETHOD.", body, "METHODS run RETURNING VALUE(rv) TYPE i."));
  assert.equal(finding(res, "gf-test-instantiates-prod")?.severity, "warning");
});

test("gf-test-public-untested flags a public method the test never references (CLEAN-019)", () => {
  const main = "  METHOD add.\n    rv = 1.\n  ENDMETHOD.\n  METHOD subtract.\n    rv = 1.\n  ENDMETHOD.";
  const test = "    cl_abap_unit_assert=>assert_equals( act = NEW zcl_calc( )->add( ) exp = 1 ).";
  const res = lintAbapCloud(classWithTest(main, test, "METHODS add RETURNING VALUE(rv) TYPE i.\n    METHODS subtract RETURNING VALUE(rv) TYPE i."));
  const f = finding(res, "gf-test-public-untested");
  assert.equal(f?.severity, "warning");
  assert.match(f.message, /SUBTRACT/);
});

test("gf-test-friends-reach fires on LOCAL FRIENDS (CLEAN-020)", () => {
  const src = "CLASS zcl_x DEFINITION PUBLIC FINAL CREATE PUBLIC.\n  PUBLIC SECTION.\n    METHODS run.\nENDCLASS.\nCLASS zcl_x DEFINITION LOCAL FRIENDS ltc_x.\nCLASS zcl_x IMPLEMENTATION.\n  METHOD run.\n  ENDMETHOD.\nENDCLASS.";
  assert.equal(finding(lintAbapCloud([{ filename: "zcl_x.clas.abap", source: src }]), "gf-test-friends-reach")?.severity, "warning");
});

// ---------------------------------------------------------------- result shape + counts

test("lintAbapCloud tallies errorCount and warningCount from the findings", () => {
  const src = "REPORT zr_x.\nSTART-OF-SELECTION.\n  WRITE 'x'.\n  CALL FUNCTION 'Z_FM'.";
  const res = lintAbapCloud([{ filename: "zr_x.prog.abap", source: src }]);
  assert.equal(res.errorCount, res.findings.filter((f) => f.severity === "error").length);
  assert.equal(res.warningCount, res.findings.filter((f) => f.severity === "warning").length);
  assert.ok(res.errorCount >= 1 && res.warningCount >= 1);
});

test("every finding carries the mandatory shape", () => {
  const res = lintAbapCloud([{ filename: "zr_x.prog.abap", source: "REPORT zr_x.\nSTART-OF-SELECTION.\n  WRITE 'x'." }]);
  for (const f of res.findings) {
    for (const k of ["rule_id", "severity", "object", "file", "line", "message", "family"]) {
      assert.ok(k in f, `finding missing ${k}`);
    }
    assert.ok(Number.isInteger(f.line) && f.line >= 1);
  }
});

// ---------------------------------------------------------------- P8 robustness

test("a malformed generated object degrades without crashing the lint gate (P8)", () => {
  const badTabl = {
    filename: "zt_bad.tabl.xml",
    source: `<?xml version="1.0"?><abapGit><asx:abap><asx:values><DD02V><TABNAME>ZT_BAD</TABNAME></DD02V></asx:values></asx:abap></abapGit>`,
  };
  const good = { filename: "zr_ok.prog.abap", source: "REPORT zr_ok.\nSTART-OF-SELECTION.\n  WRITE 'x'." };
  let res;
  assert.doesNotThrow(() => {
    res = lintAbapCloud([badTabl, good]);
  });
  assert.ok(finding(res, "gf-cloud-no-write"), "healthy object still linted after a malformed sibling");
});

// ---------------------------------------------------------------- repair formatting

test("formatViolationsForRepair separates blocking errors from warnings", () => {
  const src = "REPORT zr_x.\nSTART-OF-SELECTION.\n  WRITE 'x'.\n  CALL FUNCTION 'Z_FM'.";
  const res = lintAbapCloud([{ filename: "zr_x.prog.abap", source: src }]);
  const text = formatViolationsForRepair(res.findings);
  assert.match(text, /gf-cloud-no-write/);
  assert.match(text, /ERROR/i);
  assert.match(text, /gf-cloud-call-function/);
});

test("formatViolationsForRepair on no findings states the source is clean", () => {
  assert.match(formatViolationsForRepair([]), /no .*violation/i);
});
