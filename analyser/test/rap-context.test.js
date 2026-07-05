import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRegistry } from "../src/abaplint-loader.js";
import { rapContextPack } from "../rules/rap-context.js";
import { field, tabl } from "./helpers/abapgit-xml.js";

function run(files) {
  return rapContextPack.check({ reg: loadRegistry(files) });
}
const ids = (f) => f.map((x) => x.rule_id);

const bdef = (name, src) => ({ filename: `${name.toLowerCase()}.bdef.asbdef`, source: src });
const handlerClass = (name, body) => ({
  filename: `${name.toLowerCase()}.clas.abap`,
  source: `CLASS ${name.toLowerCase()} DEFINITION PUBLIC FINAL FOR TESTING.
  PUBLIC SECTION.
    METHODS run.
ENDCLASS.
CLASS ${name.toLowerCase()} IMPLEMENTATION.
  METHOD run.
${body}
  ENDMETHOD.
ENDCLASS.`,
});

const STRICT2 = bdef("zbp_strict", `managed implementation in class zbp_strict unique;
strict ( 2 );
define behavior for ZI_S alias S
{ create; update; }`);

test("CALL TRANSACTION in a strict(2) RAP implementation class is flagged p1 (CC-3)", () => {
  const f = run([STRICT2, handlerClass("ZBP_STRICT", `    CALL TRANSACTION 'VA01'.`)]);
  const hit = f.find((x) => x.rule_id === "talos-strict-call-transaction");
  assert.ok(hit, ids(f).join(","));
  assert.equal(hit.severity, "priority-1");
});

test("direct DB write in a strict(2) RAP implementation class is flagged p1 (CC-4)", () => {
  const f = run([STRICT2, handlerClass("ZBP_STRICT", `    UPDATE zorders SET status = 'X' WHERE id = '1'.`)]);
  assert.ok(ids(f).includes("talos-strict-direct-db"));
});

test("the same statements outside a strict BDEF's implementation class are NOT flagged", () => {
  const loose = bdef("zbp_loose", `managed implementation in class zbp_loose unique;
define behavior for ZI_L alias L
{ create; }`);
  const f = run([loose, handlerClass("ZBP_LOOSE", `    CALL TRANSACTION 'VA01'.
    UPDATE zorders SET status = 'X' WHERE id = '1'.`)]);
  assert.deepEqual(f.filter((x) => /talos-strict-/.test(x.rule_id)), []);
});

test("a draft BO child behavior declaring direct create is flagged p1 (PERF-71)", () => {
  const b = bdef("zbp_draft", `managed implementation in class zbp_draft unique;
define behavior for ZI_Root alias Root
with draft
{ create; update; association _Items { create; } }
define behavior for ZI_Item alias Item
{ create; update; }`);
  const f = run([b]);
  const hit = f.find((x) => x.rule_id === "talos-rap-draft-child-create");
  assert.ok(hit, ids(f).join(","));
  assert.match(hit.message, /ZI_ITEM/i);
});

test("a draft BO whose children have no direct create is NOT flagged by PERF-71", () => {
  const b = bdef("zbp_ok", `managed implementation in class zbp_ok unique;
define behavior for ZI_Root2 alias Root
with draft
{ create; association _Items { create; } }
define behavior for ZI_Item2 alias Item
{ update; delete; }`);
  assert.ok(!ids(run([b])).includes("talos-rap-draft-child-create"));
});

test("late-numbering draft whose in-bundle draft table lacks a DRAFTUUID key is flagged p1 (PERF-72)", () => {
  const b = bdef("zbp_late", `managed implementation in class zbp_late unique;
define behavior for ZI_LN alias LN
with draft
late numbering
draft table zd_ln
{ create; }`);
  const badDraftTable = tabl("ZD_LN", { fields: [field("MANDT", true, "MANDT"), field("ORDER_ID", true), field("PAYLOAD", false)] });
  const f = run([b, badDraftTable]);
  assert.ok(ids(f).includes("talos-rap-draft-table-no-uuid"), ids(f).join(","));

  const goodDraftTable = tabl("ZD_LN", { fields: [field("DRAFTUUID", true), field("PAYLOAD", false)] });
  assert.ok(!ids(run([b, goodDraftTable])).includes("talos-rap-draft-table-no-uuid"));
});

