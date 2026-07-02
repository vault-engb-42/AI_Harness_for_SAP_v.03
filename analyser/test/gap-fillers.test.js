import { test } from "node:test";
import assert from "node:assert/strict";
import { Registry, MemoryFile } from "@abaplint/core";
import { collectStatementEdges } from "../src/statement-edges.js";
import { collectInheritEdges, collectCdsEdges } from "../src/metadata-edges.js";

function load(files) {
  const reg = new Registry();
  for (const f of files) reg.addFile(new MemoryFile(f.filename, f.source));
  reg.parse();
  return [...reg.getObjects()];
}
function has(edges, kind, target, targetKind) {
  return edges.some(
    (e) => e.kind === kind && e.target === target && e.targetKind === targetKind
  );
}

const REPORT = `REPORT zr_gap.
INCLUDE zr_gap_top.
START-OF-SELECTION.
  DATA lo TYPE REF TO if_badi.
  AUTHORITY-CHECK OBJECT 'S_CARRID' ID 'ACTVT' FIELD '03'.
  CALL FUNCTION 'Z_MY_FM' EXPORTING iv = 1.
  GET BADI lo.`;

test("CALL FUNCTION yields a call-function edge to a function node", () => {
  const [obj] = load([{ filename: "zr_gap.prog.abap", source: REPORT }]);
  const edges = collectStatementEdges(obj);
  assert.ok(has(edges, "call-function", "Z_MY_FM", "function"));
});

test("AUTHORITY-CHECK yields an edge-only authority-check to the auth object", () => {
  const [obj] = load([{ filename: "zr_gap.prog.abap", source: REPORT }]);
  const edges = collectStatementEdges(obj);
  assert.ok(has(edges, "authority-check", "S_CARRID", null));
});

test("INCLUDE yields an edge-only includes edge", () => {
  const [obj] = load([{ filename: "zr_gap.prog.abap", source: REPORT }]);
  const edges = collectStatementEdges(obj);
  assert.ok(has(edges, "includes", "ZR_GAP_TOP", null));
});

test("GET BADI yields an edge-only get-badi edge to the handle", () => {
  const [obj] = load([{ filename: "zr_gap.prog.abap", source: REPORT }]);
  const edges = collectStatementEdges(obj);
  assert.ok(has(edges, "get-badi", "LO", null));
});

test("statement edges carry file:row evidence", () => {
  const [obj] = load([{ filename: "zr_gap.prog.abap", source: REPORT }]);
  const cf = collectStatementEdges(obj).find((e) => e.kind === "call-function");
  assert.match(cf.evidence, /zr_gap\.prog\.abap:\d+/);
});

const CLASS = `CLASS zcl_child DEFINITION PUBLIC INHERITING FROM zcl_parent.
  PUBLIC SECTION.
    INTERFACES zif_one.
    INTERFACES zif_two.
    METHODS m.
ENDCLASS.
CLASS zcl_child IMPLEMENTATION.
  METHOD m.
  ENDMETHOD.
ENDCLASS.`;

test("class superclass and interfaces yield inherits edges with correct target kinds", () => {
  const [obj] = load([{ filename: "zcl_child.clas.abap", source: CLASS }]);
  const edges = collectInheritEdges(obj);
  assert.ok(has(edges, "inherits", "ZCL_PARENT", "class"), "superclass -> class");
  assert.ok(has(edges, "inherits", "ZIF_ONE", "interface"), "interface one");
  assert.ok(has(edges, "inherits", "ZIF_TWO", "interface"), "interface two");
});

const CDS = `define view entity ZI_Sales as select from vbak
  association [0..1] to ZI_Customer as _Cust on $projection.kunnr = _Cust.kunnr
{
  key vbak.vbeln,
  _Cust.name
}`;

test("CDS sources and associations yield edge-only consumes-cds edges", () => {
  const [obj] = load([{ filename: "zi_sales.ddls.asddls", source: CDS }]);
  const edges = collectCdsEdges(obj);
  assert.ok(has(edges, "consumes-cds", "VBAK", null), "source VBAK");
  assert.ok(has(edges, "consumes-cds", "ZI_CUSTOMER", null), "association ZI_Customer");
});
