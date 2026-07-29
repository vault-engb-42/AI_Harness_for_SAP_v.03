import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDisposition } from "../src/plan/disposition.js";
import { DISPOSITIONS } from "../src/plan/disposition-enum.js";

// B2 — the disposition classifier (MODERNISER_DESIGN §6.11, BUILD_PLAN B2/S3). PURE over (node, cache):
// the S3 signal map + confidence × grounding-certainty + θ = DISPOSITION_AUTO_THRESHOLD (0.9). Only a
// released-clean refactor with high grounding certainty is `auto`; everything else prompts.

const node = (o = {}) => ({
  object: "Z", object_kind: "class", finding_families: [], driving_rule_ids: [], disposition_hints: [],
  member_meta: { Z: { grade: "C", complexity: 1, blast: 0 } }, modernization_target: null, ...o,
});
const OUT_KEYS = [
  "disposition", "disposition_rationale", "disposition_target",
  "disposition_confidence", "disposition_reversible", "disposition_autonomy",
].sort();

test("output shape: exactly the six disposition_* fields; disposition ∈ enum; confidence ∈ [0,1]; deterministic", () => {
  const n = node({ disposition_hints: ["ui_rearch"], modernization_target: "Fiori Elements App" });
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

test("ui_rearch hint → re_architect (prompt, irreversible) — archetype-agnostic (dynpro/WRITE/ALV/SmartForms all map here)", () => {
  const d = classifyDisposition(node({ disposition_hints: ["ui_rearch"], modernization_target: "Fiori Elements App" }), {});
  assert.equal(d.disposition, "re_architect");
  assert.equal(d.disposition_autonomy, "prompt");
  assert.equal(d.disposition_reversible, false);
});

test("os_exec hint (OPEN DATASET / frontend services) → re_architect (prompt) — no in-stack cloud equivalent", () => {
  const d = classifyDisposition(node({ disposition_hints: ["os_exec"], modernization_target: "OData V4 Service" }), {});
  assert.equal(d.disposition, "re_architect");
  assert.equal(d.disposition_autonomy, "prompt");
});

test("released-standard-exists grounding hit → replace (prompt)", () => {
  const d = classifyDisposition(node({ modernization_target: "RAP Business Object" }), { Z: { released_standard_exists: true, grounding_certainty: 0.95 } });
  assert.equal(d.disposition, "replace");
  assert.equal(d.disposition_reversible, false);
});

test("released-API-clean, NO re-arch target, HIGH grounding certainty → refactor (AUTO)", () => {
  const d = classifyDisposition(node({ modernization_target: null }), { Z: { released_clean: true, grounding_certainty: 1 } });
  assert.equal(d.disposition, "refactor");
  assert.equal(d.disposition_reversible, true);
  assert.equal(d.disposition_autonomy, "auto", "reversible ∧ confidence≥0.9 ∧ refactor");
});

// Role-aware balance (evidence: zapcommander 2026-07-29) — retain-kinds refactor; clean logic classes champion re-arch.
test("a retain-kind INTERFACE → refactor, even with a RAP target (interfaces are structurally retained)", () => {
  const d = classifyDisposition(node({ object_kind: "interface", object: "ZAPCMD_IF_FACTORY", modernization_target: "RAP Interface" }), {});
  assert.equal(d.disposition, "refactor");
});

test("a retain-kind EXCEPTION class (ZCX_*) → refactor, even with a RAP BO target", () => {
  const d = classifyDisposition(node({ object_kind: "class", object: "ZCX_ZAPCMD_ERROR", modernization_target: "RAP Business Object" }), { ZCX_ZAPCMD_ERROR: { released_clean: true, grounding_certainty: 1 } });
  assert.equal(d.disposition, "refactor", "an exception class is never re-architected into a RAP BO");
});

test("a CLEAN logic class WITH a re-arch target → re_architect (champion), not refactor", () => {
  const d = classifyDisposition(node({ object_kind: "class", object: "ZAPCMD_CL_DIR", modernization_target: "RAP Business Object" }), { ZAPCMD_CL_DIR: { released_clean: true, grounding_certainty: 1 } });
  assert.equal(d.disposition, "re_architect", "a clean business/logic class in a RAP app should become a RAP BO");
  assert.equal(d.disposition_autonomy, "prompt", "re_architect never auto-applies");
});

test("released-clean but LOW grounding certainty → refactor but PROMPT (θ=0.9 gate)", () => {
  const d = classifyDisposition(node(), { Z: { released_clean: true, grounding_certainty: 0.8 } });
  assert.equal(d.disposition, "refactor");
  assert.equal(d.disposition_autonomy, "prompt");
});

test("empty-signal FM with an OData target → re_architect, NOT refactor(auto) (zapcommander remediation)", () => {
  const d = classifyDisposition(node({ object_kind: "function", finding_families: [], driving_rule_ids: [], modernization_target: "OData V4 Service" }), {});
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
