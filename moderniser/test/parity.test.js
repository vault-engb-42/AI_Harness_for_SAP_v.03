import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyParity, parity } from "../src/node/parity.js";

// §6.1 — the SCORED parity proxy (L8: semantic equivalence is undecidable → a score + a
// human-review band, never a binary proof). classify_parity derives the mandatory-parity
// class set from the CPG diff; parity() runs the §15.4 cascade: vetoes → BLOCK regardless of
// score; score = 1 − weighted deductions (clamped); half-open bands veto/<0.30 scope_reduced
// / [0.30,0.70) needs_review / [0.70,1] equivalent (PASS_STRUCTURAL iff classes == ∅).

const diff = (o = {}) => ({ changed_edges: [], transformations: [], money_operands: [], statement_kind_changes: [], ...o });

// --- classify_parity (§6.1 table) ---
test("data-source: an edge whose target changed", () => {
  assert.deepEqual(classifyParity(diff({ changed_edges: [{ kind: "uses-table", target_before: "T001", target_after: "I_CompanyCode" }] })), ["data-source"]);
});

test("data-source: an unchanged edge target does NOT trigger", () => {
  assert.deepEqual(classifyParity(diff({ changed_edges: [{ kind: "uses-table", target_before: "T001", target_after: "T001" }] })), []);
});

test("data-source: a released-api transformation whose successor is a table/CDS", () => {
  assert.deepEqual(classifyParity(diff({ transformations: [{ kind: "released-api", successor_kind: "cds" }] })), ["data-source"]);
  // L10: the analyser's TADIR-style vocabulary normalises into the same trigger
  assert.deepEqual(classifyParity(diff({ transformations: [{ kind: "released-api", successor_kind: "CDS_STOB" }] })), ["data-source"]);
  assert.deepEqual(classifyParity(diff({ transformations: [{ kind: "released-api", successor_kind: "TABL" }] })), ["data-source"]);
  assert.deepEqual(classifyParity(diff({ transformations: [{ kind: "released-api", successor_kind: "DDLS" }] })), ["data-source"]);
  assert.deepEqual(classifyParity(diff({ transformations: [{ kind: "released-api", successor_kind: "CLAS" }] })), [], "a class successor is not a data-source trigger");
});

test("money: a changed CURR/QUAN/DEC operand", () => {
  assert.deepEqual(classifyParity(diff({ money_operands: [{ field: "DMBTR", type: "CURR" }] })), ["money"]);
  assert.deepEqual(classifyParity(diff({ money_operands: [{ field: "MENGE", type: "QUAN" }] })), ["money"]);
  assert.deepEqual(classifyParity(diff({ money_operands: [{ field: "KURSF", type: "DEC" }] })), ["money"]);
  assert.deepEqual(classifyParity(diff({ money_operands: [{ field: "NAME", type: "CHAR" }] })), [], "non-amount type");
});

test("client: a CLIENT SPECIFIED delta", () => {
  assert.deepEqual(classifyParity(diff({ client_specified_delta: true })), ["client"]);
});

test("read-idiom: SELECT→EML and CALL-FUNCTION→CALL-METHOD", () => {
  assert.deepEqual(classifyParity(diff({ statement_kind_changes: [{ from: "SELECT", to: "EML" }] })), ["read-idiom"]);
  assert.deepEqual(classifyParity(diff({ statement_kind_changes: [{ from: "call_function", to: "call_method" }] })), ["read-idiom"]);
});

test("no signals → no classes; multiple triggers → sorted unique set", () => {
  assert.deepEqual(classifyParity(diff()), []);
  const c = classifyParity(diff({ client_specified_delta: true, money_operands: [{ field: "WRBTR", type: "CURR" }], statement_kind_changes: [{ from: "SELECT", to: "EML" }] }));
  assert.deepEqual(c, ["client", "money", "read-idiom"]);
});

// --- parity() scored cascade (§6.1 / §15.4) ---
test("a clean rewrite with no classes is PASS_STRUCTURAL at score 1.0", () => {
  assert.deepEqual(parity(diff()), { score: 1, verdict: "PASS_STRUCTURAL", classes: [], evidence: [] });
});

test("a clean rewrite WITH a parity class is equivalent (PASS_STRUCTURAL forbidden when classes non-empty)", () => {
  const r = parity(diff({ client_specified_delta: true }));
  assert.equal(r.score, 1);
  assert.equal(r.verdict, "equivalent");
  assert.deepEqual(r.classes, ["client"]);
});

test("each deduction lowers the score by its §15.4 weight", () => {
  assert.equal(parity(diff({ auth_object_changed: true })).score, 0.7);
  assert.equal(parity(diff({ exception_path_dropped: true })).score, 0.6);
  assert.equal(parity(diff({ def_use_lost: true })).score, 0.7);
  assert.equal(parity(diff({ cfg_branch_regression: true })).score, 0.8);
  assert.equal(parity(diff({ max_nesting_regression: true })).score, 0.85);
});

test("top band: PASS_STRUCTURAL when classes empty, equivalent when non-empty", () => {
  assert.equal(parity(diff({ auth_object_changed: true })).verdict, "PASS_STRUCTURAL"); // 0.70, no class
  assert.equal(parity(diff({ auth_object_changed: true, client_specified_delta: true })).verdict, "equivalent"); // 0.70 + class
});

test("middle band [0.30,0.70) → needs_review; bottom <0.30 → scope_reduced (half-open, total)", () => {
  assert.equal(parity(diff({ exception_path_dropped: true })).verdict, "needs_review"); // 0.60
  assert.equal(parity(diff({ exception_path_dropped: true, def_use_lost: true })).verdict, "needs_review"); // 0.30 boundary
  assert.equal(parity(diff({ exception_path_dropped: true, def_use_lost: true, max_nesting_regression: true })).verdict, "scope_reduced"); // 0.15
});

test("the score clamps at 0 — deductions summing over 1 never go negative", () => {
  const r = parity(diff({ auth_object_changed: true, exception_path_dropped: true, def_use_lost: true, cfg_branch_regression: true, max_nesting_regression: true }));
  assert.equal(r.score, 0);
  assert.equal(r.verdict, "scope_reduced");
});

test("auth_vanished and reassembly_broken are VETOES — BLOCK verdict + score 0 regardless of deductions", () => {
  const a = parity(diff({ auth_vanished: true }));
  assert.equal(a.verdict, "auth_vanished");
  assert.equal(a.score, 0);
  assert.ok(a.evidence.includes("veto:auth_vanished"));
  assert.equal(parity(diff({ reassembly_broken: true })).verdict, "reassembly_broken");
});

test("evidence names each applied deduction", () => {
  const r = parity(diff({ exception_path_dropped: true, cfg_branch_regression: true }));
  assert.ok(r.evidence.some((e) => e.includes("exception_path_dropped")));
  assert.ok(r.evidence.some((e) => e.includes("cfg_branch_regression")));
});
