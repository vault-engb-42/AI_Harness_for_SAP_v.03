import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRegistry } from "../src/abaplint-loader.js";
import { statementPack } from "../rules/statement-pack.js";

function findings(source, filename = "zcl_x.clas.abap") {
  return statementPack.check({ reg: loadRegistry([{ filename, source }]) });
}
function wrapClass(body) {
  return `CLASS zcl_x DEFINITION PUBLIC.
  PUBLIC SECTION.
    METHODS run.
ENDCLASS.
CLASS zcl_x IMPLEMENTATION.
  METHOD run.
${body}
  ENDMETHOD.
ENDCLASS.`;
}

test("SELECT inside LOOP is flagged N+1", () => {
  const f = findings(wrapClass(`    LOOP AT lt_keys INTO DATA(lv_key).
      SELECT SINGLE * FROM t000 INTO @DATA(ls) WHERE mandt = @lv_key.
    ENDLOOP.`));
  const hit = f.find((x) => x.rule_id === "talos-select-in-loop");
  assert.ok(hit, "select-in-loop flagged");
  assert.equal(hit.severity, "priority-1");
  assert.equal(hit.object, "ZCL_X");
});

test("a top-level SELECT (not in a loop) is NOT flagged", () => {
  const f = findings(wrapClass(`    SELECT SINGLE * FROM t000 INTO @DATA(ls).`));
  assert.deepEqual(f.filter((x) => x.rule_id === "talos-select-in-loop"), []);
});

test("database MODIFY inside LOOP is flagged", () => {
  const f = findings(wrapClass(`    LOOP AT lt INTO DATA(ls).
      MODIFY ztable FROM ls.
    ENDLOOP.`));
  assert.ok(f.some((x) => x.rule_id === "talos-dml-in-loop" && x.severity === "priority-2"));
});

test("COMMIT WORK inside LOOP is flagged priority-1", () => {
  const f = findings(wrapClass(`    LOOP AT lt INTO DATA(ls).
      COMMIT WORK.
    ENDLOOP.`));
  assert.ok(f.some((x) => x.rule_id === "talos-commit-in-loop" && x.severity === "priority-1"));
});

test("FOR ALL ENTRIES without an IS NOT INITIAL guard is flagged", () => {
  const f = findings(wrapClass(`    SELECT * FROM t000 FOR ALL ENTRIES IN @lt_drv WHERE mandt = @lt_drv-mandt INTO TABLE @DATA(lt).`));
  const hit = f.find((x) => x.rule_id === "talos-fae-no-guard");
  assert.ok(hit, "fae-no-guard flagged");
  assert.match(hit.message, /LT_DRV/);
});

test("FOR ALL ENTRIES WITH a preceding IS NOT INITIAL guard is NOT flagged", () => {
  const f = findings(wrapClass(`    IF lt_drv IS NOT INITIAL.
      SELECT * FROM t000 FOR ALL ENTRIES IN @lt_drv WHERE mandt = @lt_drv-mandt INTO TABLE @DATA(lt).
    ENDIF.`));
  assert.deepEqual(f.filter((x) => x.rule_id === "talos-fae-no-guard"), []);
});

test("the early-return guard form (IF drv IS INITIAL. RETURN.) is also accepted", () => {
  const f = findings(wrapClass(`    IF lt_drv IS INITIAL.
      RETURN.
    ENDIF.
    SELECT * FROM t000 FOR ALL ENTRIES IN @lt_drv WHERE mandt = @lt_drv-mandt INTO TABLE @DATA(lt).`));
  assert.deepEqual(f.filter((x) => x.rule_id === "talos-fae-no-guard"), []);
});

test("old-syntax IF NOT drv IS INITIAL is also accepted as a guard", () => {
  const f = findings(wrapClass(`    IF NOT lt_drv IS INITIAL.
      SELECT * FROM t000 FOR ALL ENTRIES IN @lt_drv WHERE mandt = @lt_drv-mandt INTO TABLE @DATA(lt).
    ENDIF.`));
  assert.deepEqual(f.filter((x) => x.rule_id === "talos-fae-no-guard"), []);
});

test("nested loops still flag inner DB access", () => {
  const f = findings(wrapClass(`    LOOP AT lt1 INTO DATA(a).
      LOOP AT lt2 INTO DATA(b).
        SELECT SINGLE * FROM t000 INTO @DATA(ls).
      ENDLOOP.
    ENDLOOP.`));
  assert.ok(f.some((x) => x.rule_id === "talos-select-in-loop"));
});