test("an unbounded SELECT inside a FOR READ handler method is flagged (PERF-10)", () => {
  const b = bdef("zbp_read", `managed implementation in class zbp_read unique;
define behavior for ZI_R alias R
{ create; }`);
  const reader = {
    filename: "zbp_read.clas.abap",
    source: `CLASS zbp_read DEFINITION PUBLIC FINAL FOR TESTING.
  PUBLIC SECTION.
    METHODS read_r FOR READ IMPORTING keys FOR READ R RESULT result.
ENDCLASS.
CLASS zbp_read IMPLEMENTATION.
  METHOD read_r.
    SELECT * FROM zorders INTO TABLE @DATA(lt) WHERE id = '1'.
  ENDMETHOD.
ENDCLASS.`,
  };
  const f = run([b, reader]);
  assert.ok(ids(f).includes("talos-rap-read-unbounded"), ids(f).join(","));

  const bounded = { ...reader, source: reader.source.replace("WHERE id = '1'", "UP TO 100 ROWS WHERE id = '1'") };
  assert.ok(!ids(run([b, bounded])).includes("talos-rap-read-unbounded"));
});

// F4: SELECT SINGLE (one row) and FOR ALL ENTRIES (keyed) inside a FOR READ
// method are inherently bounded — PERF-10 must not flag the canonical RAP read.
test("bounded reads inside a FOR READ method are not PERF-10 (SELECT SINGLE, FAE)", () => {
  const b = bdef("zbp_read2", `managed implementation in class zbp_read2 unique;
define behavior for ZI_R2 alias R
{ create; }`);
  const single = {
    filename: "zbp_read2.clas.abap",
    source: `CLASS zbp_read2 DEFINITION PUBLIC FINAL FOR TESTING.
  PUBLIC SECTION.
    METHODS read_r FOR READ IMPORTING keys FOR READ R RESULT result.
ENDCLASS.
CLASS zbp_read2 IMPLEMENTATION.
  METHOD read_r.
    SELECT SINGLE * FROM zorders INTO @DATA(ls) WHERE id = '1'.
  ENDMETHOD.
ENDCLASS.`,
  };
  assert.ok(!ids(run([b, single])).includes("talos-rap-read-unbounded"), "SELECT SINGLE reads one row");

  const fae = {
    ...single,
    source: single.source.replace(
      "SELECT SINGLE * FROM zorders INTO @DATA(ls) WHERE id = '1'.",
      "SELECT * FROM zorders FOR ALL ENTRIES IN @keys WHERE id = @keys-id INTO TABLE @DATA(lt).",
    ),
  };
  assert.ok(!ids(run([b, fae])).includes("talos-rap-read-unbounded"), "FAE reads only the requested keys");
});

// F5: /NS/-namespaced class & entity names must not silently disable the BDEF
// cross-artifact join. abapGit encodes /ACME/ as #acme# in filenames.
test("namespaced (/NS/) names still drive the BDEF cross-artifact join (F5)", () => {
  // implementation-in-class capture must accept a namespaced class -> CC-3
  const strictNs = {
    filename: "#acme#zbp_ns.bdef.asbdef",
    source: `managed implementation in class /acme/cl_h unique;
strict ( 2 );
define behavior for /acme/i_r alias R
{ create; }`,
  };
  const clsNs = {
    filename: "#acme#cl_h.clas.abap",
    source: `CLASS /acme/cl_h DEFINITION PUBLIC FINAL FOR TESTING.
  PUBLIC SECTION.
    METHODS run.
ENDCLASS.
CLASS /acme/cl_h IMPLEMENTATION.
  METHOD run.
    CALL TRANSACTION 'VA01'.
  ENDMETHOD.
ENDCLASS.`,
  };
  assert.ok(ids(run([strictNs, clsNs])).includes("talos-strict-call-transaction"), "namespaced strict impl class joins for CC-3");

  // define-behavior capture must accept a namespaced child entity -> PERF-71
  const draftNs = {
    filename: "#acme#zbp_dn.bdef.asbdef",
    source: `managed implementation in class /acme/cl_dn unique;
define behavior for /acme/i_root alias Root
with draft
{ create; association _Items { create; } }
define behavior for /acme/i_item alias Item
{ create; }`,
  };
  const hit = run([draftNs]).find((x) => x.rule_id === "talos-rap-draft-child-create");
  assert.ok(hit, "namespaced child entity parsed");
  assert.match(hit.message, /I_ITEM/i);
});
