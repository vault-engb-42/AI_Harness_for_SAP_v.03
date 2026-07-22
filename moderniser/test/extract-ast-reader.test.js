import { test } from "node:test";
import assert from "node:assert/strict";
import { extractAst } from "../src/extract/ast-reader.js";

// gap-2b B3 — the abaplint AST reader (engine 1). Extracts the plain-ABAP features engine 2
// (BDEF/DCL regex) cannot: auth_checks (AUTHORITY-CHECK object/field + SY-SUBRC-checked, feeding
// invariantDiff P4a/P4c), commit_work (the COMMIT boundary count, P4b), money_operands (parity
// `money` class, with a DMBTR/WRBTR/NETWR fallback when abaplint type inference is offline-blind),
// and statement-kind counts (for parity's SELECT→EML read-idiom diff). Parse-robust (P8) + total.

const f = (source, filename = "zcl_x.clas.abap") => ({ filename, source });
const clazz = (body) => `CLASS zcl_x DEFINITION PUBLIC. PUBLIC SECTION. METHODS m. ENDCLASS.
CLASS zcl_x IMPLEMENTATION. METHOD m.
${body}
ENDMETHOD. ENDCLASS.`;

test("auth_checks: AUTHORITY-CHECK object + field (the ID name) + subrc_checked via lookahead", () => {
  const src = clazz(`  AUTHORITY-CHECK OBJECT 'S_DEVELOP' ID 'ACTVT' FIELD '03'.
  IF sy-subrc <> 0. RETURN. ENDIF.
  AUTHORITY-CHECK OBJECT 'S_TABU_DIS' ID 'DICBERCLS' FIELD 'ZZ'.`);
  const out = extractAst([f(src)]);
  assert.deepEqual(out.auth_checks, [
    { object: "S_DEVELOP", field: "ACTVT", dummy: false, subrc_checked: true },
    { object: "S_TABU_DIS", field: "DICBERCLS", dummy: false, subrc_checked: false },
  ]);
});

test("commit_work counts BOTH classic COMMIT WORK and RAP COMMIT ENTITIES (the save boundary)", () => {
  assert.equal(extractAst([f(clazz(`  COMMIT WORK.
  COMMIT ENTITIES.`))]).commit_work, 2);
  assert.equal(extractAst([f(clazz(`  RETURN.`))]).commit_work, 0);
});

test("money_operands: a DMBTR/WRBTR/NETWR-family amount element → CURR; MENGE → QUAN; others ignored", () => {
  const out = extractAst([f(clazz(`  DATA lv_amount TYPE dmbtr.
  DATA lv_net TYPE netwr.
  DATA lv_qty TYPE menge.
  DATA lv_txt TYPE string.`))]);
  assert.deepEqual(out.money_operands, [
    { field: "LV_AMOUNT", type: "CURR" },
    { field: "LV_NET", type: "CURR" },
    { field: "LV_QTY", type: "QUAN" },
  ]);
});

test("statement_kinds: SELECT + READ ENTITIES counted (the read-idiom parity diff input)", () => {
  const out = extractAst([f(clazz(`  SELECT * FROM zt INTO TABLE @DATA(lt).
  READ ENTITIES OF zi_x IN LOCAL MODE ENTITY x ALL FIELDS WITH lt RESULT rt.
  MODIFY ENTITIES OF zi_x IN LOCAL MODE ENTITY x UPDATE FROM lt FAILED fa REPORTED re.`))]);
  assert.equal(out.statement_kinds.select, 1);
  assert.equal(out.statement_kinds.read_entities, 1);
  assert.equal(out.statement_kinds.modify_entities, 1);
});

test("aggregates across a file set; ignores non-ABAP files", () => {
  const out = extractAst([
    f(clazz(`  COMMIT WORK.`), "zcl_a.clas.abap"),
    f(clazz(`  COMMIT WORK.`), "zr_b.prog.abap"),
    f("define behavior for ZI_X alias X lock master { }", "zbp_x.bdef.asbdef"),
  ]);
  assert.equal(out.commit_work, 2);
});

test("structure counters (the §15.4 deduction inputs): exception paths, CFG branches, max nesting", () => {
  const out = extractAst([f(clazz(`  TRY.
      LOOP AT lt INTO DATA(ls).
        IF ls IS INITIAL. CONTINUE. ENDIF.
      ENDLOOP.
    CATCH cx_root INTO DATA(lx).
      RAISE EXCEPTION lx.
  ENDTRY.`))]);
  assert.equal(out.exception_paths, 2, "CATCH + RAISE");
  assert.equal(out.cfg_branches, 2, "LOOP + IF");
  assert.equal(out.max_nesting, 3, "TRY > LOOP > IF");
});

test("client_specified counts the CLIENT SPECIFIED token (half of the client parity trigger)", () => {
  const out = extractAst([f(clazz(`  SELECT * FROM t000 CLIENT SPECIFIED INTO TABLE @DATA(lt).
  SELECT * FROM zt INTO TABLE @DATA(lu).`))]);
  assert.equal(out.client_specified, 1);
});

test("total + parse-robust (P8): empty and malformed input never throw", () => {
  assert.deepEqual(extractAst([]), {
    auth_checks: [], money_operands: [], privileged_sql: [], statement_kinds: {}, unreadable: [],
    commit_work: 0, client_specified: 0, exception_paths: 0, cfg_branches: 0, max_nesting: 0,
  });
  assert.doesNotThrow(() => extractAst([f("CLASS zcl DEFINITION. this is not valid abap {{{")]));
});
