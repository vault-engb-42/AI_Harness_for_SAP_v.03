import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateGate } from "../ci-gate.js";

// GAP#1b — the CI/CD gate adapter. Deterministic (no LLM): reads the gate
// verdicts, validates their shape (fail-closed), and blocks on any hard failure.
// Tests write REAL verdict JSON to a temp dir and run the real evaluator.

const SAP_PASS = { verdict: "PASS", timestamp: "t", connection: "DEV", objects: ["ZCL_X"], failure_layer: null, activation: { activated: [], errors: [] }, atc: { ran: true, variant: "v", priority1: [], priority2: [], priority2_3: [] }, abap_unit: { ran: true, failed: [], coverage_pct: 80, coverage_baseline_pct: 75 }, clean_core_level: "A", invariant_diff: { authority_check_weakened: false, commit_work_suppressed: false, commit_entities_suppressed: false, sy_subrc_check_dropped: false }, ratchet: { atc_regressed: false, coverage_regressed: false }, notes: "" };
const CLEAN_PASS = { gate: "clean-core", pass: true, atc: { variant: "v", completed: true, priority_1: 0 }, grounding: {}, summary: {}, findings: [] };
const SEC_PASS = { gate: "security", pass: true, block_severities: [], invariants: { authority_check: "ok", commit_work: "ok", commit_entities: "ok", sy_subrc: "ok", baseline_established: true }, summary: {}, findings: [] };
const DIFF_PASS = { gate: "abap-diff-review", pass: true, range: "r", acceptance_criteria_source: "s", summary: {}, findings: [] };
const DESIGN_PASS = { story_id: "E1-S1", iteration: 1, timestamp: "t", scores: { cds_modelling: 8, rap_behavior: 8, extensibility_tier: 8, released_api: 8, namespace: 8, blast_radius: 8 }, weighted_average: 8, threshold: 7, verdict: "PASS", failing_criteria: [], grounding: {}, critique: "ok" };

/** write a set of verdicts to a fresh temp dir; returns the dir path */
function seed(verdicts) {
  const dir = mkdtempSync(join(tmpdir(), "ci-gate-"));
  for (const [file, doc] of Object.entries(verdicts)) writeFileSync(join(dir, file), JSON.stringify(doc));
  return dir;
}
const ALL_PASS = {
  "sap-verdict.json": SAP_PASS, "clean-core-verdict.json": CLEAN_PASS,
  "security-verdict.json": SEC_PASS, "diff-review-verdict.json": DIFF_PASS, "design-critique.json": DESIGN_PASS,
};

test("a fully-clean verdict set passes the gate", () => {
  const dir = seed(ALL_PASS);
  try { assert.deepEqual(evaluateGate(dir), { pass: true, blocks: [], warnings: [] }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a BLOCK sap-verdict fails the gate", () => {
  const dir = seed({ ...ALL_PASS, "sap-verdict.json": { ...SAP_PASS, verdict: "BLOCK", failure_layer: "atc" } });
  try { const r = evaluateGate(dir); assert.equal(r.pass, false); assert.match(r.blocks.join(), /sap-verdict.*BLOCK/); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a priority-1 ATC finding fails the gate even on a PASS verdict", () => {
  const dir = seed({ ...ALL_PASS, "sap-verdict.json": { ...SAP_PASS, atc: { ran: true, variant: "v", priority1: [{ object: "ZCL_X", rule: "R", message: "m" }], priority2: [], priority2_3: [] } } });
  try { const r = evaluateGate(dir); assert.equal(r.pass, false); assert.match(r.blocks.join(), /priority-1/); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a priority-2 ATC finding fails the gate (C3: P6 blocks priority-1 AND priority-2)", () => {
  const dir = seed({ ...ALL_PASS, "sap-verdict.json": { ...SAP_PASS, atc: { ran: true, variant: "v", priority1: [], priority2: [{ object: "ZCL_X", rule: "R", message: "m" }] } } });
  try { const r = evaluateGate(dir); assert.equal(r.pass, false); assert.match(r.blocks.join(), /priority-2/); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a pass:false hard verdict (security) fails the gate", () => {
  const dir = seed({ ...ALL_PASS, "security-verdict.json": { ...SEC_PASS, pass: false } });
  try { const r = evaluateGate(dir); assert.equal(r.pass, false); assert.match(r.blocks.join(), /security-verdict.*pass=false/); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a missing hard verdict fails closed", () => {
  const dir = seed({ "clean-core-verdict.json": CLEAN_PASS, "security-verdict.json": SEC_PASS, "diff-review-verdict.json": DIFF_PASS });
  try { const r = evaluateGate(dir); assert.equal(r.pass, false); assert.match(r.blocks.join(), /sap-verdict.*missing/); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a schema-invalid verdict fails closed", () => {
  const dir = seed({ ...ALL_PASS, "sap-verdict.json": { verdict: "PASS" } });
  try { const r = evaluateGate(dir); assert.equal(r.pass, false); assert.match(r.blocks.join(), /invalid shape/); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test("design-critique WARN is a non-blocking warning (SOFT gate); BLOCK blocks", () => {
  const warnDir = seed({ ...ALL_PASS, "design-critique.json": { ...DESIGN_PASS, verdict: "WARN" } });
  try { const r = evaluateGate(warnDir); assert.equal(r.pass, true); assert.match(r.warnings.join(), /design-critique.*WARN/); }
  finally { rmSync(warnDir, { recursive: true, force: true }); }
  const blockDir = seed({ ...ALL_PASS, "design-critique.json": { ...DESIGN_PASS, verdict: "BLOCK" } });
  try { assert.equal(evaluateGate(blockDir).pass, false); }
  finally { rmSync(blockDir, { recursive: true, force: true }); }
});
