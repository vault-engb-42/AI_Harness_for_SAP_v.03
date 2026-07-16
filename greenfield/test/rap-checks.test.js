import { test } from "node:test";
import assert from "node:assert/strict";
import { isBdef, parseBdefHeader, bdefSaveConsistencyFindings } from "../src/rap-checks.js";

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
