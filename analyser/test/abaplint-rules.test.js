import { test } from "node:test";
import assert from "node:assert/strict";
import { Registry, MemoryFile } from "@abaplint/core";
import { runAbaplintRules } from "../src/abaplint-rules.js";
import { severityForAbaplintRule, familyForAbaplintRule } from "../src/finding-severity.js";

function analyze(filename, source) {
  const reg = new Registry();
  reg.addFile(new MemoryFile(filename, source));
  reg.parse();
  return runAbaplintRules(reg);
}

const BAD = `REPORT zr_bad.
START-OF-SELECTION.
  SELECT * FROM t000 INTO TABLE @DATA(lt).`;

test("abaplint rules produce schema findings attributed to the owning object", () => {
  const findings = analyze("zr_bad.prog.abap", BAD);
  assert.ok(findings.length > 0, "some findings");
  const perf = findings.find((f) => f.rule_id === "select_performance");
  assert.ok(perf, "select_performance fired");
  assert.equal(perf.object, "ZR_BAD");
  assert.equal(perf.object_type, "PROG");
  assert.match(perf.file, /zr_bad\.prog\.abap/);
  assert.ok(perf.line > 0);
  assert.ok(typeof perf.message === "string" && perf.message.length > 0);
});

test("every finding carries a schema-valid severity", () => {
  const allowed = new Set(["priority-1", "priority-2", "priority-3", "info"]);
  const findings = analyze("zr_bad.prog.abap", BAD);
  for (const f of findings) assert.ok(allowed.has(f.severity), `severity ${f.severity}`);
});

test("severity mapping: Error->priority-2, Warning->priority-3, Info->info", () => {
  assert.equal(severityForAbaplintRule("select_performance", "Error"), "priority-2");
  assert.equal(severityForAbaplintRule("some_rule", "Warning"), "priority-3");
  assert.equal(severityForAbaplintRule("some_rule", "Info"), "info");
});

test("cloud_types Errors are promoted to priority-1 (Clean-Core blocker)", () => {
  assert.equal(severityForAbaplintRule("cloud_types", "Error"), "priority-1");
  assert.equal(familyForAbaplintRule("cloud_types"), "clean-core");
  // an Info from the same rule is not inflated
  assert.equal(severityForAbaplintRule("cloud_types", "Info"), "info");
});

test("clean code produces no schema-breaking findings", () => {
  const clean = `CLASS zcl_ok DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS run RETURNING VALUE(rv) TYPE i.
ENDCLASS.
CLASS zcl_ok IMPLEMENTATION.
  METHOD run.
    rv = 1.
  ENDMETHOD.
ENDCLASS.`;
  const findings = analyze("zcl_ok.clas.abap", clean);
  for (const f of findings) {
    assert.ok(f.rule_id && f.object && f.message, "finding well-formed");
  }
});
