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

// F9: the PERF-47 paging guard must test the PARAMETER region, not the method
// name — a table reader named get_top_orders (no paging param) must be flagged.
test("PERF-47 flags a table reader whose NAME contains a paging word but has no paging param (F9)", () => {
  const intf = `INTERFACE zif_x PUBLIC.
  METHODS get_top_orders
    IMPORTING iv_customer TYPE string
    RETURNING VALUE(rt) TYPE STANDARD TABLE.
ENDINTERFACE.`;
  const f = intfPack.check({ reg: loadRegistry([{ filename: "zif_x.intf.abap", source: intf }]) });
  assert.ok(ids(f).includes("talos-intf-read-no-paging"), JSON.stringify(f.map((x) => x.message)));
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

// ---- audit remediation 2026-07-05: CLEAN-015/019 accuracy (F1/F2/F3) ----

// F2: idiomatic colon-chained `METHODS:` test declarations must not silently
// disable CLEAN-015 (raw-regex miss). test_empty asserts nothing -> flagged.
const TESTS_CHAINED = {
  filename: "zcl_calc.clas.testclasses.abap",
  source: `CLASS ltcl_calc DEFINITION FINAL FOR TESTING DURATION SHORT RISK LEVEL HARMLESS.
  PRIVATE SECTION.
    METHODS: test_ok FOR TESTING, test_empty FOR TESTING.
ENDCLASS.
CLASS ltcl_calc IMPLEMENTATION.
  METHOD test_ok.
    cl_abap_unit_assert=>assert_true( act = abap_true ).
  ENDMETHOD.
  METHOD test_empty.
    DATA(x) = 1.
  ENDMETHOD.
ENDCLASS.`,
};

test("colon-chained METHODS: test declarations still get CLEAN-015 (F2)", () => {
  const f = testQualityPack.check({ reg: loadRegistry([MAIN_CLASS, TESTS_CHAINED]) });
  const hits = f.filter((x) => x.rule_id === "talos-test-no-assert");
  assert.equal(hits.length, 1, JSON.stringify(hits.map((h) => h.message)));
  assert.match(hits[0].message, /TEST_EMPTY/);
});

// F3: an assertion delegated to a same-class helper is a real assertion — the
// test must NOT be flagged as assert-less.
const TESTS_HELPER = {
  filename: "zcl_calc.clas.testclasses.abap",
  source: `CLASS ltcl_calc DEFINITION FINAL FOR TESTING DURATION SHORT RISK LEVEL HARMLESS.
  PRIVATE SECTION.
    METHODS test_via_helper FOR TESTING.
    METHODS verify IMPORTING iv_exp TYPE i iv_act TYPE i.
ENDCLASS.
CLASS ltcl_calc IMPLEMENTATION.
  METHOD test_via_helper.
    verify( iv_exp = 3 iv_act = 3 ).
  ENDMETHOD.
  METHOD verify.
    cl_abap_unit_assert=>assert_equals( exp = iv_exp act = iv_act ).
  ENDMETHOD.
ENDCLASS.`,
};

test("a test delegating its assertion to a same-class helper is not flagged (F3)", () => {
  const f = testQualityPack.check({ reg: loadRegistry([MAIN_CLASS, TESTS_HELPER]) });
  const hits = f.filter((x) => x.rule_id === "talos-test-no-assert");
  assert.deepEqual(hits, [], JSON.stringify(hits.map((h) => h.message)));
});

// F1: CLEAN-019's visibility guard was dead (m.visibility is a numeric enum,
// compared to strings) — private/protected methods were mislabeled as untested
// public methods. Only genuinely-public methods belong in the finding.
const MAIN_WITH_PRIVATE = {
  filename: "zcl_svc.clas.abap",
  source: `CLASS zcl_svc DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS run.
    METHODS compute RETURNING VALUE(rv) TYPE i.
  PRIVATE SECTION.
    METHODS internal_helper.
ENDCLASS.
CLASS zcl_svc IMPLEMENTATION.
  METHOD run.
  ENDMETHOD.
  METHOD compute.
    rv = 1.
  ENDMETHOD.
  METHOD internal_helper.
  ENDMETHOD.
ENDCLASS.`,
};
const TESTS_RUN_ONLY = {
  filename: "zcl_svc.clas.testclasses.abap",
  source: `CLASS ltcl_svc DEFINITION FINAL FOR TESTING DURATION SHORT RISK LEVEL HARMLESS.
  PRIVATE SECTION.
    METHODS test_run FOR TESTING.
ENDCLASS.
CLASS ltcl_svc IMPLEMENTATION.
  METHOD test_run.
    DATA(lo) = NEW zcl_svc( ).
    lo->run( ).
    cl_abap_unit_assert=>assert_bound( act = lo ).
  ENDMETHOD.
ENDCLASS.`,
};

test("CLEAN-019 lists only public untested methods, not private helpers (F1)", () => {
  const f = testQualityPack.check({ reg: loadRegistry([MAIN_WITH_PRIVATE, TESTS_RUN_ONLY]) });
  const hit = f.find((x) => x.rule_id === "talos-public-method-untested");
  assert.ok(hit, "COMPUTE is public and untested — should be flagged");
  assert.match(hit.message, /COMPUTE/);
  assert.ok(!/INTERNAL_HELPER/.test(hit.message), "private method must not be reported as public");
});
