// Unit tests for the pure ABAP-safety check library used by the hooks.
// Pure functions only — no I/O, no process — so real unit tests are correct here.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scanSecrets,
  detectInjectionSinks,
  detectInvariantWeakening,
  inCustomerNamespace,
  isAbapSource,
  buildLaneInPrompt,
} from "../lib/abap-checks.js";

test("scanSecrets flags vendor tokens, keys, and hardcoded passwords", () => {
  assert.equal(scanSecrets("token = ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345").length, 1);
  assert.equal(scanSecrets("id AKIAIOSFODNN7EXAMPLE here").length, 1);
  assert.ok(scanSecrets("DATA(pw) = password = 'hunter2secret'.").length >= 1);
  assert.ok(scanSecrets("-----BEGIN RSA PRIVATE KEY-----").length >= 1);
  assert.equal(scanSecrets("WRITE 'hello world'.").length, 0);
});

test("detectInjectionSinks flags codegen/OS/dynamic sinks, not static SQL", () => {
  assert.equal(detectInjectionSinks("GENERATE SUBROUTINE POOL lt_src NAME lv_n.").length, 1);
  assert.equal(detectInjectionSinks("CALL 'SYSTEM' ID 'COMMAND' FIELD lv_cmd.").length, 1);
  assert.equal(detectInjectionSinks("SUBMIT (lv_prog) VIA SELECTION-SCREEN.").length, 1);
  assert.equal(detectInjectionSinks("SELECT * FROM (lv_tabname) INTO TABLE lt.").length, 1);
  assert.equal(detectInjectionSinks("SELECT * FROM mara INTO TABLE @lt WHERE matnr = @iv.").length, 0);
  assert.equal(detectInjectionSinks("SUBMIT zmy_report AND RETURN.").length, 0);
});

test("detectInvariantWeakening catches AUTHORITY-CHECK / COMMIT WORK / SY-SUBRC regressions", () => {
  const withAuth = "AUTHORITY-CHECK OBJECT 'Z' ID 'ACTVT' FIELD '03'.\nIF sy-subrc <> 0.\nRAISE.\nENDIF.\nCOMMIT WORK.";
  const noAuth = "COMMIT WORK.";
  assert.ok(detectInvariantWeakening(withAuth, noAuth).some((f) => f.type === "authority-check-removed"));
  const noCommit = "AUTHORITY-CHECK OBJECT 'Z' ID 'ACTVT' FIELD '03'.\nIF sy-subrc <> 0. RAISE. ENDIF.";
  assert.ok(detectInvariantWeakening(withAuth, noCommit).some((f) => f.type === "commit-work-suppressed"));
  const authNoSubrc = "AUTHORITY-CHECK OBJECT 'Z' ID 'ACTVT' FIELD '03'.\nMODIFY ztab FROM ls.";
  assert.ok(detectInvariantWeakening("", authNoSubrc).some((f) => f.type === "sy-subrc-unchecked"));
  assert.equal(detectInvariantWeakening(withAuth, withAuth).length, 0);
});

test("detectInvariantWeakening catches COMMIT ENTITIES (the RAP save) suppression — P4(b), C1", () => {
  // In ABAP Cloud / RAP the save is COMMIT ENTITIES, not COMMIT WORK (which is a runtime error in a
  // behaviour pool). Dropping the RAP save from a consumer is the P4(b) invariant regression.
  const withSave = "MODIFY ENTITIES OF zi_x ENTITY e UPDATE FIELDS ( f ) WITH lt FAILED DATA(lf).\nIF lf IS INITIAL.\nCOMMIT ENTITIES RESPONSE OF zi_x FAILED DATA(cf).\nENDIF.";
  const noSave = "MODIFY ENTITIES OF zi_x ENTITY e UPDATE FIELDS ( f ) WITH lt FAILED DATA(lf).";
  assert.ok(
    detectInvariantWeakening(withSave, noSave).some((f) => f.type === "commit-entities-suppressed"),
    "dropping the RAP save (COMMIT ENTITIES) is flagged",
  );
  assert.equal(detectInvariantWeakening(withSave, withSave).length, 0, "an unchanged RAP save is clean");
});

test("inCustomerNamespace accepts Z/Y and /NS/, rejects SAP standard", () => {
  assert.equal(inCustomerNamespace("ZCL_ORDER"), true);
  assert.equal(inCustomerNamespace("YI_Thing"), true);
  assert.equal(inCustomerNamespace("/ACME/CL_X"), true);
  assert.equal(inCustomerNamespace("CL_SALES_ORDER"), false);
  assert.equal(inCustomerNamespace("MARA"), false);
});

test("isAbapSource recognizes ABAP artifact extensions only", () => {
  assert.equal(isAbapSource("specs/abap/zcl_order.clas.abap"), true);
  assert.equal(isAbapSource("specs/abap/zi_sales.ddls"), true);
  assert.equal(isAbapSource("specs/abap/zbp_i_sales.bdef"), true);
  assert.equal(isAbapSource("README.md"), false);
});

test("buildLaneInPrompt matches heavy lanes, not vibe/disposable", () => {
  assert.equal(buildLaneInPrompt("/abap-build new package"), "abap-build");
  assert.equal(buildLaneInPrompt("please run /abap-implement C"), "abap-implement");
  assert.equal(buildLaneInPrompt("/abap-vibe fix typo"), null);
  assert.equal(buildLaneInPrompt("just a question"), null);
});
