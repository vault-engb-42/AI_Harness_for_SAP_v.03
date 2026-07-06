import { test } from "node:test";
import assert from "node:assert/strict";
import { Registry, MemoryFile } from "@abaplint/core";
import { collectRapEdges } from "../src/rap-edges.js";

function loadOne(filename, source) {
  const reg = new Registry();
  reg.addFile(new MemoryFile(filename, source));
  reg.parse();
  return [...reg.getObjects()][0];
}
function has(edges, kind, target, targetKind) {
  return edges.some((e) => e.kind === kind && e.target === target && e.targetKind === targetKind);
}

const BDEF = `managed implementation in class zbp_i_ord unique;
strict ( 2 );

define behavior for ZI_Ord alias Order
persistent table zord
lock master
{
  create;
  update;
  delete;
}`;

test("object type is recognized as BDEF", () => {
  const obj = loadOne("zbp_i_ord.bdef.asbdef", BDEF);
  assert.equal(obj.getType(), "BDEF");
});

test("define behavior for <entity> yields a consumes-cds edge to the entity", () => {
  const obj = loadOne("zbp_i_ord.bdef.asbdef", BDEF);
  const edges = collectRapEdges(obj);
  assert.ok(has(edges, "consumes-cds", "ZI_ORD", null), "behavior -> CDS entity");
});

test("implementation in class <class> yields a calls edge to a class node", () => {
  const obj = loadOne("zbp_i_ord.bdef.asbdef", BDEF);
  const edges = collectRapEdges(obj);
  assert.ok(has(edges, "calls", "ZBP_I_ORD", "class"), "behavior -> handler class");
});

test("multiple define-behavior-for blocks all yield entity edges", () => {
  const multi = `unmanaged implementation in class zbp_multi unique;
define behavior for ZI_A alias A { }
define behavior for ZI_B alias B { }`;
  const obj = loadOne("zbp_multi.bdef.asbdef", multi);
  const edges = collectRapEdges(obj);
  assert.ok(has(edges, "consumes-cds", "ZI_A", null));
  assert.ok(has(edges, "consumes-cds", "ZI_B", null));
});

test("non-BDEF objects yield no RAP edges", () => {
  const obj = loadOne("zcl_x.clas.abap", "CLASS zcl_x DEFINITION PUBLIC.\nENDCLASS.\nCLASS zcl_x IMPLEMENTATION.\nENDCLASS.");
  assert.deepEqual(collectRapEdges(obj), []);
});
