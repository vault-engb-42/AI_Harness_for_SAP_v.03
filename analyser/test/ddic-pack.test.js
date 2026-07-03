import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRegistry } from "../src/abaplint-loader.js";
import { ddicPack } from "../rules/ddic-pack.js";
import { field, tabl, dtel, doma } from "./helpers/abapgit-xml.js";

function run(files) {
  return ddicPack.check({ reg: loadRegistry(files) });
}
const ids = (f) => f.map((x) => x.rule_id);

test("a Cluster/Pool table is flagged priority-1 (PERF-53)", () => {
  const f = run([tabl("ZT_CLUST", { category: "CLUSTER", fields: [field("MANDT", true, "MANDT"), field("F1", true)] })]);
  const hit = f.find((x) => x.rule_id === "talos-tabl-cluster-pool");
  assert.ok(hit);
  assert.equal(hit.severity, "priority-1");
  assert.equal(hit.object, "ZT_CLUST");
});

test("a transparent table whose only key is MANDT is flagged (PERF-55)", () => {
  const f = run([tabl("ZT_FLAT", { fields: [field("MANDT", true, "MANDT"), field("PAYLOAD", false)] })]);
  assert.ok(ids(f).includes("talos-tabl-low-cardinality-key"));
});

test("a transparent table with a real key is NOT flagged by PERF-55", () => {
  const f = run([tabl("ZT_GOOD", { fields: [field("MANDT", true, "MANDT"), field("ORDER_ID", true), field("PAYLOAD", false)] })]);
  assert.ok(!ids(f).includes("talos-tabl-low-cardinality-key"));
});

test("a DTEL whose in-bundle domain declares a conversion exit is flagged advisory (PERF-49)", () => {
  const f = run([dtel("ZDE_ORDER", "ZDO_ORDER"), doma("ZDO_ORDER", "ALPHA")]);
  const hit = f.find((x) => x.rule_id === "talos-dtel-conversion-exit");
  assert.ok(hit);
  assert.equal(hit.severity, "priority-3");
  assert.ok(!run([dtel("ZDE_PLAIN", "ZDO_PLAIN"), doma("ZDO_PLAIN")]).some((x) => x.rule_id === "talos-dtel-conversion-exit"));
});

test("a Z data element on a SAP domain suggests reusing the SAP element (PERF-50, info)", () => {
  const f = run([dtel("ZDE_ONSAP", "MATNR")]);
  const hit = f.find((x) => x.rule_id === "talos-dtel-duplicates-sap");
  assert.ok(hit);
  assert.equal(hit.severity, "info");
  assert.ok(!run([dtel("ZDE_OWN", "ZDO_OWN"), doma("ZDO_OWN")]).some((x) => x.rule_id === "talos-dtel-duplicates-sap"));
});

test("a buffered table written by in-bundle DML is flagged; unwritten buffered table is not (PERF-52)", () => {
  const writer = {
    filename: "zcl_writer.clas.abap",
    source: `CLASS zcl_writer DEFINITION PUBLIC FINAL.
  PUBLIC SECTION.
    METHODS run.
ENDCLASS.
CLASS zcl_writer IMPLEMENTATION.
  METHOD run.
    UPDATE zt_buf SET payload = 'x' WHERE mandt = '100'.
  ENDMETHOD.
ENDCLASS.`,
  };
  const buf = tabl("ZT_BUF", { buffered: true, fields: [field("MANDT", true, "MANDT"), field("ORDER_ID", true), field("PAYLOAD", false)] });
  const withWrite = run([buf, writer]);
  assert.ok(ids(withWrite).includes("talos-tabl-buffered-write"), "buffered + written flagged");
  const withoutWrite = run([buf]);
  assert.ok(!ids(withoutWrite).includes("talos-tabl-buffered-write"), "buffered but unwritten not flagged");
});
