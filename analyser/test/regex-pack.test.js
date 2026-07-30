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

// Data-drive (2026-07-30): re-arch-forcing rules carry a disposition_hint that the pack emits on the finding,
// so the moderniser reads the hint from data rather than regex-matching the message prose.
test("regex pack emits disposition_hint on tagged re-arch rules (os_exec / ui_rearch)", () => {
  const os = findings(`REPORT zr_x.
START-OF-SELECTION.
  CALL 'SYSTEM' ID 'COMMAND' FIELD lv_cmd.`).find((x) => x.rule_id === "talos-os-command");
  assert.equal(os.disposition_hint, "os_exec", "OS-command rule carries its os_exec tag");
  const wr = findings(`REPORT zr_x.
START-OF-SELECTION.
  WRITE: / 'hi'.`).find((x) => x.rule_id === "talos-cloud-006-write");
  assert.equal(wr.disposition_hint, "ui_rearch", "WRITE rule carries its ui_rearch tag");
});

test("regex pack emits NO disposition_hint on an untagged rule (regex-fallback path preserved)", () => {
  const ns = findings(`REPORT zr_x.
EXEC SQL.
  SELECT * FROM foo
ENDEXEC.`).find((x) => x.rule_id === "talos-native-sql");
  assert.equal(ns.disposition_hint, undefined, "untagged rule emits no tag → moderniser uses the message-regex fallback");
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

test("A2: EML IN LOCAL MODE is not flagged inside a behavior pool, but is in a plain class", () => {
  // `IN LOCAL MODE` on the same BO inside a behavior pool is the standard RAP pattern (avoids
  // feature-control recursion), NOT an auth bypass. Outside a behavior pool it is a bypass smell.
  const pool = findings(
    `CLASS zbp_x DEFINITION PUBLIC ABSTRACT FINAL FOR BEHAVIOR OF zi_x.
ENDCLASS.
CLASS zbp_x IMPLEMENTATION.
  METHOD create_child.
    MODIFY ENTITIES OF zi_x IN LOCAL MODE ENTITY node CREATE FROM lt.
  ENDMETHOD.
ENDCLASS.`,
    "zbp_x.clas.abap",
  );
  assert.deepEqual(pool.filter((x) => /eml-local-mode/.test(x.rule_id)), [], "behavior pool: local mode is the RAP norm");

  const plain = findings(
    `CLASS zcl_x DEFINITION PUBLIC FINAL CREATE PUBLIC.
ENDCLASS.
CLASS zcl_x IMPLEMENTATION.
  METHOD run.
    MODIFY ENTITIES OF zi_x IN LOCAL MODE ENTITY node CREATE FROM lt.
  ENDMETHOD.
ENDCLASS.`,
    "zcl_x.clas.abap",
  );
  assert.ok(plain.some((x) => /eml-local-mode/.test(x.rule_id)), "plain class: local mode outside a behavior pool still flagged");
});

test("A2: a DCL where(field) is not flagged as dynamic SQL; a real dynamic WHERE in a class is", () => {
  const dcl = findings(
    `@MappingRole: true
define role ZI_X_Access {
  grant select on ZI_X where ( CompanyCode ) = aspect pfcg_auth( F_BKPF_BUK, BUKRS, ACTVT = '03' );
}`,
    "zi_x.dcls.asdcls",
  );
  assert.deepEqual(dcl.filter((x) => x.rule_id === "talos-dynamic-where-subquery"), [], "DCL where(field) is grammar, not dynamic SQL");

  const cls = findings(`REPORT zr_dyn.
START-OF-SELECTION.
  SELECT * FROM foo WHERE ( lv_cond ) INTO TABLE @DATA(lt).`);
  assert.ok(cls.some((x) => x.rule_id === "talos-dynamic-where-subquery"), "a real dynamic WHERE clause still flagged");
});
