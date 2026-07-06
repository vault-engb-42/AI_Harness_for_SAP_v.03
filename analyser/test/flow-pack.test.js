import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRegistry } from "../src/abaplint-loader.js";
import { flowPack } from "../rules/flow-pack.js";

function findings(body, defExtra = "") {
  const source = `CLASS zcl_x DEFINITION PUBLIC FINAL FOR TESTING.
  PUBLIC SECTION.
    METHODS run.${defExtra}
ENDCLASS.
CLASS zcl_x IMPLEMENTATION.
  METHOD run.
${body}
  ENDMETHOD.
ENDCLASS.`;
  return flowPack.check({ reg: loadRegistry([{ filename: "zcl_x.clas.abap", source }]) });
}
const ids = (f) => f.map((x) => x.rule_id);

test("an ENQUEUE lock held across an unrelated CALL FUNCTION is flagged (PERF-34)", () => {
  const f = findings(`    CALL FUNCTION 'ENQUEUE_EZORDER' EXPORTING iv = 1 _wait = abap_true.
    CALL FUNCTION 'Z_SLOW_THING' EXPORTING iv = 2.
    CALL FUNCTION 'DEQUEUE_EZORDER' EXPORTING iv = 1.`);
  assert.ok(ids(f).includes("talos-lock-held-across-calls"));
});

test("ENQUEUE followed directly by DEQUEUE is NOT flagged", () => {
  const f = findings(`    CALL FUNCTION 'ENQUEUE_EZORDER' EXPORTING iv = 1 _wait = abap_true.
    UPDATE ztab SET f = 'x' WHERE id = '1'.
    CALL FUNCTION 'DEQUEUE_EZORDER' EXPORTING iv = 1.`);
  assert.ok(!ids(f).includes("talos-lock-held-across-calls"));
});

test("a field-symbol assigned in a loop and used after ENDLOOP without UNASSIGN is flagged (HARDY-6)", () => {
  const f = findings(`    LOOP AT lt INTO DATA(ls).
      ASSIGN ls-comp TO FIELD-SYMBOL(<fs_row>).
    ENDLOOP.
    lv_x = <fs_row>.`);
  assert.ok(ids(f).includes("talos-dangling-field-symbol"));
});

test("UNASSIGN after the loop clears the dangling risk", () => {
  const f = findings(`    LOOP AT lt INTO DATA(ls).
      ASSIGN ls-comp TO FIELD-SYMBOL(<fs_row>).
    ENDLOOP.
    UNASSIGN <fs_row>.
    lv_x = 1.`);
  assert.ok(!ids(f).includes("talos-dangling-field-symbol"));
});

test("a loop with 8+ arithmetic assignments is an AMDP candidate (PERF-5, advisory)", () => {
  const lines = Array.from({ length: 8 }, (_, i) => `      lv_${i} = lv_${i} * 2 + ${i}.`).join("\n");
  const f = findings(`    LOOP AT lt INTO DATA(ls).
${lines}
    ENDLOOP.`);
  const hit = f.find((x) => x.rule_id === "talos-heavy-loop-calc");
  assert.ok(hit);
  assert.equal(hit.severity, "priority-3");
  const light = findings(`    LOOP AT lt INTO DATA(ls).
      lv_total = lv_total + ls-amount.
    ENDLOOP.`);
  assert.ok(!light.some((x) => x.rule_id === "talos-heavy-loop-calc"), "one calc is not heavy");
});

test("GET_ENTITYSET with an unfiltered SELECT is flagged (PERF-31)", () => {
  const source = `CLASS zcl_dpc DEFINITION PUBLIC FINAL FOR TESTING.
  PUBLIC SECTION.
    METHODS get_entityset.
ENDCLASS.
CLASS zcl_dpc IMPLEMENTATION.
  METHOD get_entityset.
    SELECT * FROM zorders INTO TABLE @DATA(lt).
  ENDMETHOD.
ENDCLASS.`;
  const f = flowPack.check({ reg: loadRegistry([{ filename: "zcl_dpc.clas.abap", source }]) });
  assert.ok(f.some((x) => x.rule_id === "talos-filter-not-delegated"));
  const filtered = flowPack.check({
    reg: loadRegistry([{ filename: "zcl_dpc.clas.abap", source: source.replace("INTO TABLE @DATA(lt)", "INTO TABLE @DATA(lt) WHERE id = '1'") }]),
  });
  assert.ok(!filtered.some((x) => x.rule_id === "talos-filter-not-delegated"));
});

