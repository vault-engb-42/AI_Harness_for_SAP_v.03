import { test } from "node:test";
import assert from "node:assert/strict";
import { extractAst } from "../src/extract/ast-reader.js";
import { invariantDiff } from "../src/node/invariants.js";

// gap-2b B6.5 remediation — engine 1 authorization surface. Three adversarially-confirmed defects,
// two of which are precisely the risk surfaces the handoff recorded for the B3 adversarial pass
// that was skipped:
//   F1  `authCheck` captured only the FIRST `ID` and never modelled `DUMMY`, so converting
//       `ID 'BUKRS' FIELD lv_b` (enforced) to `ID 'BUKRS' DUMMY` (NOT enforced) extracted
//       BYTE-IDENTICALLY — an authorization weakening resting PROVISIONAL.
//   F6  `subrc_checked` was a 3-statement token scan with no clobber awareness, so any statement
//       that overwrites SY-SUBRC between the gate and the IF still reported the gate as checked.
//   F11 `/\.abap$/i` admitted files @abaplint/core cannot type; they extracted zero features with
//       NO signal, so every P4 conjunct passed vacuously.
// Plus the ABAP-SQL half of F7: WITH PRIVILEGED ACCESS is a STATEMENT addition, so it belongs here.

const clazz = (body) => `CLASS zcl_x DEFINITION PUBLIC. PUBLIC SECTION. METHODS m. ENDCLASS.
CLASS zcl_x IMPLEMENTATION. METHOD m.
${body}
ENDMETHOD. ENDCLASS.`;
const f = (body, filename = "zcl_x.clas.abap") => ({ filename, source: clazz(body) });

// ---------------------------------------------------------------- F1: every ID, and DUMMY

test("F1: EVERY `ID … FIELD …` pair is captured, not just the first", () => {
  const out = extractAst([f(`  AUTHORITY-CHECK OBJECT 'S_X' ID 'BUKRS' FIELD lv_b ID 'ACTVT' FIELD '03'.
  IF sy-subrc <> 0. RETURN. ENDIF.`)]);
  assert.deepEqual(out.auth_checks, [
    { object: "S_X", field: "BUKRS", dummy: false, subrc_checked: true },
    { object: "S_X", field: "ACTVT", dummy: false, subrc_checked: true },
  ]);
});

test("F1: `DUMMY` is NOT enforcement — it must not extract identically to a real FIELD check", () => {
  const enforced = extractAst([f(`  AUTHORITY-CHECK OBJECT 'S_X' ID 'BUKRS' FIELD lv_b ID 'ACTVT' FIELD '03'.
  IF sy-subrc <> 0. RETURN. ENDIF.`)]);
  const dummied = extractAst([f(`  AUTHORITY-CHECK OBJECT 'S_X' ID 'BUKRS' DUMMY ID 'ACTVT' FIELD '03'.
  IF sy-subrc <> 0. RETURN. ENDIF.`)]);
  assert.notDeepEqual(enforced.auth_checks, dummied.auth_checks, "this was byte-identical before");
  assert.equal(dummied.auth_checks[0].dummy, true);
});

test("F1: DUMMY-ing a field is an AUTH COVERAGE LOSS through the judge (P4a)", () => {
  const before = extractAst([f(`  AUTHORITY-CHECK OBJECT 'S_X' ID 'BUKRS' FIELD lv_b ID 'ACTVT' FIELD '03'.
  IF sy-subrc <> 0. RETURN. ENDIF.`)]);
  const after = extractAst([f(`  AUTHORITY-CHECK OBJECT 'S_X' ID 'BUKRS' DUMMY ID 'ACTVT' FIELD '03'.
  IF sy-subrc <> 0. RETURN. ENDIF.`)]);
  const d = invariantDiff(before, after);
  assert.equal(d.auth_coverage.lost, true, "BUKRS is no longer enforced — that is lost coverage");
  assert.deepEqual(d.auth_coverage.lost_scopes, [{ object: "S_X", field: "BUKRS" }]);
});

test("F1: reordering the IDs is NOT a change (the pairs are a SET, not a sequence)", () => {
  const a = extractAst([f(`  AUTHORITY-CHECK OBJECT 'S_X' ID 'BUKRS' FIELD lv_b ID 'ACTVT' FIELD '03'.
  IF sy-subrc <> 0. RETURN. ENDIF.`)]);
  const b = extractAst([f(`  AUTHORITY-CHECK OBJECT 'S_X' ID 'ACTVT' FIELD '03' ID 'BUKRS' FIELD lv_b.
  IF sy-subrc <> 0. RETURN. ENDIF.`)]);
  assert.equal(invariantDiff(a, b).auth_coverage.lost, false);
  assert.equal(invariantDiff(a, b).auth_delta, false, "a reorder is not an auth-footprint change");
});

test("F1: a non-literal auth OBJECT is recorded as a variable, never collapsed to empty string", () => {
  const out = extractAst([f(`  AUTHORITY-CHECK OBJECT lv_obj ID 'ACTVT' FIELD '03'.
  IF sy-subrc <> 0. RETURN. ENDIF.`)]);
  assert.equal(out.auth_checks[0].object, "VAR:LV_OBJ", "an unresolvable object must not read as the same '' every time");
});