// gap-2a precision (2026-07-15). Two RAP-modelling rules were analyser-imprecise and
// false-blocked valid RAP: no-guard fired on an inline WITH VALUE constructor (a literal is
// never INITIAL), and read-handler (a file-level regex) matched any behaviour pool, not only
// FOR READ methods. Fixed: constructor-driver skip in checkGuard; read-handler moved here with
// real method-context.

test("MODIFY ENTITIES ... WITH an inline VALUE constructor is NOT flagged no-guard", () => {
  const f = findings(wrapClass(`    MODIFY ENTITIES OF zi_x IN LOCAL MODE ENTITY x UPDATE FIELDS ( f ) WITH VALUE #( ( %tky = key f = 1 ) ) FAILED DATA(failed).`));
  assert.deepEqual(f.filter((x) => x.rule_id === "talos-rap-modify-no-guard"), [], "an inline literal is never INITIAL — no runtime guard applies");
});

// review F4: a VALUE #( FOR .. IN <tab> ) / CORRESPONDING #( <tab> ) constructor iterates a source
// that CAN be empty — the blanket constructor-skip was a false negative. Guard-check the source
// table when it is a locally-declared itab; leave framework-guaranteed params (keys) alone.
test("MODIFY ENTITIES ... WITH VALUE #( FOR .. IN <declared itab> ) and NO guard IS flagged no-guard (F4)", () => {
  const f = findings(wrapClass(`    DATA lt_unbounded TYPE STANDARD TABLE OF zi_x WITH EMPTY KEY.
    MODIFY ENTITIES OF zi_x IN LOCAL MODE ENTITY x UPDATE FIELDS ( f ) WITH VALUE #( FOR r IN lt_unbounded ( %tky = r-k f = r-f ) ) FAILED DATA(failed).`));
  const hit = f.find((x) => x.rule_id === "talos-rap-modify-no-guard");
  assert.ok(hit, "a constructor iterating an unguarded declared itab must be flagged");
  assert.match(hit.message, /LT_UNBOUNDED/, "the finding names the real source table, not the VALUE keyword");
});

test("MODIFY ENTITIES ... WITH VALUE #( FOR .. IN <itab> ) WITH a preceding guard is NOT flagged (F4)", () => {
  const f = findings(wrapClass(`    DATA lt_x TYPE STANDARD TABLE OF zi_x WITH EMPTY KEY.
    IF lt_x IS NOT INITIAL.
      MODIFY ENTITIES OF zi_x IN LOCAL MODE ENTITY x UPDATE FIELDS ( f ) WITH VALUE #( FOR r IN lt_x ( %tky = r-k ) ) FAILED DATA(failed).
    ENDIF.`));
  assert.deepEqual(f.filter((x) => x.rule_id === "talos-rap-modify-no-guard"), [], "the source table is proven non-empty by the guard");
});

test("MODIFY ENTITIES ... WITH VALUE #( FOR key IN keys ) is NOT flagged — keys is a framework param, not a declared itab (F4 no-FP)", () => {
  const src = behaviorPool(
    "METHODS doit FOR MODIFY IMPORTING keys FOR ACTION x~doit.",
    "doit",
    "MODIFY ENTITIES OF zi_x IN LOCAL MODE ENTITY x UPDATE FIELDS ( f ) WITH VALUE #( FOR key IN keys ( %tky = key-x ) ) FAILED DATA(failed).",
  );
  const f = findings(src, "lhc_x.clas.abap");
  assert.deepEqual(f.filter((x) => x.rule_id === "talos-rap-modify-no-guard"), [], "the RAP importing keys table is framework-guaranteed non-empty; no guard required, no false BLOCK");
});

const behaviorPool = (methodDef, methodName, body) =>
  [
    "CLASS lhc_x DEFINITION INHERITING FROM cl_abap_behavior_handler.",
    "  PRIVATE SECTION.",
    `    ${methodDef}`,
    "ENDCLASS.",
    "CLASS lhc_x IMPLEMENTATION.",
    `  METHOD ${methodName}.`,
    `    ${body}`,
    "  ENDMETHOD.",
    "ENDCLASS.",
  ].join("\n");

