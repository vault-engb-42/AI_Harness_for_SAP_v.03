import { test } from "node:test";
import assert from "node:assert/strict";
import { toSarif } from "../src/sarif.js";

// SARIF 2.1.0 emitter (arch spec §3.C) — the analyser's OWN emitter (not TALOS's,
// decision #12). Pure transform of the curated findings: grade -> SARIF level,
// atcCheckId + security-severity as result properties, distinct rule_ids as
// reportingDescriptors. Deterministic.

const DOC = {
  findings: [
    { rule_id: "S4-001", family: "released-api", grade: "blocker", severity: "priority-1", message: "uses non-released API T001", file: "zr.prog.abap", line: 3, atcCheckId: "SYCM_USAGE_OF_APIS", finding_id: "abc" },
    { rule_id: "ABAP-PERF-01", family: "performance", grade: "warning", severity: "priority-2", message: "SELECT *", file: "zr.prog.abap", line: 5, atcCheckId: "SYCM_USAGE_OF_APIS", finding_id: "def" },
    { rule_id: "S4-001", family: "released-api", grade: "blocker", severity: "priority-1", message: "uses non-released API T005", file: "zr.prog.abap", line: 4, atcCheckId: "SYCM_USAGE_OF_APIS", finding_id: "ghi" },
  ],
};

test("toSarif emits a valid SARIF 2.1.0 envelope with the harness's OWN tool name (not TALOS)", () => {
  const s = toSarif(DOC);
  assert.equal(s.version, "2.1.0");
  assert.match(s.$schema, /sarif-schema-2\.1\.0/);
  const driver = s.runs[0].tool.driver;
  assert.ok(driver.name && driver.name !== "talos-code-graph", "own tool name (decision #12)");
  assert.equal(typeof driver.version, "string");
  assert.equal(s.runs[0].results.length, 3);
});

test("toSarif maps grade -> SARIF level (blocker=error, warning=warning, advisory/needs_review=note)", () => {
  const results = toSarif(DOC).runs[0].results;
  assert.equal(results[0].level, "error"); // blocker
  assert.equal(results[1].level, "warning"); // warning
  assert.equal(toSarif({ findings: [{ rule_id: "x", grade: "advisory", message: "m" }] }).runs[0].results[0].level, "note");
  assert.equal(toSarif({ findings: [{ rule_id: "x", grade: "needs_review", message: "m" }] }).runs[0].results[0].level, "note");
});

test("toSarif result carries location, security-severity and atcCheckId", () => {
  const r = toSarif(DOC).runs[0].results[0];
  assert.equal(r.ruleId, "S4-001");
  assert.equal(r.locations[0].physicalLocation.artifactLocation.uri, "zr.prog.abap");
  assert.equal(r.locations[0].physicalLocation.region.startLine, 3);
  assert.equal(r.properties.atcCheckId, "SYCM_USAGE_OF_APIS");
  assert.ok(Number(r.properties["security-severity"]) > 0);
});

test("toSarif rules[] are distinct reportingDescriptors, sorted, one per rule_id", () => {
  const rules = toSarif(DOC).runs[0].tool.driver.rules;
  assert.deepEqual(rules.map((r) => r.id), ["ABAP-PERF-01", "S4-001"]);
});

test("toSarif is deterministic and total on empty findings", () => {
  assert.equal(JSON.stringify(toSarif(DOC)), JSON.stringify(toSarif(DOC)));
  const empty = toSarif({ findings: [] });
  assert.deepEqual(empty.runs[0].results, []);
  assert.deepEqual(empty.runs[0].tool.driver.rules, []);
});