test("F1: AUTHORITY-CHECK with no ID clause still records the object (a check exists)", () => {
  const out = extractAst([f(`  AUTHORITY-CHECK OBJECT 'S_X' FOR USER lv_u ID 'ACTVT' FIELD '03'.
  IF sy-subrc <> 0. RETURN. ENDIF.`)]);
  assert.equal(out.auth_checks.length, 1);
  assert.equal(out.auth_checks[0].object, "S_X");
});

// ---------------------------------------------------------------- F6: SY-SUBRC clobbering

test("F6: a statement that CLOBBERS sy-subrc between the gate and the IF → not checked", () => {
  const out = extractAst([f(`  AUTHORITY-CHECK OBJECT 'S_X' ID 'ACTVT' FIELD '03'.
  SELECT SINGLE * FROM zt INTO @DATA(ls).
  IF sy-subrc <> 0. RETURN. ENDIF.`)]);
  assert.equal(out.auth_checks[0].subrc_checked, false, "the IF tests the SELECT's subrc, not the gate's");
});

test("F6: an immediately-following IF sy-subrc IS a check", () => {
  const out = extractAst([f(`  AUTHORITY-CHECK OBJECT 'S_X' ID 'ACTVT' FIELD '03'.
  IF sy-subrc <> 0. RETURN. ENDIF.`)]);
  assert.equal(out.auth_checks[0].subrc_checked, true);
});

test("F6: a non-clobbering statement in between still counts as checked", () => {
  const out = extractAst([f(`  AUTHORITY-CHECK OBJECT 'S_X' ID 'ACTVT' FIELD '03'.
  lv_x = 1.
  IF sy-subrc <> 0. RETURN. ENDIF.`)]);
  assert.equal(out.auth_checks[0].subrc_checked, true);
});

test("F6: the scan stops at the end of the method (it never borrows the next method's check)", () => {
  const src = `CLASS zcl_x DEFINITION PUBLIC. PUBLIC SECTION. METHODS m. METHODS n. ENDCLASS.
CLASS zcl_x IMPLEMENTATION.
METHOD m.
  AUTHORITY-CHECK OBJECT 'S_X' ID 'ACTVT' FIELD '03'.
ENDMETHOD.
METHOD n.
  IF sy-subrc <> 0. RETURN. ENDIF.
ENDMETHOD.
ENDCLASS.`;
  assert.equal(extractAst([{ filename: "zcl_x.clas.abap", source: src }]).auth_checks[0].subrc_checked, false);
});

// ---------------------------------------------------------------- F11: unreadable files

test("F11: a file abaplint cannot type is REPORTED, not silently extracted as zero features", () => {
  const out = extractAst([{ filename: "zcl_x.abap", source: clazz(`  AUTHORITY-CHECK OBJECT 'S_X' ID 'ACTVT' FIELD '03'.
  COMMIT WORK.`) }]);
  assert.deepEqual(out.unreadable, ["zcl_x.abap"],
    "zero features from an unreadable file would let every P4 conjunct pass vacuously");
});

test("F11: a readable file reports nothing unreadable", () => {
  assert.deepEqual(extractAst([f("  COMMIT WORK.")]).unreadable, []);
});

// ---------------------------------------------------------------- F7 (ABAP-SQL half)

test("F7: `SELECT … WITH PRIVILEGED ACCESS` is a real authorization bypass and is extracted", () => {
  const out = extractAst([f(`  SELECT * FROM zi_invoice WITH PRIVILEGED ACCESS INTO TABLE @DATA(lt).`)]);
  assert.deepEqual(out.privileged_sql, [{ object: "ZI_INVOICE" }]);
});

test("F7: a plain SELECT is not a bypass", () => {
  assert.deepEqual(extractAst([f(`  SELECT * FROM zi_invoice INTO TABLE @DATA(lt).`)]).privileged_sql, []);
});

test("F11: an unreadable file makes P4 fail CLOSED through the judge (not a vacuous pass)", async () => {
  const { assembleBundle, invariantInput } = await import("../src/extract/bundle.js");
  const good = assembleBundle([f("  COMMIT WORK.")]);
  const bad = assembleBundle([{ filename: "zcl_x.abap", source: clazz("  COMMIT WORK.") }]);
  assert.deepEqual(bad.unreadable, ["zcl_x.abap"]);
  const d = invariantDiff(invariantInput(good), invariantInput(bad));
  assert.equal(d.intact, false);
  assert.ok(d.violations.includes("P4:extraction-incomplete"), `violations: ${d.violations}`);
});

test("F7: the ABAP-SQL bypass reaches privileged_cds via the bundle, had_row_auth from the DCL", async () => {
  const { assembleBundle } = await import("../src/extract/bundle.js");
  const sel = f(`  SELECT * FROM zi_invoice WITH PRIVILEGED ACCESS INTO TABLE @DATA(lt).`);
  assert.deepEqual(assembleBundle([sel]).privileged_cds, [{ object: "ZI_INVOICE", had_row_auth: false }]);
  const withGrant = { filename: "zc.dcls.asdcls", source: `define role zc { grant select on zi_invoice where (f) = aspect pfcg_auth( S_X, ACTVT ); }` };
  assert.deepEqual(assembleBundle([sel, withGrant]).privileged_cds, [{ object: "ZI_INVOICE", had_row_auth: true }]);
});
