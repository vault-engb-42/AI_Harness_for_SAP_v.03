import { test } from "node:test";
import assert from "node:assert/strict";
import { dispositionHint, hintsForFindings } from "../src/node/disposition-hints.js";

// B2-generalisation — the disposition hint layer (operator 2026-07-29). Derives a GENERIC re-architecture
// signal from the analyser's OWN description of a finding (family + message), NOT a hand-picked rule_id list.
// Any rule whose message names a UI construct (dynpro/WRITE/ALV/SmartForms/WebDynpro) → ui_rearch, so a legacy
// archetype the classifier has never literally seen still classifies correctly.

const f = (o) => ({ family: "clean-core", rule_id: "talos-x", message: "", ...o });

test("abaplint findings are always `style` (cosmetic, no re-arch force)", () => {
  assert.equal(dispositionHint(f({ family: "abaplint", rule_id: "line_length", message: "Reduce line length to 120" })), "style");
});

test("ui_rearch: dynpro, WRITE/classic-list, ALV, SmartForms, WebDynpro — across archetypes", () => {
  assert.equal(dispositionHint(f({ rule_id: "talos-s4-004", message: "Dynpro screen flow logic — no successor in ABAP Cloud (S4-004)" })), "ui_rearch");
  assert.equal(dispositionHint(f({ rule_id: "talos-cloud-006-write", message: "WRITE requires the classic list processor — forbidden in ABAP Cloud; use RAP/Fiori (CLOUD-006)" })), "ui_rearch");
  assert.equal(dispositionHint(f({ rule_id: "talos-s4-003-classic-list-output", message: "Classic list output (WRITE:/FORMAT COLOR) — migrate to ALV or Fiori (S4-003)" })), "ui_rearch");
  assert.equal(dispositionHint(f({ rule_id: "talos-cloud-015", message: "REUSE_ALV_GRID_DISPLAY — migrate to cl_salv_table or Fiori Elements (CLOUD-015)" })), "ui_rearch");
  assert.equal(dispositionHint(f({ rule_id: "talos-forms-01", message: "SMARTFORMS print output — migrate to Adobe Forms / Fiori" })), "ui_rearch");
  assert.equal(dispositionHint(f({ rule_id: "talos-cloud-028", message: "Web Dynpro ABAP UI — target RAP/Fiori (CLOUD-028)" })), "ui_rearch");
});

test("os_exec: OPEN DATASET, CALL SYSTEM, frontend services", () => {
  assert.equal(dispositionHint(f({ family: "security", rule_id: "talos-sec-002-open-dataset-var", message: "OPEN DATASET with a variable path (SEC-002)" })), "os_exec");
  assert.equal(dispositionHint(f({ rule_id: "talos-x", message: "cl_gui_frontend_services GUI_DOWNLOAD — no in-stack cloud equivalent" })), "os_exec");
});

test("rfc_rebuild: CALL FUNCTION DESTINATION / IDoc / ALE (cross-system)", () => {
  assert.equal(dispositionHint(f({ rule_id: "talos-x", message: "CALL FUNCTION ... DESTINATION — remote RFC call" })), "rfc_rebuild");
  assert.equal(dispositionHint(f({ rule_id: "talos-x", message: "IDoc inbound processing (ALE)" })), "rfc_rebuild");
});

test("db_refactor: SELECT-in-loop / DDIC read (in-place fixable, no re-arch force)", () => {
  assert.equal(dispositionHint(f({ family: "performance", rule_id: "talos-select-in-loop", message: "SELECT inside LOOP causes N+1 database round-trips" })), "db_refactor");
  assert.equal(dispositionHint(f({ rule_id: "talos-cloud-032-ddic-table-read", message: "Direct SELECT from a SAP-namespace DDIC table — use the released CDS view" })), "db_refactor");
});

test("auth: AUTHORITY-CHECK / DCL", () => {
  assert.equal(dispositionHint(f({ family: "security", rule_id: "talos-x", message: "Missing AUTHORITY-CHECK before the operation" })), "auth");
});

test("a clean-core API swap (CALL FUNCTION, no destination) is NOT re-arch-forcing (falls to target/cleanliness)", () => {
  const h = dispositionHint(f({ family: "clean-core", rule_id: "talos-cloud-001-call-function", message: "CALL FUNCTION is forbidden in generated ABAP Cloud code — use a released API method call (CLOUD-001)" }));
  assert.ok(!["ui_rearch", "os_exec"].includes(h), "CALL FUNCTION (no destination) does not force re-architecture");
});

test("hintsForFindings returns the sorted DISTINCT hint set of an object's findings", () => {
  const hs = hintsForFindings([
    { family: "abaplint", rule_id: "line_length", message: "x" },
    { rule_id: "talos-cloud-006-write", message: "WRITE requires the classic list processor" },
    { rule_id: "talos-cloud-006-write", message: "WRITE requires the classic list processor" }, // dup
  ]);
  assert.deepEqual(hs, ["style", "ui_rearch"]);
});
