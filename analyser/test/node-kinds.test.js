import { test } from "node:test";
import assert from "node:assert/strict";
import { nodeKindForObjectType } from "../src/node-kinds.js";

test("class / interface object types map to their node kinds", () => {
  assert.equal(nodeKindForObjectType("CLAS"), "class");
  assert.equal(nodeKindForObjectType("INTF"), "interface");
});

test("program object type maps to report", () => {
  assert.equal(nodeKindForObjectType("PROG"), "report");
});

test("function group and function module map to function", () => {
  assert.equal(nodeKindForObjectType("FUGR"), "function");
  assert.equal(nodeKindForObjectType("FUNC"), "function");
});

test("CDS DDL source maps to cds; table maps to table; behavior to behavior", () => {
  assert.equal(nodeKindForObjectType("DDLS"), "cds");
  assert.equal(nodeKindForObjectType("TABL"), "table");
  assert.equal(nodeKindForObjectType("BDEF"), "behavior");
});

test("object type match is case-insensitive", () => {
  assert.equal(nodeKindForObjectType("clas"), "class");
});

test("unmapped object types return null (skipped, not guessed)", () => {
  assert.equal(nodeKindForObjectType("DEVC"), null);
  assert.equal(nodeKindForObjectType(""), null);
  assert.equal(nodeKindForObjectType(undefined), null);
});
