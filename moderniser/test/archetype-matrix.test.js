import { test } from "node:test";
import assert from "node:assert/strict";
import { assemblePlan } from "../src/sched/assemble.js";
import { dispositionHint } from "../src/node/disposition-hints.js";

// B2-generalisation step 2 — the per-archetype FIXTURE MATRIX (operator directive 2026-07-29). The
// calibration/regression harness (role B of the three-input model): one small, licence-clean synthetic
// analyser-findings doc per LEGACY ABAP archetype, each asserting BOTH the derived disposition_hint (unit) AND
// the end-to-end assemblePlan disposition. The classifier reasons on a hint derived from the analyser's OWN
// finding message (node/disposition-hints.js), so an archetype the two example fixtures (abap_fico,
// zapcommander) never exercised still classifies correctly. A miss here is a CALIBRATION signal — tune the
// hint patterns; never overfit to a fixture.
//
// Routing (ratified 2026-07-29, BUILD_PLAN §186): ui_rearch / os_exec / rfc_rebuild → re_architect. Cross-system
// integration takes the in-stack released-communication default; `rebuild` (side-by-side/BTP, §935-gated) is the
// app-blueprint's grounded, app-level promotion at B3.5 — NEVER a per-object B2 output. db_refactor / auth on a
// clean, target-less object → in-place refactor. No archetype degrades to `seal` for want of a target.

const OBJ = "ZARCH_OBJ";
const doc = ({ target, kind, finding }) => ({
  findings: [{ object: OBJ, ...finding }],
  graph: { nodes: [{ id: OBJ, object: OBJ, kind, namespace: "Z" }], edges: [] },
  modernization_plan: {
    objects: [{
      object: OBJ, kind, transformation_count: 1, transformations: [{ rule_id: finding.rule_id }],
      migration_complexity: 0, modernization_target: target,
    }],
  },
});

