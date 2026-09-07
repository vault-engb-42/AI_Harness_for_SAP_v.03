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
  assert.equal(detectInjectionSinks("EXEC SQL.").length, 1); // native SQL bypasses Open SQL binding (C4/P8)
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

// P4 is stated as "hard-fail, agent-proof" and is enforced HERE. Every check in this file counted
// occurrences in the RAW text, so an ABAP COMMENT naming an invariant was indistinguishable from the
// invariant itself. That cuts both ways, and the dangerous direction is fail-OPEN: delete a real
// AUTHORITY-CHECK, write `" AUTHORITY-CHECK moved to the caller` where it stood, and the counts balance —
// the removal is not reported. That is not an adversarial input; it is the single most natural way an agent
// removes a check, because explaining the removal in a comment is what a careful author does.
test("P4: an ABAP comment naming an invariant can NEVER stand in for the invariant", () => {
  const withAuth = "METHOD read.\n  AUTHORITY-CHECK OBJECT 'S_CARRID' ID 'ACTVT' FIELD '03'.\n  IF sy-subrc <> 0.\n    RAISE EXCEPTION TYPE cx_auth.\n  ENDIF.\n  SELECT * FROM sflight INTO TABLE rt.\nENDMETHOD.";

  const maskedByLineComment = "METHOD read.\n  \" AUTHORITY-CHECK was moved to the caller\n  SELECT * FROM sflight INTO TABLE rt.\n  IF sy-subrc <> 0.\n    CLEAR rt.\n  ENDIF.\nENDMETHOD.";
  assert.ok(
    detectInvariantWeakening(withAuth, maskedByLineComment).some((f) => f.type === "authority-check-removed"),
    "a trailing-quote comment must not mask the removal",
  );

  const maskedByStarComment = "METHOD read.\n* AUTHORITY-CHECK OBJECT 'S_CARRID' ID 'ACTVT' FIELD '03'.\n  SELECT * FROM sflight INTO TABLE rt.\nENDMETHOD.";
  assert.ok(
    detectInvariantWeakening(withAuth, maskedByStarComment).some((f) => f.type === "authority-check-removed"),
    "commenting the check OUT is removing it — a full-line * comment must not mask it either",
  );

  // Same hole, same shape, on the other two classic invariants.
  const withCommit = "MODIFY ztab FROM ls.\nCOMMIT WORK.";
  assert.ok(
    detectInvariantWeakening(withCommit, "MODIFY ztab FROM ls.\n\" COMMIT WORK is done by the caller now").some((f) => f.type === "commit-work-suppressed"),
    "a comment must not stand in for the save",
  );
  const withEntities = "MODIFY ENTITIES OF zi_x ENTITY e UPDATE FIELDS ( f ) WITH lt.\nCOMMIT ENTITIES RESPONSE OF zi_x FAILED DATA(cf).";
  assert.ok(
    detectInvariantWeakening(withEntities, "MODIFY ENTITIES OF zi_x ENTITY e UPDATE FIELDS ( f ) WITH lt.\n* COMMIT ENTITIES happens in the caller").some((f) => f.type === "commit-entities-suppressed"),
    "a comment must not stand in for the RAP save",
  );

  // And the fail-open converse: a comment must not SATISFY the sy-subrc requirement either.
  const subrcOnlyInComment = "AUTHORITY-CHECK OBJECT 'Z' ID 'ACTVT' FIELD '03'.\n\" sy-subrc is checked by the wrapper\nMODIFY ztab FROM ls.";
  assert.ok(
    detectInvariantWeakening("", subrcOnlyInComment).some((f) => f.type === "sy-subrc-unchecked"),
    "the guard must read code, not the promise of code",
  );
});

