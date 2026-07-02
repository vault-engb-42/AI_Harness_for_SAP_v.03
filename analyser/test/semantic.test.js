import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeObjects } from "../src/semantic.js";

const CLASS_SRC = `CLASS zcl_probe DEFINITION PUBLIC.
  PUBLIC SECTION.
    METHODS run.
    METHODS helper RETURNING VALUE(rv) TYPE i.
ENDCLASS.
CLASS zcl_probe IMPLEMENTATION.
  METHOD run.
    DATA lv TYPE i.
    lv = helper( ).
    SELECT SINGLE * FROM t000 INTO @DATA(ls).
  ENDMETHOD.
  METHOD helper.
    rv = 1.
  ENDMETHOD.
ENDCLASS.`;

const REPORT_SRC = `REPORT zr_probe.
START-OF-SELECTION.
  PERFORM do_it.
FORM do_it.
ENDFORM.`;

const CDS_SRC = `define view entity ZI_Probe as select from t000 { key mandt as Client }`;

const FILES = [
  { filename: "zcl_probe.clas.abap", source: CLASS_SRC },
  { filename: "zr_probe.prog.abap", source: REPORT_SRC },
  { filename: "zi_probe.ddls.asddls", source: CDS_SRC },
];

function findNode(nodes, id) {
  return nodes.find((n) => n.id === id);
}
function hasEdge(edges, source, target, kind) {
  return edges.some((e) => e.source === source && e.target === target && e.kind === kind);
}

test("class object produces a class node with Z namespace", () => {
  const { nodes } = analyzeObjects(FILES);
  const cls = findNode(nodes, "ZCL_PROBE");
  assert.ok(cls, "ZCL_PROBE node exists");
  assert.equal(cls.kind, "class");
  assert.equal(cls.namespace, "Z");
});

test("class methods become method nodes", () => {
  const { nodes } = analyzeObjects(FILES);
  assert.equal(findNode(nodes, "ZCL_PROBE.RUN")?.kind, "method");
  assert.equal(findNode(nodes, "ZCL_PROBE.HELPER")?.kind, "method");
});

test("intra-class method call becomes a call-method edge", () => {
  const { edges } = analyzeObjects(FILES);
  assert.ok(
    hasEdge(edges, "ZCL_PROBE.RUN", "ZCL_PROBE.HELPER", "call-method"),
    "RUN --call-method--> HELPER"
  );
});

test("SELECT on a void SAP table becomes a uses-table edge to a sap-namespace table node", () => {
  const { nodes, edges } = analyzeObjects(FILES);
  assert.ok(hasEdge(edges, "ZCL_PROBE.RUN", "T000", "uses-table"), "RUN --uses-table--> T000");
  const t000 = findNode(nodes, "T000");
  assert.ok(t000, "T000 table node exists");
  assert.equal(t000.kind, "table");
  assert.equal(t000.namespace, "sap");
});

test("report object produces a report node and a PERFORM 'calls' edge", () => {
  const { nodes, edges } = analyzeObjects(FILES);
  assert.equal(findNode(nodes, "ZR_PROBE")?.kind, "report");
  assert.ok(hasEdge(edges, "ZR_PROBE", "ZR_PROBE.DO_IT", "calls"), "report --calls--> DO_IT form");
});

test("CDS DDL source produces a cds node", () => {
  const { nodes } = analyzeObjects(FILES);
  assert.equal(findNode(nodes, "ZI_PROBE")?.kind, "cds");
});

test("no edge carries a kind outside the schema EdgeKind enum", () => {
  const allowed = new Set([
    "calls", "call-function", "call-method", "get-badi", "uses-table",
    "authority-check", "inherits", "consumes-cds", "includes",
    "data-flow-def", "data-flow-use",
  ]);
  const { edges } = analyzeObjects(FILES);
  for (const e of edges) assert.ok(allowed.has(e.kind), `edge kind ${e.kind} is in enum`);
});
