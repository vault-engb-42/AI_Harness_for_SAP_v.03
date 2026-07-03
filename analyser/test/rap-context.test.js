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