// Each row: a realistic per-archetype finding message → the hint its message must derive → the end-to-end
// disposition. `target: null` rows prove the generalisation guarantee (no target ≠ seal).
const MATRIX = [
  { name: "dynpro / module-pool screen", kind: "report", target: "Fiori Elements App",
    finding: { rule_id: "talos-s4-004", family: "deprecation", atc_priority: "P1", message: "Dynpro screen flow logic — no successor in ABAP Cloud (S4-004)" },
    hint: "ui_rearch", disposition: "re_architect" },
  { name: "classic list output (WRITE)", kind: "report", target: "Fiori Elements App",
    finding: { rule_id: "talos-cloud-006-write", family: "deprecation", atc_priority: "P1", message: "WRITE to the classic list processor — forbidden in ABAP Cloud; use RAP/Fiori (CLOUD-006)" },
    hint: "ui_rearch", disposition: "re_architect" },
  { name: "ALV via function module (REUSE_ALV_GRID_DISPLAY)", kind: "report", target: "Fiori Elements App",
    finding: { rule_id: "talos-cloud-015", family: "clean-core", atc_priority: "P2", message: "REUSE_ALV_GRID_DISPLAY — migrate to cl_salv_table or Fiori Elements (CLOUD-015)" },
    hint: "ui_rearch", disposition: "re_architect" },
  { name: "ALV object-oriented (cl_salv_table)", kind: "class", target: "Fiori Elements App",
    finding: { rule_id: "talos-cloud-016", family: "clean-core", atc_priority: "P2", message: "ALV grid via cl_salv_table — migrate to Fiori Elements" },
    hint: "ui_rearch", disposition: "re_architect" },
  { name: "Web Dynpro ABAP", kind: "report", target: "Fiori Elements App",
    finding: { rule_id: "talos-cloud-028", family: "deprecation", atc_priority: "P1", message: "Web Dynpro ABAP UI — target RAP/Fiori (CLOUD-028)" },
    hint: "ui_rearch", disposition: "re_architect" },
  { name: "BSP application", kind: "report", target: "Fiori Elements App",
    finding: { rule_id: "talos-cloud-029", family: "deprecation", atc_priority: "P1", message: "BSP application UI — legacy; target Fiori Elements" },
    hint: "ui_rearch", disposition: "re_architect" },
  // SmartForms: the classifier is READY — the ui_rearch regex covers smart-form/sapscript/adobe-form. The gap is
  // ANALYSER coverage (talos-catalog.json has 0 ui_forms rules, so the analyser never emits this finding yet;
  // [[analyser-rap-awareness-backlog]] item 6). This row proves the classifier handles it the moment it IS emitted.
  { name: "SmartForms (classifier ready; analyser-coverage gap)", kind: "report", target: "Fiori Elements App",
    finding: { rule_id: "talos-forms-01", family: "deprecation", atc_priority: "P1", message: "SMARTFORMS print output — migrate to Adobe Forms / Fiori" },
    hint: "ui_rearch", disposition: "re_architect" },
  { name: "OS/file exec (OPEN DATASET)", kind: "class", target: "OData V4 Service",
    finding: { rule_id: "talos-sec-002-open-dataset-var", family: "security", atc_priority: "P1", message: "OPEN DATASET with a variable path (SEC-002)" },
    hint: "os_exec", disposition: "re_architect" },
  { name: "cross-system RFC (CALL FUNCTION DESTINATION)", kind: "function", target: "RAP Business Object",
    finding: { rule_id: "talos-cloud-020", family: "clean-core", atc_priority: "P2", message: "CALL FUNCTION 'Z_REMOTE' DESTINATION lv_rfc — remote RFC call" },
    hint: "rfc_rebuild", disposition: "re_architect" },
  // GENERALISATION — a cross-system object with NO analyser target still gets a true-modernisation disposition
  // (re_architect), never `seal`. rebuild would be the app-blueprint's call at B3.5, not B2's.
  { name: "IDoc/ALE inbound, no target (generalisation)", kind: "function", target: null,
    finding: { rule_id: "talos-cloud-021", family: "clean-core", atc_priority: "P2", message: "IDoc inbound processing (ALE) — cross-system integration" },
    hint: "rfc_rebuild", disposition: "re_architect" },
  { name: "DB access (SELECT-in-loop), clean, no target", kind: "class", target: null,
    finding: { rule_id: "talos-perf-select-loop", family: "performance", atc_priority: "P2", message: "SELECT inside LOOP causes N+1 database round-trips" },
    hint: "db_refactor", disposition: "refactor" },
  { name: "authorization (AUTHORITY-CHECK), clean, no target", kind: "class", target: null,
    finding: { rule_id: "talos-sec-010", family: "security", atc_priority: "P2", message: "Missing AUTHORITY-CHECK before the sensitive operation" },
    hint: "auth", disposition: "refactor" },
];

for (const row of MATRIX) {
  test(`hint · ${row.name} → ${row.hint}`, () => {
    assert.equal(dispositionHint(row.finding), row.hint, `${row.name}: the analyser message must derive ${row.hint}`);
  });
  test(`disposition · ${row.name} → ${row.disposition}`, () => {
    const { plan } = assemblePlan(doc(row));
    const n = plan.nodes.find((x) => x.object === OBJ);
    assert.ok(n.disposition_hints.includes(row.hint), `${row.name}: the ${row.hint} hint rides the node`);
    assert.equal(n.disposition, row.disposition, `${row.name}: end-to-end disposition`);
    if (row.disposition === "re_architect") assert.equal(n.disposition_autonomy, "prompt", "re_architect never auto-applies");
  });
}

// The load-bearing generalisation guarantee, asserted across the whole matrix.
test("GUARANTEE: every archetype gets a true-modernisation disposition — none seals, none emits rebuild in B2", () => {
  for (const row of MATRIX) {
    const { plan } = assemblePlan(doc(row));
    const n = plan.nodes.find((x) => x.object === OBJ);
    assert.notEqual(n.disposition, "seal", `${row.name} must not degrade to seal`);
    assert.notEqual(n.disposition, "rebuild", `${row.name}: rebuild is a B3.5 app-level promotion, never a per-object B2 output`);
  }
});
