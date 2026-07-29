import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDisposition } from "../src/plan/disposition.js";
import { DISPOSITIONS } from "../src/plan/disposition-enum.js";

// B2 — the disposition classifier (MODERNISER_DESIGN §6.11, BUILD_PLAN B2/S3). PURE over (node, cache):
// the S3 signal map + confidence × grounding-certainty + θ = DISPOSITION_AUTO_THRESHOLD (0.9). Only a
// released-clean refactor with high grounding certainty is `auto`; everything else prompts.

const node = (o = {}) => ({
  object: "Z", kind: "class", finding_families: [], driving_rule_ids: [],
  member_meta: { Z: { grade: "C", complexity: 1, blast: 0 } }, modernization_target: null, ...o,
});
const OUT_KEYS = [
  "disposition", "disposition_rationale", "disposition_target",
  "disposition_confidence", "disposition_reversible", "disposition_autonomy",
].sort();

test("output shape: exactly the six disposition_* fields; disposition ∈ enum; confidence ∈ [0,1]; deterministic", () => {
  const n = node({ driving_rule_ids: ["talos-cloud-006-write"], modernization_target: "Fiori Elements App" });
  const d = classifyDisposition(n, {});
  assert.deepEqual(Object.keys(d).sort(), OUT_KEYS);
  assert.ok(DISPOSITIONS.includes(d.disposition), "disposition is a taxonomy member");
  assert.ok(d.disposition_confidence >= 0 && d.disposition_confidence <= 1, "confidence in [0,1]");
  assert.equal(JSON.stringify(d), JSON.stringify(classifyDisposition(n, {})), "deterministic");
});

test("a dynamically-sealed node → seal (prompt, never auto)", () => {
  const d = classifyDisposition(node({ dynamic_seal: "NEEDS_MANUAL_SEAM" }), {});
  assert.equal(d.disposition, "seal");
  assert.equal(d.disposition_autonomy, "prompt");
});

test("classic-UI signal (WRITE / legacy-UI) → re_architect (prompt, irreversible)", () => {
  const d = classifyDisposition(node({ driving_rule_ids: ["talos-cloud-006-write", "talos-legacy-ui-rollup"], modernization_target: "Fiori Elements App" }), {});
  assert.equal(d.disposition, "re_architect");
  assert.equal(d.disposition_autonomy, "prompt");
  assert.equal(d.disposition_reversible, false);
});

test("OS-exec signal (OPEN DATASET) → re_architect (prompt) — no in-stack cloud equivalent", () => {
  const d = classifyDisposition(node({ driving_rule_ids: ["talos-sec-002-open-dataset-var"], modernization_target: "OData V4 Service" }), {});
  assert.equal(d.disposition, "re_architect");
  assert.equal(d.disposition_autonomy, "prompt");
});

test("released-standard-exists grounding hit → replace (prompt)", () => {
  const d = classifyDisposition(node({ modernization_target: "RAP Business Object" }), { Z: { released_standard_exists: true, grounding_certainty: 0.95 } });
  assert.equal(d.disposition, "replace");
  assert.equal(d.disposition_reversible, false);
});

test("released-API-clean with HIGH grounding certainty → refactor (AUTO)", () => {
  const d = classifyDisposition(node({ modernization_target: "RAP Business Object" }), { Z: { released_clean: true, grounding_certainty: 1 } });
  assert.equal(d.disposition, "refactor");
  assert.equal(d.disposition_reversible, true);
  assert.equal(d.disposition_autonomy, "auto", "reversible ∧ confidence≥0.9 ∧ refactor");
});

test("released-clean but LOW grounding certainty → refactor but PROMPT (θ=0.9 gate)", () => {
  const d = classifyDisposition(node(), { Z: { released_clean: true, grounding_certainty: 0.8 } });
  assert.equal(d.disposition, "refactor");
  assert.equal(d.disposition_autonomy, "prompt");
});

test("empty-signal FM with an OData target → re_architect, NOT refactor(auto) (zapcommander remediation)", () => {
  const d = classifyDisposition(node({ kind: "function", finding_families: [], driving_rule_ids: [], modernization_target: "OData V4 Service" }), {});
  assert.equal(d.disposition, "re_architect", "target drives it — absence of findings is NOT cleanliness");
  assert.notEqual(d.disposition_autonomy, "auto");
});

test("a RAP/CDS/OData/Fiori modernization_target (no other signal) → re_architect (prompt)", () => {
  for (const t of ["RAP Business Object", "RAP Interface", "OData V4 Service", "Fiori Elements App"]) {
    const d = classifyDisposition(node({ modernization_target: t }), {});
    assert.equal(d.disposition, "re_architect", t);
  }
});

test("no signal + no target + not clean → seal (low-confidence prompt)", () => {
  const d = classifyDisposition(node({ modernization_target: null }), {});
  assert.equal(d.disposition, "seal");
  assert.equal(d.disposition_autonomy, "prompt");
  assert.ok(d.disposition_confidence < 0.5, "low confidence");
});
