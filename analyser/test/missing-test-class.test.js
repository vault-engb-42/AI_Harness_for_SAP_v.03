import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRegistry } from "../src/abaplint-loader.js";
import { missingTestClassRule } from "../rules/missing-test-class.js";

const CLASS = `CLASS zcl_untested DEFINITION PUBLIC FINAL.
  PUBLIC SECTION.
    METHODS run.
ENDCLASS.
CLASS zcl_untested IMPLEMENTATION.
  METHOD run.
  ENDMETHOD.
ENDCLASS.`;

test("a class with no test class is flagged (HARDY-10)", () => {
  const reg = loadRegistry([{ filename: "zcl_untested.clas.abap", source: CLASS }]);
  const [f] = missingTestClassRule.check({ reg });
  assert.ok(f, "flagged");
  assert.equal(f.rule_id, "talos-missing-test-class");
  assert.equal(f.object, "ZCL_UNTESTED");
});

test("a class with a testclasses include is NOT flagged", () => {
  const reg = loadRegistry([
    { filename: "zcl_tested.clas.abap", source: CLASS.replace(/zcl_untested/g, "zcl_tested") },
    {
      filename: "zcl_tested.clas.testclasses.abap",
      source: `CLASS ltcl_test DEFINITION FOR TESTING RISK LEVEL HARMLESS DURATION SHORT.
  PRIVATE SECTION.
    METHODS t1 FOR TESTING.
ENDCLASS.
CLASS ltcl_test IMPLEMENTATION.
  METHOD t1.
  ENDMETHOD.
ENDCLASS.`,
    },
  ]);
  assert.deepEqual(missingTestClassRule.check({ reg }), []);
});

test("non-class objects are ignored", () => {
  const reg = loadRegistry([{ filename: "zr_x.prog.abap", source: "REPORT zr_x." }]);
  assert.deepEqual(missingTestClassRule.check({ reg }), []);
});
