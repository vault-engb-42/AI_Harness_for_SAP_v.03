import { test } from "node:test";
import assert from "node:assert/strict";
import { runRules } from "../src/rule-engine.js";

const ctx = { graph: {}, reg: {}, cloud: {} };

test("runRules aggregates findings from all rules and stamps family/rule_id", () => {
  const rules = [
    { id: "r1", family: "security", verdict: "HARD", check: () => [{ severity: "priority-1", object: "ZCL_A", message: "bad" }] },
    { id: "r2", family: "performance", verdict: "WARN", check: () => [{ severity: "priority-3", object: "ZCL_B", message: "slow" }] },
  ];
  const findings = runRules(rules, ctx);
  assert.equal(findings.length, 2);
  assert.equal(findings[0].rule_id, "r1");
  assert.equal(findings[0].family, "security");
  assert.equal(findings[1].family, "performance");
});

test("a rule returning no findings contributes nothing", () => {
  const rules = [{ id: "quiet", family: "x", verdict: "INFO", check: () => [] }];
  assert.deepEqual(runRules(rules, ctx), []);
});

test("a finding may override the default family and rule_id", () => {
  const rules = [
    { id: "r1", family: "security", verdict: "HARD", check: () => [{ rule_id: "sub-check", family: "invariant", severity: "priority-1", object: "O", message: "m" }] },
  ];
  const [f] = runRules(rules, ctx);
  assert.equal(f.rule_id, "sub-check");
  assert.equal(f.family, "invariant");
});

test("a rule that throws is isolated and yields a diagnostic, not a crash", () => {
  const rules = [
    { id: "boom", family: "x", verdict: "HARD", check: () => { throw new Error("kaboom"); } },
    { id: "ok", family: "y", verdict: "WARN", check: () => [{ severity: "info", object: "O", message: "fine" }] },
  ];
  const findings = runRules(rules, ctx);
  assert.equal(findings.length, 2, "diagnostic + the good rule's finding");
  const diag = findings.find((f) => f.rule_id === "boom");
  assert.ok(diag, "diagnostic finding for the broken rule");
  assert.match(diag.message, /kaboom/);
  assert.ok(findings.some((f) => f.rule_id === "ok"), "good rule still ran");
});

test("null/undefined rule output is treated as empty", () => {
  const rules = [{ id: "nully", family: "x", verdict: "INFO", check: () => null }];
  assert.deepEqual(runRules(rules, ctx), []);
});
