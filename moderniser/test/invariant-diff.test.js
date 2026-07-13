import { test } from "node:test";
import assert from "node:assert/strict";
import { invariantDiff } from "../src/node/invariants.js";

// §3.2 (P4a/b/c + auth-COVERAGE L7). invariant_diff(before, after) over extracted feature
// bundles (the abaplint parse → features is the later I/O extraction). Splits P4:
//   intact              = P4b (COMMIT not suppressed) ∧ P4c (SY-SUBRC after every AUTHORITY-CHECK)
//   auth_coverage.lost  = P4a coverage loss — NOT statement identity: effective scope is
//                         AUTHORITY-CHECK (object,field) pairs ∪ CDS DCL restrictions, so an
//                         AUTHORITY-CHECK relocated to a DCL grant on the same object is NOT a loss.
//   auth_delta          = any auth footprint change → an abap-security-reviewer attestation is owed.

const bundle = (o = {}) => ({ auth_checks: [], dcl_restrictions: [], commit_work: 0, privileged_cds: [], ...o });
const chk = (object, field, subrc_checked = true) => ({ object, field, subrc_checked });

test("an unchanged, auth-free node is intact, not-lost, no delta", () => {
  const r = invariantDiff(bundle({ commit_work: 1 }), bundle({ commit_work: 1 }));
  assert.equal(r.intact, true);
  assert.equal(r.auth_coverage.lost, false);
  assert.equal(r.auth_delta, false);
});

test("P4b — suppressing a COMMIT boundary breaks intact", () => {
  const r = invariantDiff(bundle({ commit_work: 2 }), bundle({ commit_work: 1 }));
  assert.equal(r.intact, false);
  assert.ok(r.violations.includes("P4b:commit-suppressed"));
});

test("adding commits is fine (only suppression is a violation)", () => {
  assert.equal(invariantDiff(bundle({ commit_work: 1 }), bundle({ commit_work: 3 })).intact, true);
});

test("P4c — an AUTHORITY-CHECK in the after with no SY-SUBRC check breaks intact", () => {
  const after = bundle({ auth_checks: [chk("S_TABU_DIS", "ACTVT", false)] });
  const r = invariantDiff(bundle(), after);
  assert.equal(r.intact, false);
  assert.ok(r.violations.includes("P4c:subrc-unchecked"));
});

test("P4a/L7 — a removed AUTHORITY-CHECK with no DCL replacement is coverage LOSS", () => {
  const before = bundle({ auth_checks: [chk("S_TABU_DIS", "ACTVT")] });
  const r = invariantDiff(before, bundle());
  assert.equal(r.auth_coverage.lost, true);
  assert.deepEqual(r.auth_coverage.lost_scopes, [{ object: "S_TABU_DIS", field: "ACTVT" }]);
  assert.equal(r.auth_delta, true);
});

test("P4a/L7 — an AUTHORITY-CHECK relocated to a DCL grant on the same object is NOT a loss", () => {
  const before = bundle({ auth_checks: [chk("S_TABU_DIS", "ACTVT")] });
  const after = bundle({ dcl_restrictions: [{ object: "S_TABU_DIS" }] }); // auth moved to DCL (managed RAP)
  const r = invariantDiff(before, after);
  assert.equal(r.auth_coverage.lost, false, "coverage preserved via DCL — the sanctioned P3 relocation");
  assert.equal(r.auth_delta, true, "footprint changed → attestation still owed");
});

test("P4a/L7 — WITH PRIVILEGED ACCESS on a CDS that had row-level auth is coverage LOSS", () => {
  const after = bundle({ privileged_cds: [{ object: "I_JOURNALENTRY", had_row_auth: true }] });
  const r = invariantDiff(bundle(), after);
  assert.equal(r.auth_coverage.lost, true);
});

test("a DCL grant covers the object regardless of field; a different-field AUTHORITY-CHECK does not", () => {
  const before = bundle({ auth_checks: [chk("S_X", "F1")] });
  assert.equal(invariantDiff(before, bundle({ dcl_restrictions: [{ object: "S_X" }] })).auth_coverage.lost, false);
  assert.equal(invariantDiff(before, bundle({ auth_checks: [chk("S_X", "F2")] })).auth_coverage.lost, true, "F1 ≠ F2, no DCL");
});

test("a managed RAP BO with zero AUTHORITY-CHECK (auth all in DCL) is intact and not-lost", () => {
  const before = bundle({ auth_checks: [chk("S_X", "F1")] });
  const after = bundle({ dcl_restrictions: [{ object: "S_X" }] });
  const r = invariantDiff(before, after);
  assert.equal(r.intact, true);
  assert.equal(r.auth_coverage.lost, false);
});

test("adding auth (no removal) is not a loss but is a delta", () => {
  const r = invariantDiff(bundle(), bundle({ auth_checks: [chk("S_NEW", "ACTVT")] }));
  assert.equal(r.auth_coverage.lost, false);
  assert.equal(r.auth_delta, true);
});

test("auth_delta flags REMOVAL of WITH PRIVILEGED ACCESS too (any footprint change → attestation owed)", () => {
  const before = bundle({ privileged_cds: [{ object: "I_X", had_row_auth: true }] });
  const r = invariantDiff(before, bundle());
  assert.equal(r.auth_delta, true);
  assert.equal(r.auth_coverage.lost, false, "removing privileged access is a strengthening, not a loss");
});

// --- Whole-branch review remediations (branch-review-2026-07-13: F13 + F14, B2/B3) ---

test("P4a/L7 — a removed CDS DCL restriction is coverage LOSS unless relocated (F13)", () => {
  const before = bundle({ dcl_restrictions: [{ object: "S_TABU_DIS" }] });
  // removed entirely: the row-level auth the DCL carried is gone
  const gone = invariantDiff(before, bundle());
  assert.equal(gone.auth_coverage.lost, true, "a deleted DCL is a loss, not merely a delta");
  assert.deepEqual(gone.auth_coverage.lost_scopes, [{ object: "S_TABU_DIS", field: "*" }]);
  assert.equal(gone.auth_delta, true);
  // relocated to an after-DCL on the same object → covered
  assert.equal(invariantDiff(before, bundle({ dcl_restrictions: [{ object: "S_TABU_DIS" }] })).auth_coverage.lost, false);
  // relocated to an AUTHORITY-CHECK on the same object → the reverse of the sanctioned P3 move, still covered
  const relocated = invariantDiff(before, bundle({ auth_checks: [chk("S_TABU_DIS", "ACTVT")] }));
  assert.equal(relocated.auth_coverage.lost, false, "an after-check on the object covers the scope");
  assert.equal(relocated.auth_delta, true, "footprint changed → attestation still owed");
});

test("P4a/L6.2 — pre-existing WITH PRIVILEGED ACCESS is carried debt, never a fresh loss (F14)", () => {
  const priv = bundle({ privileged_cds: [{ object: "I_X", had_row_auth: true }] });
  const same = invariantDiff(priv, priv);
  assert.equal(same.auth_coverage.lost, false, "an identical before/after bundle cannot be a loss");
  assert.deepEqual(same.auth_coverage.lost_scopes, []);
  assert.equal(same.auth_delta, false, "no footprint change either — fully consistent verdict");
  // INTRODUCED privileged access still counts as loss (the guarded direction is unchanged)
  assert.equal(invariantDiff(bundle(), priv).auth_coverage.lost, true);
});
