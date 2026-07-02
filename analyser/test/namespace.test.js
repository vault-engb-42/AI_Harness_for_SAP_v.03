import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyNamespace } from "../src/namespace.js";

test("Z-prefixed customer objects classify as Z", () => {
  assert.equal(classifyNamespace("ZCL_PROBE"), "Z");
  assert.equal(classifyNamespace("zcl_probe"), "Z");
  assert.equal(classifyNamespace("Z_MY_REPORT"), "Z");
});

test("Y-prefixed customer objects classify as Y", () => {
  assert.equal(classifyNamespace("YCL_FOO"), "Y");
  assert.equal(classifyNamespace("y_thing"), "Y");
});

test("slash-namespace vendor objects classify as registered", () => {
  assert.equal(classifyNamespace("/ABC/CL_FOO"), "registered");
  assert.equal(classifyNamespace("/1BCDWB/IO_BAR"), "registered");
});

test("SAP standard objects classify as sap", () => {
  assert.equal(classifyNamespace("T000"), "sap");
  assert.equal(classifyNamespace("CL_ABAP_TSTMP"), "sap");
  assert.equal(classifyNamespace("MARA"), "sap");
});

test("blank / nullish names classify as sap (conservative default)", () => {
  assert.equal(classifyNamespace(""), "sap");
  assert.equal(classifyNamespace(undefined), "sap");
  assert.equal(classifyNamespace(null), "sap");
});
