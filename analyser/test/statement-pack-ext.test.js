import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRegistry } from "../src/abaplint-loader.js";
import { statementPack } from "../rules/statement-pack.js";

function findings(body) {
  const source = `CLASS zcl_x DEFINITION PUBLIC.
  PUBLIC SECTION.
    METHODS run.
ENDCLASS.
CLASS zcl_x IMPLEMENTATION.
  METHOD run.
${body}
  ENDMETHOD.
ENDCLASS.`;
  return statementPack.check({ reg: loadRegistry([{ filename: "zcl_x.clas.abap", source }]) });
}
const ids = (f) => f.map((x) => x.rule_id);

// --- in-loop patterns ---

test("synchronous HTTP call inside LOOP is flagged (PERF-16)", () => {
  const f = findings(`    LOOP AT lt INTO DATA(ls).
      lo_client->send( ).
      lo_client->receive( ).
    ENDLOOP.`);
  assert.ok(ids(f).includes("talos-sync-http-in-loop"));
});

test("FREE inside LOOP is flagged (PERF-45)", () => {
  const f = findings(`    LOOP AT lt INTO DATA(ls).
      FREE lt_buffer.
    ENDLOOP.`);
  assert.ok(ids(f).includes("talos-free-in-loop"));
});

test("full-table SORT inside LOOP is flagged (PERF-66)", () => {
  const f = findings(`    LOOP AT lt INTO DATA(ls).
      SORT lt_other BY field.
    ENDLOOP.`);
  assert.ok(ids(f).includes("talos-itab-fulltable-op-in-loop"));
});

test("running total inside LOOP is flagged as window-function candidate (PERF-36)", () => {
  const f = findings(`    LOOP AT lt INTO DATA(ls).
      lv_total = lv_total + ls-amount.
    ENDLOOP.`);
  assert.ok(ids(f).includes("talos-window-function-candidate"));
});

test("ASSIGN COMPONENT inside LOOP is flagged (PERF-46)", () => {
  const f = findings(`    LOOP AT lt INTO DATA(ls).
      ASSIGN COMPONENT lv_name OF STRUCTURE ls TO FIELD-SYMBOL(<fs>).
    ENDLOOP.`);
  assert.ok(ids(f).includes("talos-assign-component-in-loop"));
});

test("in-loop patterns do NOT fire outside a loop", () => {
  const f = findings(`    FREE lt_buffer.
    SORT lt_other BY field.
    lv_total = lv_total + 1.`);
  for (const id of ["talos-free-in-loop", "talos-itab-fulltable-op-in-loop", "talos-window-function-candidate"]) {
    assert.ok(!ids(f).includes(id), `${id} fired outside loop`);
  }
});

// --- statement-level patterns ---

test("ENQUEUE without _WAIT is flagged (PERF-33)", () => {
  const f = findings(`    CALL FUNCTION 'ENQUEUE_EZLOCK'
      EXPORTING iv_key = lv_key.`);
  assert.ok(ids(f).includes("talos-enqueue-no-wait"));
});

test("ENQUEUE with _WAIT is NOT flagged", () => {
  const f = findings(`    CALL FUNCTION 'ENQUEUE_EZLOCK'
      EXPORTING iv_key = lv_key
                _wait  = abap_true.`);
  assert.ok(!ids(f).includes("talos-enqueue-no-wait"));
});

test("SELECT ... ENDSELECT without PACKAGE SIZE is flagged (PERF-56)", () => {
  const f = findings(`    SELECT * FROM t000 INTO @DATA(ls).
    ENDSELECT.`);
  assert.ok(ids(f).includes("talos-endselect-no-package-size"));
});

test("SELECT SINGLE without any WHERE is flagged (PERF-58)", () => {
  const f = findings(`    SELECT SINGLE * FROM t000 INTO @DATA(ls).`);
  assert.ok(ids(f).includes("talos-select-single-no-where"));
});

test("SELECT SINGLE with a WHERE is NOT flagged by PERF-58", () => {
  const f = findings(`    SELECT SINGLE * FROM t000 INTO @DATA(ls) WHERE mandt = @sy-mandt.`);
  assert.ok(!ids(f).includes("talos-select-single-no-where"));
});

// --- context rules ---

test("MODIFY ENTITIES without a preceding guard is flagged (PERF-12)", () => {
  const f = findings(`    MODIFY ENTITIES OF zi_travel ENTITY travel UPDATE FIELDS ( status ) WITH lt_upd.`);
  assert.ok(ids(f).includes("talos-rap-modify-no-guard"));
});

test("MODIFY ENTITIES with an IS NOT INITIAL guard is NOT flagged", () => {
  const f = findings(`    IF lt_upd IS NOT INITIAL.
      MODIFY ENTITIES OF zi_travel ENTITY travel UPDATE FIELDS ( status ) WITH lt_upd.
    ENDIF.`);
  assert.ok(!ids(f).includes("talos-rap-modify-no-guard"));
});

test("client-side SORT immediately after a SELECT without ORDER BY is flagged (PERF-3)", () => {
  const f = findings(`    SELECT * FROM t000 INTO TABLE @DATA(lt_res).
    SORT lt_res BY mandt.`);
  assert.ok(ids(f).includes("talos-client-sort-after-select"));
});

test("SORT after a SELECT WITH ORDER BY is NOT flagged", () => {
  const f = findings(`    SELECT * FROM t000 ORDER BY mandt INTO TABLE @DATA(lt_res).
    SORT lt_res BY mandt.`);
  assert.ok(!ids(f).includes("talos-client-sort-after-select"));
});

test("the same SELECT SINGLE repeated 3x in one file is flagged (HARDY-11)", () => {
  const f = findings(`    SELECT SINGLE * FROM t000 INTO @DATA(ls1) WHERE mandt = '100'.
    SELECT SINGLE * FROM t000 INTO @DATA(ls2) WHERE mandt = '100'.
    SELECT SINGLE * FROM t000 INTO @DATA(ls3) WHERE mandt = '100'.`);
  assert.ok(ids(f).includes("talos-repeated-select-single"));
});
