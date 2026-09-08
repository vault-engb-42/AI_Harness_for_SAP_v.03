import { test } from "node:test";
import assert from "node:assert/strict";
import { Registry, MemoryFile } from "@abaplint/core";
import { collectStatementEdges } from "../src/statement-edges.js";
import { analyzeObjects } from "../src/semantic.js";
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

test("SELECT ... FROM <table> yields a uses-table edge (statement AST)", () => {
  const src = `REPORT zr_sel.
START-OF-SELECTION.
  SELECT SINGLE * FROM t000 INTO @DATA(ls).`;
  const [obj] = load([{ filename: "zr_sel.prog.abap", source: src }]);
  assert.ok(has(collectStatementEdges(obj), "uses-table", "T000", "table"));
});

test("uses-table survives an unresolved superclass (resolution-independent)", () => {
  // The reference walk collapses when the superclass is void; the statement
  // extractor must still capture the table dependency.
  const src = `CLASS zcl_svc DEFINITION PUBLIC INHERITING FROM cl_not_in_bundle.
  PUBLIC SECTION.
    METHODS run.
ENDCLASS.
CLASS zcl_svc IMPLEMENTATION.
  METHOD run.
    SELECT SINGLE * FROM bapiret1 INTO @DATA(ls).
  ENDMETHOD.
ENDCLASS.`;
  const [obj] = load([{ filename: "zcl_svc.clas.abap", source: src }]);
  assert.ok(has(collectStatementEdges(obj), "uses-table", "BAPIRET1", "table"));
});