test("3+ legacy-UI statements roll up to one app-level finding (CLOUD-28)", () => {
  const f = findings(`    WRITE 'a'.
    WRITE 'b'.
    CALL SCREEN 100.`);
  const hits = f.filter((x) => x.rule_id === "talos-legacy-ui-rollup");
  assert.equal(hits.length, 1, "one rollup per object");
  const single = findings(`    WRITE 'only one'.`);
  assert.ok(!single.some((x) => x.rule_id === "talos-legacy-ui-rollup"));
});

// ---- audit remediation 2026-07-05: flow-pack accuracy (F12-F15) ----

// F12: plain structure-field moves and string literals must not be counted as
// arithmetic (ABAP requires spaces around arithmetic operators; a field
// selector `-` and slashes/hyphens inside literals do not).
test("field-copy moves and string literals in a loop are not heavy-calc (F12)", () => {
  const moves = Array.from({ length: 8 }, (_, i) => `      ls_out-c${i} = ls-c${i}.`).join("\n");
  const f = findings(`    LOOP AT lt INTO DATA(ls).
${moves}
    ENDLOOP.`);
  assert.ok(!f.some((x) => x.rule_id === "talos-heavy-loop-calc"), "structure-field moves are not arithmetic");

  const strs = Array.from({ length: 8 }, (_, i) => `      lv_p${i} = '/tmp/a-b/f${i}'.`).join("\n");
  const f2 = findings(`    LOOP AT lt INTO DATA(ls).
${strs}
    ENDLOOP.`);
  assert.ok(!f2.some((x) => x.rule_id === "talos-heavy-loop-calc"), "string literals with / or - are not arithmetic");
});

// F13: an unpaired ENQUEUE must not leak across a method boundary.
test("an unpaired ENQUEUE does not leak into the next method (F13)", () => {
  const source = `CLASS zcl_lk DEFINITION PUBLIC FINAL FOR TESTING.
  PUBLIC SECTION.
    METHODS lock.
    METHODS other.
ENDCLASS.
CLASS zcl_lk IMPLEMENTATION.
  METHOD lock.
    CALL FUNCTION 'ENQUEUE_EZORDER' EXPORTING iv = 1.
  ENDMETHOD.
  METHOD other.
    CALL FUNCTION 'Z_UNRELATED_THING' EXPORTING iv = 2.
  ENDMETHOD.
ENDCLASS.`;
  const f = flowPack.check({ reg: loadRegistry([{ filename: "zcl_lk.clas.abap", source }]) });
  assert.ok(!ids(f).includes("talos-lock-held-across-calls"), "lock must not leak past ENDMETHOD");
});

// F14: the legacy-UI rollup must aggregate per object across includes, not
// reset per file (documented as per-object in the module docstring + PARITY).
test("legacy-UI rollup aggregates per object across includes (F14)", () => {
  const main = {
    filename: "zcl_ui.clas.abap",
    source: `CLASS zcl_ui DEFINITION PUBLIC FINAL FOR TESTING.
  PUBLIC SECTION.
    METHODS run.
ENDCLASS.
CLASS zcl_ui IMPLEMENTATION.
  METHOD run.
    WRITE 'a'.
    WRITE 'b'.
  ENDMETHOD.
ENDCLASS.`,
  };
  const locals = {
    filename: "zcl_ui.clas.locals_imp.abap",
    source: `CLASS lcl_helper DEFINITION.
  PUBLIC SECTION.
    METHODS helper.
ENDCLASS.
CLASS lcl_helper IMPLEMENTATION.
  METHOD helper.
    WRITE 'c'.
    WRITE 'd'.
  ENDMETHOD.
ENDCLASS.`,
  };
  const hits = flowPack.check({ reg: loadRegistry([main, locals]) }).filter((x) => x.rule_id === "talos-legacy-ui-rollup");
  assert.equal(hits.length, 1, "4 legacy stmts across 2 includes -> one per-object rollup");
});

// F15: an `IS ASSIGNED` guard after the loop is a defensive check, not a
// dangling deref — it must not be flagged (it neutralizes the empty-table case).
test("an IS ASSIGNED guard after the loop is not flagged dangling (F15)", () => {
  const f = findings(`    LOOP AT lt INTO DATA(ls).
      ASSIGN ls-comp TO FIELD-SYMBOL(<fs_row>).
    ENDLOOP.
    IF <fs_row> IS ASSIGNED.
      lv_x = 1.
    ENDIF.`);
  assert.ok(!ids(f).includes("talos-dangling-field-symbol"), "IS ASSIGNED is a guard, not a dangling deref");
});
