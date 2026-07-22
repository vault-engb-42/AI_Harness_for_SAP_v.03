import { test } from "node:test";
import assert from "node:assert/strict";
import { invariantDiff } from "../src/node/invariants.js";
import { extractBdefDcl } from "../src/extract/bdef-dcl.js";
import { assembleBundle, invariantInput } from "../src/extract/bundle.js";

// gap-2b B6.5 remediation — the P4a RAP authorization gate reaching the JUDGE.
//
// Engine 2 now extracts the BDEF `authorization master (…)` clause and every DCL grant form, but
// extracted data that no judge reads is inert — that was exactly the `rap_edges` defect the arc
// review caught. These tests pin the CONSUMPTION:
//   * deleting the BDEF authorization clause is a COVERAGE LOSS (P4a names it as the RAP gate);
//   * migrating a DCL from `pfcg_auth` to `inheriting conditions` on the same entity is CONTINUITY,
//     not loss — otherwise the SAP-recommended projection form would false-BLOCK.

const bdef = (source) => ({ filename: "zbp_x.bdef.asbdef", source });
const dcls = (source) => ({ filename: "zc_x.dcls.asdcls", source });

const WITH_AUTH = `define behavior for ZI_X alias X\n  authorization master ( global )\n  lock master { }`;
const NO_AUTH = `define behavior for ZI_X alias X\n  lock master { }`;
const PFCG = `define role zc_x { grant select on zi_x where (carrid) = aspect pfcg_auth( S_CARRID, ACTVT ); }`;
const INHERITING = `define role zc_x { grant select on zi_x where inheriting conditions from entity zi_base; }`;

test("deleting the BDEF authorization clause is a coverage LOSS (P4a's RAP auth gate)", () => {
  const before = extractBdefDcl([bdef(WITH_AUTH)]);
  const after = extractBdefDcl([bdef(NO_AUTH)]);
  const d = invariantDiff(before, after);
  assert.equal(d.auth_coverage.lost, true);
  assert.deepEqual(d.auth_coverage.lost_scopes, [{ object: "ZI_X", field: "*" }]);
  assert.equal(d.auth_delta, true, "an attestation is owed either way");
});

test("keeping the BDEF authorization clause is NOT a loss and NOT a delta", () => {
  const b = extractBdefDcl([bdef(WITH_AUTH)]);
  const d = invariantDiff(b, extractBdefDcl([bdef(WITH_AUTH)]));
  assert.equal(d.auth_coverage.lost, false);
  assert.equal(d.auth_delta, false);
});

test("ADDING a BDEF authorization clause is never a loss (tightening is always allowed)", () => {
  const d = invariantDiff(extractBdefDcl([bdef(NO_AUTH)]), extractBdefDcl([bdef(WITH_AUTH)]));
  assert.equal(d.auth_coverage.lost, false);
  assert.equal(d.auth_delta, true, "the footprint changed — attestation owed, but no loss");
});

test("narrowing global → instance scope is a DELTA (the human decides), not a silent pass", () => {
  const inst = `define behavior for ZI_X alias X\n  authorization master ( instance )\n  lock master { }`;
  const d = invariantDiff(extractBdefDcl([bdef(WITH_AUTH)]), extractBdefDcl([bdef(inst)]));
  assert.equal(d.auth_delta, true);
});

test("pfcg_auth → inheriting conditions on the SAME entity is CONTINUITY, not a false auth-loss", () => {
  const d = invariantDiff(extractBdefDcl([dcls(PFCG)]), extractBdefDcl([dcls(INHERITING)]));
  assert.equal(d.auth_coverage.lost, false, "the entity is still granted — the form merely changed");
  assert.equal(d.auth_delta, true, "the footprint DID change, so an attestation is still owed");
});

test("deleting the role entirely IS a loss (no grant on the entity at all)", () => {
  const d = invariantDiff(extractBdefDcl([dcls(PFCG)]), extractBdefDcl([dcls(`define role zc_x { }`)]));
  assert.equal(d.auth_coverage.lost, true);
  assert.deepEqual(d.auth_coverage.lost_scopes, [{ object: "S_CARRID", field: "*" }]);
});

test("the bundle carries the RAP auth fields through invariantInput to the judge", () => {
  const b = assembleBundle([bdef(WITH_AUTH), dcls(PFCG)]);
  const input = invariantInput(b);
  assert.deepEqual(Object.keys(input).sort(),
    ["auth_bdef", "auth_checks", "commit_work", "dcl_grants", "dcl_restrictions", "privileged_cds", "unreadable"]);
  assert.deepEqual(input.auth_bdef, [{ entity: "ZI_X", mode: "master", scope: "GLOBAL" }]);
  assert.deepEqual(input.dcl_grants, [{ entity: "ZI_X", form: "pfcg_auth" }]);
});

test("end to end: a RAP node that silently drops its authorization clause BLOCKS", () => {
  const before = assembleBundle([bdef(WITH_AUTH), dcls(PFCG)]);
  const after = assembleBundle([bdef(NO_AUTH), dcls(PFCG)]);
  assert.equal(invariantDiff(invariantInput(before), invariantInput(after)).auth_coverage.lost, true);
});
