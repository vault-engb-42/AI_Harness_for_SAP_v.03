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
  WRITE 'hello'.`);
  assert.deepEqual(f, []);
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
