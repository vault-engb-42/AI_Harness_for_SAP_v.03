import { test } from "node:test";
import assert from "node:assert/strict";
import { edgeKindForReference } from "../src/edge-kinds.js";

test("method references map to call-method", () => {
  assert.equal(edgeKindForReference("Method"), "call-method");
});

test("form references (PERFORM) map to calls", () => {
  assert.equal(edgeKindForReference("Form"), "calls");
});

test("resolved and void table references both map to uses-table", () => {
  assert.equal(edgeKindForReference("Table"), "uses-table");
  assert.equal(edgeKindForReference("Table (Void)"), "uses-table");
});

test("read/write references map to data-flow edges", () => {
  assert.equal(edgeKindForReference("Read From"), "data-flow-use");
  assert.equal(edgeKindForReference("Write To"), "data-flow-def");
});

test("type/def/builtin references are not CPG edges", () => {
  assert.equal(edgeKindForReference("Type"), null);
  assert.equal(edgeKindForReference("Method Implementation"), null);
  assert.equal(edgeKindForReference("Builtin Method"), null);
  assert.equal(edgeKindForReference("Inferred Type"), null);
  assert.equal(edgeKindForReference("Object"), null);
});

test("unknown reference types are not CPG edges", () => {
  assert.equal(edgeKindForReference("Something New"), null);
  assert.equal(edgeKindForReference(undefined), null);
});
