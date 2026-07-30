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

// Adversarial-review hardening (2026-07-29). Precision fixes for over/under-matching found by the independent
// generalisation review on REAL analyser rule messages — the two example fixtures were blind to these.

// D1 — the ui_rearch WRITE token must be the ABAP WRITE *statement*, not the English verb "write" in prose.
// 5 real analyser rules (ABAP-PERF-79, direct-table-write, strict-direct-db, …) carry "write" in remediation prose.
test("D1: a real perf rule whose prose contains 'write inline' → NOT ui_rearch (ABAP-PERF-79)", () => {
  const h = dispositionHint(f({ family: "rap-odata", rule_id: "talos-rap-update-task-in-late-save", message: "CALL FUNCTION ... IN UPDATE TASK inside the ADJUST_NUMBERS/SAVE phase queues work past the LUW boundary — write inline in SAVE (ABAP-PERF-79)." }));
  assert.notEqual(h, "ui_rearch", "the English verb 'write' must not force re-architecture");
});
test("D1: a direct-table-write clean-core finding → NOT ui_rearch", () => {
  assert.notEqual(dispositionHint(f({ family: "clean-core", rule_id: "talos-cloud-021-direct-table-write", message: "Direct write to a persistent table bypasses the buffer; use the released API" })), "ui_rearch");
});
test("D1: an AUTHORITY-CHECK finding whose prose contains 'write' → auth (not ui_rearch)", () => {
  assert.equal(dispositionHint(f({ family: "security", message: "Missing AUTHORITY-CHECK before the write operation" })), "auth");
});
test("D1: the ABAP WRITE list STATEMENT still → ui_rearch (WRITE: / WRITE /)", () => {
  assert.equal(dispositionHint(f({ rule_id: "talos-s4-003", message: "Classic list output: WRITE: / at 10 'x' — migrate to ALV or Fiori (S4-003)" })), "ui_rearch");
});

// D3 — rfc_rebuild must be the cross-system CALL FUNCTION ... DESTINATION / IDoc / ALE *construct*, not the BTP
// "Destination service" noun, a dead SFW probe named "…RFC…", or the CSV standard "RFC 4180".
test("D3: a dead Switch-Framework RFC probe → NOT rfc_rebuild", () => {
  assert.notEqual(dispositionHint(f({ family: "deprecation", rule_id: "talos-cloud-033-sfw-rfc-get-bfs", message: "Switch Framework bulk-probe RFC 'SFW_BF_GET_BFS' — forbidden in ABAP Cloud; BF state is fixed per release" })), "rfc_rebuild");
});
test("D3: an 'RFC 4180' CSV-standard mention → NOT rfc_rebuild", () => {
  assert.notEqual(dispositionHint(f({ family: "quality", message: "CSV output does not comply with RFC 4180 quoting rules" })), "rfc_rebuild");
});
test("D3: an HTTP 'Destination service' noun (create_by_url) → NOT rfc_rebuild", () => {
  assert.notEqual(dispositionHint(f({ family: "performance", rule_id: "talos-perf-44", message: "HTTP destination created by URL instead of a communication arrangement; use cl_http_destination_provider=>create_by_comm_arrangement" })), "rfc_rebuild");
});
test("D3: a genuine CALL FUNCTION ... DESTINATION still → rfc_rebuild", () => {
  assert.equal(dispositionHint(f({ rule_id: "talos-perf-18", message: "CALL FUNCTION 'Z_REMOTE' DESTINATION lv_dest — synchronous remote call" })), "rfc_rebuild");
});
test("D3: IDoc / ALE still → rfc_rebuild", () => {
  assert.equal(dispositionHint(f({ message: "IDoc inbound processing (ALE) — cross-system integration" })), "rfc_rebuild");
});

// Data-driven hint (2026-07-30, operator priority): the analyser now tags each re-arch-forcing rule with a
// `disposition_hint` at emission; the moderniser PREFERS the tag (robust to message wording), regex = fallback.
test("DATA-DRIVE: a finding's disposition_hint tag WINS over the message regex", () => {
  // The message alone would regex to `style`; the rule-author's tag says rfc_rebuild.
  assert.equal(dispositionHint(f({ family: "clean-core", rule_id: "talos-x", message: "a generic clean-core issue", disposition_hint: "rfc_rebuild" })), "rfc_rebuild");
});
test("DATA-DRIVE: an unknown/garbage disposition_hint tag never propagates — regex fallback", () => {
  assert.equal(dispositionHint(f({ rule_id: "talos-cloud-006-write", message: "WRITE: / at 10 'x'", disposition_hint: "nonsense" })), "ui_rearch");
});
test("DATA-DRIVE: an untagged finding still derives via the message regex (unchanged fallback = baseline safety)", () => {
  assert.equal(dispositionHint(f({ message: "IDoc inbound processing (ALE)" })), "rfc_rebuild");
});
