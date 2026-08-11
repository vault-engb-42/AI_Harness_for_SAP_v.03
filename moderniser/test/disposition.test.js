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
  // P1: the registry-grounded basis behind the gate's OPTIONS (no_successor_refs / standard_domains).
  // It informs the human's choice; it never changes the recommendation above.
  "disposition_evidence",
].sort();

test("output shape: exactly the seven disposition_* fields; disposition ∈ enum; confidence ∈ [0,1]; deterministic", () => {
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

// rfc_rebuild — cross-system integration (RFC/DESTINATION/IDoc/ALE). Routes to re_architect (the in-stack
// released-communication default), NOT rebuild: `rebuild` is the app-blueprint's grounded app-level promotion
// (B3.5, §935), never a per-object B2 output. This is the generalisation fix (ratified 2026-07-29, §186) — an
// integration object gets a true-modernisation disposition regardless of whether the analyser set a target.
test("rfc_rebuild hint with NO target → re_architect (prompt) — never seals for want of a target", () => {
  const d = classifyDisposition(node({ object_kind: "function", disposition_hints: ["rfc_rebuild"], modernization_target: null }), {});
  assert.equal(d.disposition, "re_architect", "cross-system → in-stack re-arch default, independent of target presence");
  assert.equal(d.disposition_autonomy, "prompt");
  assert.notEqual(d.disposition, "seal", "must NOT degrade to seal — that is the port-or-seal failure the generalisation fix removes");
  assert.notEqual(d.disposition, "rebuild", "rebuild is a B3.5 app-level promotion, never a per-object B2 output (§935)");
});

test("rfc_rebuild with a RAP target → re_architect (NOT rebuild) — the heaviest disposition is a B3.5 call", () => {
  const d = classifyDisposition(node({ object_kind: "class", disposition_hints: ["rfc_rebuild"], modernization_target: "RAP Business Object" }), {});
  assert.equal(d.disposition, "re_architect");
});

test("a retain-kind INTERFACE carrying an rfc_rebuild hint STAYS refactor (role-aware invariant: rfc_rebuild is below retain-kind)", () => {
  const d = classifyDisposition(node({ object_kind: "interface", object: "ZAPCMD_IF_RFC", disposition_hints: ["rfc_rebuild"], modernization_target: "RAP Interface" }), {});
  assert.equal(d.disposition, "refactor", "an integration interface is structurally retained, RFC signal notwithstanding");
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

// D2 (adversarial-review hardening 2026-07-29) — isRetainKind must key on the SAP exception-class naming
// convention (CX_ prefix, incl. Y-namespace + registered namespaces), NOT an over-broad `_ERROR$` suffix.
test("D2: a Y-namespace exception class YCX_* → refactor (retain broadened beyond ZCX_)", () => {
  const d = classifyDisposition(node({ object_kind: "class", object: "YCX_APP_EXCEPTION", disposition_hints: ["rfc_rebuild"], modernization_target: "RAP Business Object" }), {});
  assert.equal(d.disposition, "refactor", "a genuine Y-namespace exception class is structurally retained");
});
test("D2: a registered-namespace exception class /NS/CX_* → refactor", () => {
  const d = classifyDisposition(node({ object_kind: "class", object: "/ACME/CX_FOO", modernization_target: "RAP Business Object" }), {});
  assert.equal(d.disposition, "refactor");
});
test("D2: a business class ending _ERROR is NOT retained → re_architect via its RAP target (over-match fixed)", () => {
  const d = classifyDisposition(node({ object_kind: "class", object: "ZCL_ORDER_ERROR", modernization_target: "RAP Business Object" }), {});
  assert.equal(d.disposition, "re_architect", "an ordinary business class named ..._ERROR must not be falsely retained");
});
test("D2: the ZCX_ exception convention still retained (zapcommander baseline)", () => {
  const d = classifyDisposition(node({ object_kind: "class", object: "ZCX_ZAPCMD_ERROR", modernization_target: "RAP Business Object" }), {});
  assert.equal(d.disposition, "refactor");
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

// RC-2 (root-cause analysis of the 2026-08-11 ARCH_REVIEW). NINE of the fifteen failed recommendations rode
// one branch: `analyser target "..." — re-architect to Cloud`, confidence 0.7. That is the analyser's COARSE
// LABEL deciding what happens to an object — the exact thing the patterns corpus forbids for shape selection
// ("a coarse modernization_target never dictates the shape — the structural evidence does") while disposition
// obeyed it unconditionally. The analyser labels a demo program "Fiori Elements App" because it draws a grid.
//
// The label may now CONFIRM structure; it may not invent it. An object the CPG shows to have no surface and
// no data of its own is sealed for manual review instead, whatever the label says.
//
// `structure` is fail-SAFE: absent means "not known", not "known to be absent", so a caller that cannot
// supply CPG evidence gets exactly the old behaviour rather than a silent mass re-disposition.
test("RC-2 the coarse analyser target does NOT re-architect an object with no structure at all", () => {
  const d = classifyDisposition(node({ modernization_target: "Fiori Elements App" }), {}, {
    consumption: ["no_surface_evidence"], persistence: ["no_persistence_evidence"],
  });
  assert.equal(d.disposition, "seal", `a label is not evidence: ${d.disposition_rationale}`);
  assert.match(d.disposition_rationale, /no surface and no data/i);
  assert.ok(d.disposition_confidence < 0.5, "and it is not a confident call");
});

test("RC-2 the same label DOES re-architect once the CPG corroborates it", () => {
  for (const structure of [
    { consumption: ["ui_salv"], persistence: ["no_persistence_evidence"] },
    { consumption: ["no_surface_evidence"], persistence: ["owns_customer_table"] },
  ]) {
    const d = classifyDisposition(node({ modernization_target: "RAP Business Object" }), {}, structure);
    assert.equal(d.disposition, "re_architect", `corroborated: ${JSON.stringify(structure)}`);
  }
});

test("RC-2 unknown structure is not absent structure — an uninformed caller keeps the old answer", () => {
  const d = classifyDisposition(node({ modernization_target: "RAP Business Object" }), {});
  assert.equal(d.disposition, "re_architect", "fail-safe: absence of evidence is not evidence of absence");
});

test("RC-2 a HARD structural signal still outranks the structure check", () => {
  // ui_rearch is a finding-derived verdict about the object's own code; it decides before the label branch
  // is ever reached, so a screen-bearing object is never sealed for want of a CPG edge.
  const d = classifyDisposition(node({ disposition_hints: ["ui_rearch"], modernization_target: "Fiori Elements App" }), {}, {
    consumption: ["no_surface_evidence"], persistence: ["no_persistence_evidence"],
  });
  assert.equal(d.disposition, "re_architect");
});
