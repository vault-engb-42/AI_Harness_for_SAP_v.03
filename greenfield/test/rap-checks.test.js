import { test } from "node:test";
import assert from "node:assert/strict";
import { isBdef, parseBdefHeader, parseBdefOps, bdefSaveConsistencyFindings, bdefHandlerReconciliationFindings } from "../src/rap-checks.js";

// G4 — the BDEF-AST substrate + save-consistency lint. @abaplint/core registers a
// .bdef.asbdef as a BehaviorDefinition but does NOT parse the BDL body, so parseBdefHeader
// text-parses the raw source (greenfield's own — never the analyser). Pure functions +
// real .bdef source, no mocks.

const managed = `managed implementation in class zbp_i_travel unique;\nwith draft;\ndefine behavior for ZI_Travel alias Travel\npersistent table ztravel\n{ create; update; delete; }`;
const additional = `managed with additional save implementation in class zbp_i_travel unique;\ndefine behavior for ZI_Travel alias Travel\n{ create; update; }`;
const unmanagedSave = `managed with unmanaged save implementation in class zbp_i_x unique;\ndefine behavior for ZI_X alias X\n{ create; }`;
const unmanaged = `unmanaged implementation in class zbp_i_y unique;\ndefine behavior for ZI_Y alias Y\n{ create; }`;
const projection = `projection;\ndefine behavior for ZC_Travel alias TravelProj\nuse draft\n{ use create; use update; }`;

// --- isBdef ---
test("isBdef matches .bdef and .bdef.asbdef, not .clas.abap", () => {
  assert.equal(isBdef("zi_travel.bdef.asbdef"), true);
  assert.equal(isBdef("zi_travel.bdef"), true);
  assert.equal(isBdef("zbp_i_travel.clas.abap"), false);
});

// --- parseBdefHeader ---
test("parseBdefHeader reads the impl-type and whether a saver is required", () => {
  assert.deepEqual(
    { ...parseBdefHeader(managed) },
    { implType: "managed", needsSaver: false, implClass: "zbp_i_travel", entity: "ZI_Travel", isProjection: false },
  );
  assert.equal(parseBdefHeader(additional).implType, "managed with additional save");
  assert.equal(parseBdefHeader(additional).needsSaver, true);
  assert.equal(parseBdefHeader(unmanagedSave).needsSaver, true);
  assert.equal(parseBdefHeader(unmanaged).needsSaver, true);
  assert.equal(parseBdefHeader(unmanaged).implType, "unmanaged");
});

test("parseBdefHeader treats a projection behavior as saver-free", () => {
  const h = parseBdefHeader(projection);
  assert.equal(h.isProjection, true);
  assert.equal(h.needsSaver, false);
});

test("parseBdefHeader ignores a `managed` that only appears in a // comment", () => {
  const commented = `unmanaged implementation in class zbp_i_y unique;\n// this used to be managed with additional save\ndefine behavior for ZI_Y alias Y\n{ create; }`;
  assert.equal(parseBdefHeader(commented).implType, "unmanaged");
});

// --- bdefSaveConsistencyFindings (gf-x-bdef-managed-save-consistency) ---
const saverFile = { filename: "zbp_i_travel.clas.locals_imp.abap", source: "CLASS lsc_travel DEFINITION INHERITING FROM cl_abap_behavior_saver.\n  PROTECTED SECTION.\n    METHODS save_modified REDEFINITION.\nENDCLASS.\nCLASS lsc_travel IMPLEMENTATION.\n  METHOD save_modified.\n  ENDMETHOD.\nENDCLASS." };

test("gf-x-bdef-managed-save-consistency fires when additional-save declares no saver", () => {
  const res = bdefSaveConsistencyFindings([{ filename: "zi_travel.bdef.asbdef", source: additional }]);
  assert.equal(res.length, 1);
  assert.equal(res[0].rule_id, "gf-x-bdef-managed-save-consistency");
  assert.equal(res[0].severity, "error");
});

test("gf-x-bdef-managed-save-consistency is clean when the saver class is present", () => {
  const res = bdefSaveConsistencyFindings([{ filename: "zi_travel.bdef.asbdef", source: additional }, saverFile]);
  assert.deepEqual(res, []);
});

test("gf-x-bdef-managed-save-consistency does NOT fire for a plain `managed` BO (no saver needed)", () => {
  assert.deepEqual(bdefSaveConsistencyFindings([{ filename: "zi_travel.bdef.asbdef", source: managed }]), []);
});

test("gf-x-bdef-managed-save-consistency fires for `unmanaged` with no saver", () => {
  const res = bdefSaveConsistencyFindings([{ filename: "zi_y.bdef.asbdef", source: unmanaged }]);
  assert.equal(res.length, 1);
  assert.equal(res[0].rule_id, "gf-x-bdef-managed-save-consistency");
});

test("the saver is scoped to the implementation class — a saver for a DIFFERENT class does not satisfy", () => {
  const otherSaver = { filename: "zbp_i_other.clas.locals_imp.abap", source: saverFile.source };
  const res = bdefSaveConsistencyFindings([{ filename: "zi_travel.bdef.asbdef", source: additional }, otherSaver]);
  assert.equal(res.length, 1, "the travel BDEF's saver must belong to zbp_i_travel, not zbp_i_other");
});