test("MODIFY ENTITIES inside a FOR READ handler IS flagged read-handler", () => {
  const src = behaviorPool(
    "METHODS read FOR READ IMPORTING keys FOR READ x RESULT result.",
    "read",
    "MODIFY ENTITIES OF zi_x IN LOCAL MODE ENTITY x UPDATE FIELDS ( f ) WITH VALUE #( ( %tky = k ) ) FAILED DATA(failed).",
  );
  const f = findings(src, "lhc_x.clas.abap");
  assert.ok(f.some((x) => x.rule_id === "talos-rap-modify-entities-in-read-handler"), "a MODIFY in a read handler is flagged");
});

test("MODIFY ENTITIES inside a FOR MODIFY/action handler is NOT flagged read-handler", () => {
  const src = behaviorPool(
    "METHODS doit FOR MODIFY IMPORTING keys FOR ACTION x~doit.",
    "doit",
    "MODIFY ENTITIES OF zi_x IN LOCAL MODE ENTITY x UPDATE FIELDS ( f ) WITH VALUE #( ( %tky = k ) ) FAILED DATA(failed).",
  );
  const f = findings(src, "lhc_x.clas.abap");
  assert.deepEqual(f.filter((x) => x.rule_id === "talos-rap-modify-entities-in-read-handler"), [], "an action handler is not a read handler");
});

// review F3: read-handler identity must be CLASS-qualified. A bare method-name key false-flags a
// MODIFY in a same-named action method of a DIFFERENT local class in the same behaviour pool.
test("a MODIFY in an action method is NOT flagged just because another local class has a same-named FOR READ method (F3)", () => {
  const src = [
    "CLASS lhc_a DEFINITION INHERITING FROM cl_abap_behavior_handler.",
    "  PRIVATE SECTION.",
    "    METHODS process FOR READ IMPORTING keys FOR READ x RESULT result.",
    "ENDCLASS.",
    "CLASS lhc_b DEFINITION INHERITING FROM cl_abap_behavior_handler.",
    "  PRIVATE SECTION.",
    "    METHODS process FOR MODIFY IMPORTING keys FOR ACTION x~process.",
    "ENDCLASS.",
    "CLASS lhc_a IMPLEMENTATION.",
    "  METHOD process.",
    "  ENDMETHOD.",
    "ENDCLASS.",
    "CLASS lhc_b IMPLEMENTATION.",
    "  METHOD process.",
    "    MODIFY ENTITIES OF zi_x IN LOCAL MODE ENTITY x UPDATE FIELDS ( f ) WITH VALUE #( ( %tky = k ) ) FAILED DATA(failed).",
    "  ENDMETHOD.",
    "ENDCLASS.",
  ].join("\n");
  const f = findings(src, "lhc_x.clas.abap");
  assert.deepEqual(
    f.filter((x) => x.rule_id === "talos-rap-modify-entities-in-read-handler"),
    [],
    "lhc_b::process is an action handler; lhc_a::process being FOR READ must not implicate it",
  );
});

// review F2: a class's FOR READ def and the offending MODIFY impl can serialize to SEPARATE
// abapGit includes (.clas.locals_def / .clas.locals_imp). Read handlers must be gathered across
// ALL of the object's files before any file's MODIFY is checked — a per-file set misses it.
test("MODIFY in a read handler is flagged even when the class DEF and IMPL are in separate abapGit files (F2)", () => {
  const def = [
    "CLASS lhc_x DEFINITION INHERITING FROM cl_abap_behavior_handler.",
    "  PRIVATE SECTION.",
    "    METHODS read FOR READ IMPORTING keys FOR READ x RESULT result.",
    "ENDCLASS.",
  ].join("\n");
  const imp = [
    "CLASS lhc_x IMPLEMENTATION.",
    "  METHOD read.",
    "    MODIFY ENTITIES OF zi_x IN LOCAL MODE ENTITY x UPDATE FIELDS ( f ) WITH VALUE #( ( %tky = k ) ) FAILED DATA(failed).",
    "  ENDMETHOD.",
    "ENDCLASS.",
  ].join("\n");
  const reg = loadRegistry([
    { filename: "zbp_i_x.clas.locals_def.abap", source: def },
    { filename: "zbp_i_x.clas.locals_imp.abap", source: imp },
  ]);
  const f = statementPack.check({ reg });
  assert.ok(
    f.some((x) => x.rule_id === "talos-rap-modify-entities-in-read-handler"),
    "a read handler whose def and impl live in separate includes must still be correlated across the object's files",
  );
});
