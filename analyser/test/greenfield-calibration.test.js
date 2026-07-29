import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { analyzePackage } from "../src/orchestrator.js";
import { validateFindings } from "../src/validate-findings.js";

/**
 * A4 — GREENFIELD CALIBRATION FIXTURE.
 *
 * A known-good, Level-A RAP business object that deliberately exercises the four RAP idioms the
 * brownfield analyser used to MISFLAG:
 *   - `EML MODIFY ENTITIES ... IN LOCAL MODE` inside a behavior pool  (the same-BO RAP norm)
 *   - a DCL `where ( field ) = aspect pfcg_auth( ... )` grant          (DCL grammar, not dynamic SQL)
 *   - a custom entity with `@ObjectModel.query.implementedBy` + `#NOT_REQUIRED` (auth in the query class)
 *   - an ETag-guarded managed draft BDEF                              (no fabricated @Locking.timeoutSeconds)
 *
 * Known-good output must produce ZERO false platform-blockers. This is a permanent regression fixture:
 * it fails if A1 (no fabrication-inducing rule), A2 (RAP-context gating) or A3 (platform readiness kept
 * separate from code quality) ever regress. Any hard finding here is a real generator bug OR an analyser
 * false-positive to fix.
 */

const FIX = join(dirname(fileURLToPath(import.meta.url)), "greenfield-fixtures");
const read = (name) => ({ filename: name, source: readFileSync(join(FIX, name), "utf8") });
const FILES = [
  read("zi_cal.ddls.asddls"),
  read("zi_cal.dcls.asdcls"),
  read("zi_cal.bdef.asbdef"),
  read("zbp_cal.clas.abap"),
  read("zi_calq.ddls.asddls"),
];
const OPTS = { source_system: "DEV100", package: "ZCAL", generated_at: "2026-07-29T00:00:00Z" };
const doc = analyzePackage(FILES, OPTS);

// The RAP idioms the analyser must NOT flag on well-formed Cloud code.
const GATED_FP_RULES = [
  "talos-eml-local-mode-outside-test",
  "talos-perf-73-eml-local-mode",
  "talos-dynamic-where-subquery",
  "talos-cds-auth-not-required",
  "talos-rap-draft-lock-no-timeout",
];

test("calibration: the clean greenfield fixture has ZERO false platform-blockers (P1)", () => {
  const p1 = doc.findings.filter((f) => f.severity === "priority-1");
  assert.deepEqual(
    p1.map((f) => `${f.rule_id}@${f.file}:${f.line}`),
    [],
    "no priority-1 finding on known-good Level-A output",
  );
});

test("calibration: none of the RAP-idiom false-positive rules fire (A1 + A2)", () => {
  const fired = doc.findings.filter((f) => GATED_FP_RULES.includes(f.rule_id)).map((f) => f.rule_id);
  assert.deepEqual(fired, [], `RAP idioms wrongly flagged: ${fired.join(", ")}`);
});

test("calibration: platform readiness is 100% and is reported separately from code quality (A3)", () => {
  assert.equal(doc.s4_readiness.s4_readiness_pct, 100, "platform S/4 readiness clean");
  assert.equal(doc.s4_readiness.cloud_readiness_pct, 100, "platform Cloud readiness clean");
  // Code quality is its own dimension (code_health), NOT folded into platform readiness.
  assert.ok(doc.code_health && typeof doc.code_health === "object", "code quality is a distinct output");
});

test("calibration: the document is schema-valid and deterministic", () => {
  const { valid, errors } = validateFindings(doc);
  assert.ok(valid, errors.join("; "));
  assert.equal(JSON.stringify(analyzePackage(FILES, OPTS)), JSON.stringify(doc));
});
