import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validateVerdict } from "../verdict-schema.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// GAP#1a — harden the gate-verdict contract. The five specs/reviews/*-verdict.json
// files are LLM-agent-emitted to a prose schema; this validator (mirroring
// analyser/src/validate-findings.js, in-house, no ajv) is the strict contract any
// downstream adapter (CI gate, ALM ticketing) can trust. Real shapes, no mocks.

const SAP_OK = {
  verdict: "PASS", timestamp: "2026-07-07T00:00:00Z", connection: "DEV",
  objects: ["ZCL_X"], failure_layer: null,
  activation: { activated: ["ZCL_X"], errors: [] },
  atc: { ran: true, variant: "ABAP_CLEAN_CORE_DEVELOPMENT", priority1: [], priority2_3: [] },
  abap_unit: { ran: true, failed: [], coverage_pct: 80, coverage_baseline_pct: 75 },
  clean_core_level: "A",
  invariant_diff: { authority_check_weakened: false, commit_work_suppressed: false, sy_subrc_check_dropped: false },
  ratchet: { atc_regressed: false, coverage_regressed: false }, notes: "",
};
const CLEAN_OK = {
  gate: "clean-core", pass: true,
  atc: { variant: "ABAP_CLEAN_CORE_DEVELOPMENT", completed: true, priority_1: 0 },
  grounding: { migration_analysis_checked: [], not_to_be_released: [], deprecated: [], unconfirmed: [] },
  summary: { block: 0, warn: 0, info: 0 }, findings: [],
};
const SEC_OK = {
  gate: "security", pass: true, block_severities: ["critical", "high"],
  invariants: { authority_check: "ok", commit_work: "ok", sy_subrc: "ok", baseline_established: true },
  summary: { inv: 0, block: 0, warn: 0, info: 0 }, findings: [],
};
const DESIGN_OK = {
  story_id: "E1-S1", iteration: 1, timestamp: "2026-07-07T00:00:00Z",
  scores: { cds_modelling: 8, rap_behavior: 8, extensibility_tier: 8, released_api: 9, namespace: 8, blast_radius: 7 },
  weighted_average: 8.0, threshold: 7, verdict: "PASS", failing_criteria: [],
  grounding: { migration_analysis_checked: [], unreleased_dependencies: [] }, critique: "clean",
};
const DIFF_OK = {
  gate: "abap-diff-review", pass: true, range: "HEAD~1..HEAD",
  acceptance_criteria_source: "specs/stories/E1-S1.md", summary: { block: 0, warn: 0, info: 0 }, findings: [],
};

test("each verdict kind validates its canonical shape", () => {
  for (const [kind, doc] of [["sap", SAP_OK], ["clean-core", CLEAN_OK], ["security", SEC_OK], ["design-critique", DESIGN_OK], ["diff-review", DIFF_OK]]) {
    const r = validateVerdict(kind, doc);
    assert.equal(r.valid, true, `${kind} should be valid: ${r.errors.join("; ")}`);
  }
});

test("an unknown verdict kind is rejected", () => {
  assert.equal(validateVerdict("nope", {}).valid, false);
});

test("the JSON-Schema companion is valid and defines all five verdict shapes", () => {
  const schema = JSON.parse(readFileSync(join(HERE, "..", "..", ".claude", "schemas", "verdict.schema.json"), "utf8"));
  for (const def of ["sapVerdict", "cleanCoreVerdict", "securityVerdict", "designCritique", "diffReviewVerdict"]) {
    assert.ok(schema.$defs[def], `schema missing $defs.${def}`);
  }
});

test("sap-verdict: verdict is a PASS/WARN/BLOCK enum; failure_layer null is allowed on PASS", () => {
  assert.equal(validateVerdict("sap", { ...SAP_OK, verdict: "MAYBE" }).valid, false);
  assert.equal(validateVerdict("sap", SAP_OK).valid, true, "failure_layer:null must not read as missing");
  assert.match(validateVerdict("sap", { ...SAP_OK, failure_layer: "gremlins" }).errors.join(), /failure_layer/);
});

test("sap-verdict: missing invariant_diff and non-boolean invariant flags are caught", () => {
  const noInv = { ...SAP_OK }; delete noInv.invariant_diff;
  assert.equal(validateVerdict("sap", noInv).valid, false);
  assert.match(validateVerdict("sap", { ...SAP_OK, invariant_diff: { authority_check_weakened: "no", commit_work_suppressed: false, sy_subrc_check_dropped: false } }).errors.join(), /authority_check_weakened/);
});

test("sap-verdict: clean_core_level and atc.priority1 shape are enforced", () => {
  assert.match(validateVerdict("sap", { ...SAP_OK, clean_core_level: "B" }).errors.join(), /clean_core_level/);
  assert.match(validateVerdict("sap", { ...SAP_OK, atc: { ran: true, variant: "x", priority1: "none", priority2_3: [] } }).errors.join(), /priority1/);
});

test("pass-style verdicts require gate const + boolean pass", () => {
  assert.match(validateVerdict("clean-core", { ...CLEAN_OK, gate: "wrong" }).errors.join(), /gate/);
  assert.match(validateVerdict("security", { ...SEC_OK, pass: "true" }).errors.join(), /pass/);
  const noPass = { ...DIFF_OK }; delete noPass.pass;
  assert.equal(validateVerdict("diff-review", noPass).valid, false);
});

test("security-verdict requires the three invariant values + baseline flag", () => {
  const noInv = { ...SEC_OK }; delete noInv.invariants;
  assert.equal(validateVerdict("security", noInv).valid, false);
  assert.match(validateVerdict("security", { ...SEC_OK, invariants: { authority_check: "ok", commit_work: "ok", sy_subrc: "ok", baseline_established: "yes" } }).errors.join(), /baseline_established/);
});

test("finding level enum is enforced on pass-style verdicts", () => {
  const bad = { ...CLEAN_OK, findings: [{ id: "F1", level: "SEVERE", object: "ZCL_X" }] };
  assert.match(validateVerdict("clean-core", bad).errors.join(), /level/);
});

test("design-critique verdict enum (SOFT gate keeps WARN valid)", () => {
  assert.equal(validateVerdict("design-critique", { ...DESIGN_OK, verdict: "WARN" }).valid, true);
  assert.match(validateVerdict("design-critique", { ...DESIGN_OK, verdict: "OK" }).errors.join(), /verdict/);
  const noScores = { ...DESIGN_OK }; delete noScores.scores;
  assert.equal(validateVerdict("design-critique", noScores).valid, false);
});
