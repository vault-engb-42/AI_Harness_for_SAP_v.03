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

test("nested loops still flag inner DB access", () => {
  const f = findings(wrapClass(`    LOOP AT lt1 INTO DATA(a).
      LOOP AT lt2 INTO DATA(b).
        SELECT SINGLE * FROM t000 INTO @DATA(ls).
      ENDLOOP.
    ENDLOOP.`));
  assert.ok(f.some((x) => x.rule_id === "talos-select-in-loop"));
});
