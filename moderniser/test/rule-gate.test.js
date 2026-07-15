import { test } from "node:test";
import assert from "node:assert/strict";
import { ruleGate, GAP2A_RULE_IDS } from "../src/node/rule-gate.js";
import { analyzePackage } from "../../analyser/src/orchestrator.js";

// gap-2a — the analyser-rule SELF_CHECK gate. Offline SELF_CHECK runs the greenfield
// 58-rule linter, which carries NO structural RAP/N+1 rules; this gate runs the analyser
// over the node's generated artifacts and BLOCKS on the specific priority-1 rule_ids the
// linter misses, treated exactly like a lint error (regenerate, no SYNTAX_OK).

const finding = (over) => ({ rule_id: "x", severity: "priority-1", file: "z.clas.abap", line: 1, message: "m", ...over });

test("blocks when a target RAP rule fires at priority-1", () => {
  const g = ruleGate({ findings: [finding({ rule_id: "talos-rap-modify-in-loop" })] });
  assert.equal(g.blocked, true);
  assert.equal(g.hits.length, 1);
  assert.equal(g.hits[0].rule_id, "talos-rap-modify-in-loop");
});

test("blocks on talos-select-in-loop (N+1) too", () => {
  assert.equal(ruleGate({ findings: [finding({ rule_id: "talos-select-in-loop" })] }).blocked, true);
});

test("does NOT block on a non-target priority-1 finding (scope is the 4 rule_ids only)", () => {
  // a released-api / clean-core P1 the generator may not be able to repair — out of scope,
  // else the gate traps the generator and burns the cycle budget to a false SYNTAX_CEILING.
  const g = ruleGate({ findings: [finding({ rule_id: "talos-cloud-021-direct-table-write" })] });
  assert.equal(g.blocked, false);
  assert.deepEqual(g.hits, []);
});

test("gates on structural severity, NOT the oracle-routed atc_priority", () => {
  // a target rule at priority-1 whose atc_priority was downgraded STILL blocks — the field
  // is `severity` (the rule's structural verdict), never `atc_priority` (oracle-name-routed).
  const g = ruleGate({ findings: [finding({ rule_id: "talos-rap-modify-in-loop", atc_priority: "P3" })] });
  assert.equal(g.blocked, true);
});

test("ignores a target rule_id that is not priority-1 severity", () => {
  const g = ruleGate({ findings: [finding({ rule_id: "talos-select-in-loop", severity: "priority-2" })] });
  assert.equal(g.blocked, false);
});

test("blocks on all four scoped rules, incl. the now-precise no-guard and read-handler", () => {
  // no-guard and read-handler were made precise in the analyser (constructor-driver skip;
  // method-scoped read-handler) after an earlier version false-blocked valid RAP, so all four
  // are now in scope and each blocks on a genuine priority-1 hit.
  for (const rule_id of GAP2A_RULE_IDS) {
    assert.equal(ruleGate({ findings: [finding({ rule_id })] }).blocked, true, `${rule_id} blocks`);
  }
});

test("clean generated artifacts do not block", () => {
  assert.equal(ruleGate({ findings: [] }).blocked, false);
  assert.equal(ruleGate({}).blocked, false);
});

test("gap-2a scope is the four analyser rules proven PRECISE on real RAP artifacts", () => {
  assert.deepEqual([...GAP2A_RULE_IDS].sort(), [
    "talos-rap-modify-entities-in-read-handler",
    "talos-rap-modify-in-loop",
    "talos-rap-modify-no-guard",
    "talos-select-in-loop",
  ]);
});

// Real code path (no mock): the analyser, run as a library over a generated artifact with a
// SELECT inside a LOOP, emits talos-select-in-loop at priority-1 — a defect the 58-rule
// greenfield linter passes — and the gate BLOCKS it. This is the gap-2a premise, proven live.
test("integration: analyzePackage over a SELECT-in-loop artifact → gate blocks", () => {
  const source = [
    "CLASS zcl_gap2a_probe DEFINITION PUBLIC FINAL CREATE PUBLIC.",
    "  PUBLIC SECTION.",
    "    METHODS run.",
    "ENDCLASS.",
    "CLASS zcl_gap2a_probe IMPLEMENTATION.",
    "  METHOD run.",
    "    DATA lt_keys TYPE STANDARD TABLE OF vbak.",
    "    LOOP AT lt_keys INTO DATA(ls_key).",
    "      SELECT SINGLE * FROM vbap INTO @DATA(ls_item) WHERE vbeln = @ls_key-vbeln.",
    "    ENDLOOP.",
    "  ENDMETHOD.",
    "ENDCLASS.",
  ].join("\n");
  const doc = analyzePackage([{ filename: "zcl_gap2a_probe.clas.abap", source }]);
  const g = ruleGate(doc);
  assert.equal(g.blocked, true, "SELECT inside LOOP must fire talos-select-in-loop");
  assert.ok(g.hits.some((h) => h.rule_id === "talos-select-in-loop"));
});