// --- G4b: parseBdefOps + gf-x-bdef-handler-reconciliation ---
// FP traps (backlog-flagged): draft actions + `draft determine action Prepare` need no custom
// handler; one FOR MODIFY method can service several actions via FOR ACTION Entity~act; a
// determination REFERENCED inside Prepare (no `on save`) is not a fresh declaration.

const fullBdef = `managed implementation in class zbp_i_travel unique;
with draft;
define behavior for ZI_Travel alias Travel
persistent table ztravel
lock master
authorization master ( instance )
{
  create; update; delete;
  draft action Resume;
  draft action Edit;
  draft action Activate optimized;
  draft action Discard;
  draft determine action Prepare { validation validateDates; determination setStatus; }
  action ( features : instance ) copyTravel result [1] $self;
  determination setStatus on save { create; }
  validation validateDates on save { field BeginDate; }
}`;

const fullHandler = { filename: "zbp_i_travel.clas.locals_imp.abap", source: `CLASS lhc_travel DEFINITION INHERITING FROM cl_abap_behavior_handler.
  PRIVATE SECTION.
    METHODS setStatus FOR DETERMINE ON SAVE IMPORTING keys FOR Travel~setStatus.
    METHODS validateDates FOR VALIDATE ON SAVE IMPORTING keys FOR Travel~validateDates.
    METHODS copyTravel FOR MODIFY IMPORTING keys FOR ACTION Travel~copyTravel RESULT result.
    METHODS get_instance_authorizations FOR INSTANCE AUTHORIZATION IMPORTING keys REQUEST req FOR Travel RESULT result.
ENDCLASS.
CLASS lhc_travel IMPLEMENTATION.
ENDCLASS.` };

test("parseBdefOps extracts custom det/val/action, excluding draft actions and the Prepare framework action", () => {
  const ops = parseBdefOps(fullBdef);
  assert.deepEqual(ops.determinations.sort(), ["setStatus"]);
  assert.deepEqual(ops.validations.sort(), ["validateDates"]);
  assert.deepEqual(ops.actions.sort(), ["copyTravel"], "draft actions (Resume/Edit/Activate/Discard) and Prepare are excluded");
  assert.equal(ops.authInstance, true);
  assert.equal(ops.authGlobal, false);
});

test("gf-x-bdef-handler-reconciliation is clean when every declared op has a handler binding", () => {
  const res = bdefHandlerReconciliationFindings([{ filename: "zi_travel.bdef.asbdef", source: fullBdef }, fullHandler]);
  assert.deepEqual(res, []);
});

test("gf-x-bdef-handler-reconciliation flags a determination with no handler method", () => {
  const noSetStatus = { ...fullHandler, source: fullHandler.source.replace(/METHODS setStatus[^.]*\./, "") };
  const res = bdefHandlerReconciliationFindings([{ filename: "zi_travel.bdef.asbdef", source: fullBdef }, noSetStatus]);
  assert.equal(res.length, 1);
  assert.equal(res[0].rule_id, "gf-x-bdef-handler-reconciliation");
  assert.match(res[0].message, /setStatus/);
});

test("gf-x-bdef-handler-reconciliation flags a custom action with no handler", () => {
  const noCopy = { ...fullHandler, source: fullHandler.source.replace(/METHODS copyTravel[^.]*\./, "") };
  const res = bdefHandlerReconciliationFindings([{ filename: "zi_travel.bdef.asbdef", source: fullBdef }, noCopy]);
  assert.equal(res.length, 1);
  assert.match(res[0].message, /copyTravel/);
});

test("FP trap: draft actions and the Prepare determine-action never require a custom handler", () => {
  // fullHandler has NO Resume/Edit/Activate/Discard/Prepare methods, yet the clean case passes.
  const res = bdefHandlerReconciliationFindings([{ filename: "zi_travel.bdef.asbdef", source: fullBdef }, fullHandler]);
  for (const draft of ["Resume", "Edit", "Activate", "Discard", "Prepare"]) {
    assert.ok(!res.some((r) => r.message.includes(draft)), `${draft} must not be flagged`);
  }
});

test("FP trap: one FOR MODIFY method servicing several actions via multiple FOR ACTION bindings is clean", () => {
  const twoActions = `managed implementation in class zbp_i_x unique;
define behavior for ZI_X alias X
{ create;
  action copyX result [1] $self;
  action shareX result [1] $self;
}`;
  const oneMethod = { filename: "zbp_i_x.clas.locals_imp.abap", source: `CLASS lhc_x DEFINITION INHERITING FROM cl_abap_behavior_handler.
  PRIVATE SECTION.
    METHODS actions FOR MODIFY IMPORTING keys FOR ACTION X~copyX keys2 FOR ACTION X~shareX.
ENDCLASS.
CLASS lhc_x IMPLEMENTATION.
ENDCLASS.` };
  const res = bdefHandlerReconciliationFindings([{ filename: "zi_x.bdef.asbdef", source: twoActions }, oneMethod]);
  assert.deepEqual(res, [], "both copyX and shareX are serviced by the one method's two FOR ACTION bindings");
});

test("a projection behaviour delegates and needs no custom handlers — never flagged", () => {
  const proj = `projection;
define behavior for ZC_Travel alias TravelProj
use draft
{ use create; use action copyTravel; }`;
  assert.deepEqual(bdefHandlerReconciliationFindings([{ filename: "zc_travel.bdef.asbdef", source: proj }]), []);
});