test("P4: stripping comments does not corrupt string literals that contain quotes or asterisks", () => {
  // The fix must not treat a `"` inside a '...' literal as a comment start, or a `*` inside a literal
  // as a full-line comment — doing so would DELETE real code from the scanned text and silently stop
  // the guard seeing an invariant that is genuinely there. Fail-open by over-stripping is the same
  // defect wearing different clothes.
  const src = "AUTHORITY-CHECK OBJECT 'S_X' ID 'MSG' FIELD 'say \"hi\" now'.\nIF sy-subrc <> 0. RAISE. ENDIF.";
  assert.equal(detectInvariantWeakening(src, src).length, 0, "unchanged source is never a regression");
  assert.ok(
    detectInvariantWeakening(src, "WRITE 'gone'.").some((f) => f.type === "authority-check-removed"),
    "the check inside a quote-bearing line is still SEEN, so its removal is still caught",
  );
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

// C2 / P4(a): RAP declares its authorization gate in the BDEF (`authorization master ( … )` +
// GET_GLOBAL_/GET_INSTANCE_AUTHORIZATIONS handlers) and in CDS DCL (GRANT SELECT … WHERE …).
// CLAUDE.md P4(a) names those co-equal with classic AUTHORITY-CHECK, but the gate could only
// count AUTHORITY-CHECK — so deleting the primary ABAP-Cloud authorization boundary passed.
// Enforcement rested solely on the reviewer agent's judgment; these make it mechanical.

test("detectInvariantWeakening catches a REMOVED RAP authorization master clause — P4(a), C2", () => {
  const withAuth = "define behavior for ZI_Sales alias Sales\nimplementation in class zbp_i_sales unique\npersistent table zt_sales\nauthorization master ( global )\n{ update; delete; }";
  const noAuth = "define behavior for ZI_Sales alias Sales\nimplementation in class zbp_i_sales unique\npersistent table zt_sales\n{ update; delete; }";
  assert.ok(
    detectInvariantWeakening(withAuth, noAuth).some((f) => f.type === "rap-auth-master-weakened"),
    "deleting the BDEF authorization clause is an invariant regression",
  );
  assert.equal(detectInvariantWeakening(withAuth, withAuth).length, 0, "an unchanged BDEF is clean");
});

test("detectInvariantWeakening catches a NARROWED RAP authorization scope — P4(a), C2", () => {
  // ( global, instance ) -> ( global ) keeps the clause but drops instance-level authorization.
  const broad = "define behavior for ZI_Sales alias Sales\nauthorization master ( global, instance )\n{ update; }";
  const narrowed = "define behavior for ZI_Sales alias Sales\nauthorization master ( global )\n{ update; }";
  const findings = detectInvariantWeakening(broad, narrowed);
  assert.ok(
    findings.some((f) => f.type === "rap-auth-master-weakened"),
    `narrowing the declared auth scope must be flagged, got ${JSON.stringify(findings)}`,
  );
  assert.equal(detectInvariantWeakening(narrowed, broad).length, 0, "WIDENING the scope is not a regression");
});

test("detectInvariantWeakening catches an ORPHANED auth scope — declared, handler gone — P4(a), C2", () => {
  // The clause survives, so rap-auth-master-weakened stays silent; the handler that enforces it is
  // gone, which leaves the declared gate unimplemented.
  const withHandler = "authorization master ( global )\nMETHODS get_global_authorizations FOR AUTHORIZATION IMPORTING keys REQUEST requested_authorizations FOR Sales RESULT result.";
  const noHandler = "authorization master ( global )\nMETHODS lock FOR LOCK IMPORTING keys FOR Sales.";
  const findings = detectInvariantWeakening(withHandler, noHandler);
  assert.ok(
    findings.some((f) => f.type === "rap-auth-handler-missing"),
    `a declared auth scope with no GET_*_AUTHORIZATIONS handler must be flagged, got ${JSON.stringify(findings)}`,
  );
  assert.equal(detectInvariantWeakening(withHandler, withHandler).length, 0, "an unchanged handler is clean");
});

test("detectInvariantWeakening catches a DROPPED DCL grant — P4(a), C2", () => {
  const withGrant = "@EndUserText.label: 'Sales'\nDEFINE ROLE zi_sales_role {\n  GRANT SELECT ON zi_sales WHERE ( salesorg ) = aspect pfcg_auth( 'Z_SALES', 'SALESORG', actvt = '03' );\n}";
  const noGrant = "@EndUserText.label: 'Sales'\nDEFINE ROLE zi_sales_role {\n}";
  assert.ok(
    detectInvariantWeakening(withGrant, noGrant).some((f) => f.type === "dcl-grant-dropped"),
    "dropping a DCL GRANT removes row-level authorization",
  );
  assert.equal(detectInvariantWeakening(withGrant, withGrant).length, 0, "an unchanged DCL role is clean");
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
  // The abapGit export form. A file this predicate rejects is never scanned at all, so the P4(a)
  // BDEF/DCL checks silently could not fire on an abapGit-layout package.
  assert.equal(isAbapSource("src/zbp_i_sales.bdef.asbdef"), true);
  assert.equal(isAbapSource("src/zi_sales_role.dcls.asdcls"), true);
  assert.equal(isAbapSource("src/zi_sales.ddls.asddls"), true);
  assert.equal(isAbapSource("README.md"), false);
});

test("buildLaneInPrompt matches heavy lanes, not vibe/disposable", () => {
  assert.equal(buildLaneInPrompt("/abap-build new package"), "abap-build");
  assert.equal(buildLaneInPrompt("please run /abap-implement C"), "abap-implement");
  assert.equal(buildLaneInPrompt("/abap-vibe fix typo"), null);
  assert.equal(buildLaneInPrompt("just a question"), null);
});
