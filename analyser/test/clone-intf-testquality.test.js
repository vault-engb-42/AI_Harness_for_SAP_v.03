import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRegistry } from "../src/abaplint-loader.js";
import { clonePack } from "../rules/clone-pack.js";
import { intfPack } from "../rules/intf-pack.js";
import { testQualityPack } from "../rules/test-quality-pack.js";

const ids = (f) => f.map((x) => x.rule_id);

// ---- HARDY-2: duplicate 6-line blocks ----

test("a 6-line block repeated in one source is flagged once (HARDY-2)", () => {
  const block = `    lv_a = 1.
    lv_b = 2.
    lv_c = lv_a + lv_b.
    lv_d = lv_c * 2.
    lv_e = lv_d - 1.
    lv_f = lv_e + 3.`;
  const source = `CLASS zcl_dup DEFINITION PUBLIC FINAL FOR TESTING.
  PUBLIC SECTION.
    METHODS m1.
    METHODS m2.
ENDCLASS.
CLASS zcl_dup IMPLEMENTATION.
  METHOD m1.
${block}
  ENDMETHOD.
  METHOD m2.
${block}
  ENDMETHOD.
ENDCLASS.`;
  const f = clonePack.check({ reg: loadRegistry([{ filename: "zcl_dup.clas.abap", source }]) });
  const hits = f.filter((x) => x.rule_id === "talos-duplicate-block");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].severity, "priority-2");
});

test("distinct code yields no duplicate-block finding", () => {
  const source = `CLASS zcl_uniq DEFINITION PUBLIC FINAL FOR TESTING.
  PUBLIC SECTION.
    METHODS m1.
ENDCLASS.
CLASS zcl_uniq IMPLEMENTATION.
  METHOD m1.
    lv_a = 1.
    lv_b = 2.
    lv_c = 3.
    lv_d = 4.
    lv_e = 5.
    lv_f = 6.
  ENDMETHOD.
ENDCLASS.`;
  const f = clonePack.check({ reg: loadRegistry([{ filename: "zcl_uniq.clas.abap", source }]) });
  assert.deepEqual(f, []);
});

// ---- PERF-47/48: interface signatures ----

const INTF = `INTERFACE zif_orders PUBLIC.
  METHODS get_orders
    IMPORTING iv_customer TYPE string
    RETURNING VALUE(rt_orders) TYPE STANDARD TABLE.
  METHODS get_orders_paged
    IMPORTING iv_customer TYPE string
              iv_top TYPE i
              iv_skip TYPE i
    RETURNING VALUE(rt_orders) TYPE STANDARD TABLE.
  METHODS save_one
    IMPORTING is_order TYPE string.
ENDINTERFACE.`;

test("a table-returning interface method without paging params is flagged (PERF-47)", () => {
  const f = intfPack.check({ reg: loadRegistry([{ filename: "zif_orders.intf.abap", source: INTF }]) });
  const hits = f.filter((x) => x.rule_id === "talos-intf-read-no-paging");
  assert.equal(hits.length, 1, JSON.stringify(hits.map((h) => h.message)));
  assert.match(hits[0].message, /GET_ORDERS\b/);
});

test("a per-row method without a batch sibling is flagged (PERF-48)", () => {
  const f = intfPack.check({ reg: loadRegistry([{ filename: "zif_orders.intf.abap", source: INTF }]) });
  assert.ok(ids(f).includes("talos-intf-no-batch-sibling"));
  const withSibling = INTF.replace("ENDINTERFACE.", `  METHODS save_many
    IMPORTING it_orders TYPE STANDARD TABLE.
ENDINTERFACE.`);
  const f2 = intfPack.check({ reg: loadRegistry([{ filename: "zif_orders.intf.abap", source: withSibling }]) });
  assert.ok(!ids(f2).includes("talos-intf-no-batch-sibling"));
});

// ---- CLEAN-015/019: test quality ----

const MAIN_CLASS = {
  filename: "zcl_calc.clas.abap",
  source: `CLASS zcl_calc DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS add IMPORTING iv_a TYPE i iv_b TYPE i RETURNING VALUE(rv) TYPE i.
    METHODS subtract IMPORTING iv_a TYPE i iv_b TYPE i RETURNING VALUE(rv) TYPE i.
ENDCLASS.
CLASS zcl_calc IMPLEMENTATION.
  METHOD add.
    rv = iv_a + iv_b.
  ENDMETHOD.
  METHOD subtract.
    rv = iv_a - iv_b.
  ENDMETHOD.
ENDCLASS.`,
};

const TESTS_GOOD = {
  filename: "zcl_calc.clas.testclasses.abap",
  source: `CLASS ltcl_calc DEFINITION FINAL FOR TESTING DURATION SHORT RISK LEVEL HARMLESS.
  PRIVATE SECTION.
    METHODS test_add FOR TESTING.
    METHODS test_empty FOR TESTING.
ENDCLASS.
CLASS ltcl_calc IMPLEMENTATION.
  METHOD test_add.
    cl_abap_unit_assert=>assert_equals( act = NEW zcl_calc( )->add( iv_a = 1 iv_b = 2 ) exp = 3 ).
  ENDMETHOD.
  METHOD test_empty.
    DATA(lo) = NEW zcl_calc( ).
  ENDMETHOD.
ENDCLASS.`,
};

test("a FOR TESTING method with no assertion is flagged (CLEAN-015)", () => {
  const f = testQualityPack.check({ reg: loadRegistry([MAIN_CLASS, TESTS_GOOD]) });
  const hits = f.filter((x) => x.rule_id === "talos-test-no-assert");
  assert.equal(hits.length, 1, JSON.stringify(hits.map((h) => h.message)));
  assert.match(hits[0].message, /TEST_EMPTY/);
});

test("a public method never referenced by the test include is flagged (CLEAN-019)", () => {
  const f = testQualityPack.check({ reg: loadRegistry([MAIN_CLASS, TESTS_GOOD]) });
  const hit = f.find((x) => x.rule_id === "talos-public-method-untested");
  assert.ok(hit);
  assert.match(hit.message, /SUBTRACT/);
  assert.ok(!hit.message.includes("ADD,"), "referenced method not listed");
});

test("a class without any test include yields no CLEAN-019 (HARDY-10 owns that case)", () => {
  const f = testQualityPack.check({ reg: loadRegistry([MAIN_CLASS]) });
  assert.deepEqual(ids(f), []);
});
