import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRegistry } from "../src/abaplint-loader.js";
import { regexPack, _resetCache } from "../rules/regex-pack.js";

function findings(source, filename = "zr_x.prog.abap") {
  _resetCache();
  const reg = loadRegistry([{ filename, source }]);
  return regexPack.check({ reg });
}

test("regex pack flags native SQL as a clean-core priority-1", () => {
  const f = findings(`REPORT zr_x.
EXEC SQL.
  SELECT * FROM foo
ENDEXEC.`);
  const hit = f.find((x) => x.rule_id === "talos-native-sql");
  assert.ok(hit, "native-sql flagged");
  assert.equal(hit.severity, "priority-1");
  assert.equal(hit.family, "clean-core");
  assert.equal(hit.object, "ZR_X");
  assert.ok(hit.line >= 2);
});

test("regex pack flags OS command execution", () => {
  const f = findings(`REPORT zr_x.
START-OF-SELECTION.
  CALL 'SYSTEM' ID 'COMMAND' FIELD lv_cmd.`);
  assert.ok(f.some((x) => x.rule_id === "talos-os-command" && x.severity === "priority-1"));
});

test("regex pack does not match inside full-line comments", () => {
  const f = findings(`REPORT zr_x.
* EXEC SQL is mentioned here in a comment only
START-OF-SELECTION.`);
  assert.deepEqual(f.filter((x) => x.rule_id === "talos-native-sql"), []);
});

test("clean source produces no regex-pack findings", () => {
  const f = findings(`REPORT zr_clean.
START-OF-SELECTION.
  DATA lv_count TYPE i.
  lv_count = 1.`);
  assert.deepEqual(f, [], `unexpected: ${JSON.stringify(f.map((x) => x.rule_id))}`);
});

test("trailing quote-comments do not raise findings", () => {
  const f = findings(`REPORT zr_x.
START-OF-SELECTION.
  lv_x = 1. " legacy note: EXEC SQL used to live here`);
  assert.deepEqual(f.filter((x) => x.rule_id === "talos-native-sql"), []);
});

test("full-line quote-comments do not raise findings", () => {
  const f = findings(`REPORT zr_x.
" EXEC SQL is mentioned in this comment only
START-OF-SELECTION.`);
  assert.deepEqual(f.filter((x) => x.rule_id === "talos-native-sql"), []);
});

test("a quote INSIDE a string literal is not treated as a comment start", () => {
  // the literal contains a double quote; the EXEC SQL after it is real code
  const f = findings(`REPORT zr_x.
START-OF-SELECTION.
  lv_msg = 'he said "hi"'. EXEC SQL.
ENDEXEC.`);
  assert.ok(f.some((x) => x.rule_id === "talos-native-sql"), "real code after a quoted literal still fires");
});

test("string literals remain inspectable (function-name rules still fire)", () => {
  const f = findings(`REPORT zr_x.
START-OF-SELECTION.
  CALL FUNCTION 'Z_ANY_FM' EXPORTING iv = 1.`);
  assert.ok(f.some((x) => x.rule_id === "talos-cloud-001-call-function"));
});

test("when-gated RAP handler rules stay silent outside handler classes", () => {
  const f = findings(
    `CLASS zcl_plain DEFINITION PUBLIC FINAL.
  PUBLIC SECTION.
    METHODS run.
ENDCLASS.
CLASS zcl_plain IMPLEMENTATION.
  METHOD run.
    MODIFY ENTITIES OF zi_travel ENTITY travel UPDATE FIELDS ( status ) WITH lt_upd.
    COMMIT WORK.
  ENDMETHOD.
ENDCLASS.`,
    "zcl_plain.clas.abap",
  );
  assert.deepEqual(f.filter((x) => /-in-handler|in-late-save/.test(x.rule_id)), [], "no handler-context, no handler findings");
});

test("when-gated RAP handler rules fire inside a behavior handler class", () => {
  const f = findings(
    `CLASS lhc_travel DEFINITION INHERITING FROM cl_abap_behavior_handler.
  PRIVATE SECTION.
    METHODS modify FOR MODIFY IMPORTING keys FOR ACTION travel~x.
ENDCLASS.
CLASS lhc_travel IMPLEMENTATION.
  METHOD modify.
    COMMIT WORK.
  ENDMETHOD.
ENDCLASS.`,
    "zcl_handler.clas.abap",
  );
  assert.ok(f.some((x) => x.rule_id === "talos-rap-commit-work-in-handler"), "handler context detected");
});

test("scan_comments row fires on comment-line modification markers (cloud-020 no longer dead)", () => {
  const f = findings(`REPORT zr_mod.
*$*$-Start: ZMOD_01----------------------------------------------$*$*
  lv_x = 1.
*$*$-End: ZMOD_01------------------------------------------------$*$*`);
  assert.ok(f.some((x) => x.rule_id === "talos-cloud-020-sap-modification-marker"), "marker rule scans comments");
});

test("every regex-pack finding is well-formed and schema-severity valid", () => {
  const allowed = new Set(["priority-1", "priority-2", "priority-3", "info"]);
  const f = findings(`REPORT zr_x.
EXEC SQL.
ENDEXEC.
SELECT * FROM t000 CLIENT SPECIFIED INTO TABLE @DATA(lt) WHERE ( lv_dyn ).`);
  assert.ok(f.length > 0);
  for (const x of f) {
    assert.ok(x.rule_id && x.object && x.message, "well-formed");
    assert.ok(allowed.has(x.severity), `severity ${x.severity}`);
    assert.ok(x.line > 0);
  }
});