test("dynamic and internal-table SELECT sources are not treated as tables", () => {
  const src = `REPORT zr_dyn.
START-OF-SELECTION.
  DATA lt TYPE TABLE OF t000.
  SELECT * FROM @lt AS src INTO TABLE @DATA(r).`;
  const [obj] = load([{ filename: "zr_dyn.prog.abap", source: src }]);
  assert.ok(!collectStatementEdges(obj).some((e) => e.kind === "uses-table" && e.target.startsWith("@")));
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

// R3a (independent ARCH_REVIEW across three corpora, 2026-08-11). Four of seven failed re-architecture
// recommendations were `bdef_managed` + `draft_enabled` on objects that never write — "the contract mandates
// transactional save and draft for a read-only display". The moderniser could not tell a reader from a
// writer because the CPG never showed it one: `uses-table` was emitted for SELECT / SELECT-LOOP ONLY, so
// INSERT, UPDATE, MODIFY and DELETE against a database table produced NO EDGE AT ALL. Every object read;
// none could ever be seen to write.
//
// The access mode rides the edge, so a consumer can ask "does this object own and mutate data" — which is
// what a managed RAP Business Object actually requires — instead of inferring ownership from a read.

const WRITER = `REPORT zr_write.
START-OF-SELECTION.
  SELECT * FROM zorders INTO TABLE @DATA(lt).
  INSERT zorders FROM TABLE @lt.
  UPDATE zorders SET status = 'X' WHERE id = '1'.
  MODIFY zorders FROM TABLE @lt.
  DELETE FROM zorders WHERE id = '2'.`;

test("R3a a SELECT is a read access on the table edge", () => {
  const [obj] = load([{ filename: "zr_write.prog.abap", source: WRITER }]);
  const reads = collectStatementEdges(obj).filter((e) => e.kind === "uses-table" && e.access === "read");
  assert.ok(reads.some((e) => e.target === "ZORDERS"), `the SELECT must be a read: ${JSON.stringify(reads)}`);
});

test("R3a INSERT / UPDATE / MODIFY / DELETE each yield a WRITE table edge", () => {
  const [obj] = load([{ filename: "zr_write.prog.abap", source: WRITER }]);
  const writes = collectStatementEdges(obj).filter((e) => e.kind === "uses-table" && e.access === "write");
  assert.ok(writes.length >= 4, `all four write statements must be seen: ${JSON.stringify(writes)}`);
  for (const e of writes) assert.equal(e.target, "ZORDERS");
});

test("R3a an internal-table operation is NOT a database write", () => {
  // INSERT/DELETE/MODIFY on an internal table are the same keywords and must not be mistaken for persistence.
  const [obj] = load([{ filename: "zr_itab.prog.abap", source: `REPORT zr_itab.
DATA lt TYPE TABLE OF string.
START-OF-SELECTION.
  INSERT \`a\` INTO TABLE lt.
  DELETE lt INDEX 1.` }]);
  const writes = collectStatementEdges(obj).filter((e) => e.kind === "uses-table" && e.access === "write");
  assert.deepEqual(writes, [], `an internal table is not persistence: ${JSON.stringify(writes)}`);
});

test("R3a a read-only report yields reads and NO writes", () => {
  const [obj] = load([{ filename: "zr_ro.prog.abap", source: `REPORT zr_ro.
START-OF-SELECTION.
  SELECT * FROM ekpo INTO TABLE @DATA(lt).` }]);
  const edges = collectStatementEdges(obj).filter((e) => e.kind === "uses-table");
  assert.ok(edges.every((e) => e.access === "read"), `a read-only report must show no write: ${JSON.stringify(edges)}`);
});

// R3a end-to-end. `collectStatementEdges` stamped `access` and it never reached the emitted document,
// because `addDescribedEdge` projected a fixed field set {source, target, kind, evidence} — so a regenerated
// abap_fico doc carried 14 uses-table edges and ZERO access. Caught by regenerating a real corpus and
// measuring, not by the unit test above, which stops one layer short.
//
// The dedup key gains `access` for the same reason: an object that both reads and writes one table has two
// distinct facts, and keying on source|target|kind alone let the read silently suppress the write.
test("R3a the access mode survives into the emitted graph", () => {
  const g = analyzeObjects([{ filename: "zr_rw.prog.abap", source: `REPORT zr_rw.
START-OF-SELECTION.
  SELECT * FROM zorders INTO TABLE @DATA(lt).
  UPDATE zorders SET status = 'X' WHERE id = '1'.` }]).toGraphJSON();
  const edges = g.edges.filter((e) => e.kind === "uses-table" && e.target === "ZORDERS");
  assert.ok(edges.every((e) => e.access), `every table edge must carry its access: ${JSON.stringify(edges)}`);
  assert.ok(edges.some((e) => e.access === "read"), "the SELECT survives");
  assert.ok(edges.some((e) => e.access === "write"), `the UPDATE must not be suppressed by the read: ${JSON.stringify(edges)}`);
});

// F-9.3 — NATIVE SQL. `descriptorFor` had no branch for it, so a table reached only through
// EXEC SQL was absent from the CPG entirely: no uses-table edge, no graph node, and
// `persistence-facts.js` (which derives the persistence dimension exclusively from uses-table
// edges) reported no_persistence_evidence. The dangerous case is MIXED code — an Open SQL read
// beside a native-SQL write — because the read SUPPRESSES the absence marker, so the object
// matches a read-only shape and is handed `readonly_query`, an invariant that structurally
// forbids the write it exists to perform. Pure native SQL fails SAFE (no candidate -> no_shape).
//
// NOT a parser gap, verified against @abaplint/core directly: EXEC SQL parses, and the statement
// between ExecSQL and EndExec carries `UPDATE zorders ...` in its token stream. Note that
// `Statements.NativeSQL` is NOT exported (the constructor is named that, the export does not
// exist), so this is detected by tracking the exported ExecSQL/EndExec pair rather than by
// instanceof on a class that would be undefined.
const NATIVE_SQL = `REPORT zr_native.
START-OF-SELECTION.
  SELECT SINGLE dmbtr FROM bkpf INTO @DATA(lv_amt) WHERE bukrs = '1000'.
  EXEC SQL.
    UPDATE zorders SET status = 'X' WHERE id = 1
  ENDEXEC.
  EXEC SQL.
    SELECT amount INTO :lv_amt FROM zfi_ledger WHERE id = 2
  ENDEXEC.`;

test("F-9.3 a native-SQL write is a WRITE table edge — the table is not invisible", () => {
  const [obj] = load([{ filename: "zr_native.prog.abap", source: NATIVE_SQL }]);
  const writes = collectStatementEdges(obj).filter((e) => e.kind === "uses-table" && e.access === "write");
  assert.ok(
    writes.some((e) => e.target === "ZORDERS"),
    `EXEC SQL UPDATE must yield a write edge, or the object reads as owning nothing: ${JSON.stringify(writes)}`,
  );
});

test("F-9.3 a native-SQL read is a READ table edge", () => {
  const [obj] = load([{ filename: "zr_native.prog.abap", source: NATIVE_SQL }]);
  const reads = collectStatementEdges(obj).filter((e) => e.kind === "uses-table" && e.access === "read");
  assert.ok(reads.some((e) => e.target === "ZFI_LEDGER"), `EXEC SQL SELECT must be a read: ${JSON.stringify(reads)}`);
  assert.ok(reads.some((e) => e.target === "BKPF"), "the ordinary Open SQL read alongside it still works");
});

// The over-claim guard. A native-SQL statement is free-form text to the parser, not a typed grammar:
// the "table" may be schema-qualified, a synonym, a view, or built dynamically, and NONE of those is
// evidence that this object owns a DDIC table. Claiming ownership from a lower-confidence source is
// how a managed RAP BO gets conjured for an object that has none. Only an unambiguous bare identifier
// in a DML head position counts; everything else emits nothing, which is the fail-safe direction.
test("F-9.3 an ambiguous native-SQL target is NOT claimed — silence beats a manufactured table", () => {
  const AMBIGUOUS = `REPORT zr_amb.
START-OF-SELECTION.
  EXEC SQL.
    UPDATE myschema.zorders SET status = 'X'
  ENDEXEC.
  EXEC SQL.
    INSERT INTO :dynamic_target VALUES ( 1 )
  ENDEXEC.
  EXEC SQL.
    SELECT a.id FROM zone_tab AS a JOIN ztwo_tab AS b ON a.id = b.id
  ENDEXEC.`;
  const [obj] = load([{ filename: "zr_amb.prog.abap", source: AMBIGUOUS }]);
  const targets = collectStatementEdges(obj).filter((e) => e.kind === "uses-table").map((e) => e.target);
  assert.ok(!targets.some((t) => t.includes(".")), `a schema-qualified name is not a DDIC table: ${JSON.stringify(targets)}`);
  assert.ok(!targets.includes("ZTWO_TAB"), `a joined table is not the statement's subject: ${JSON.stringify(targets)}`);
});
