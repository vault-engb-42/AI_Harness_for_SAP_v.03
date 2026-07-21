import { test } from "node:test";
import assert from "node:assert/strict";
import { extractBdefDcl } from "../src/extract/bdef-dcl.js";
import { invariantDiff } from "../src/node/invariants.js";

// gap-2b B2 — the BDEF/DCL regex engine (engine 2; abaplint yields nothing for these, per B1).
// Produces the invariantDiff inputs the AST reader CANNOT (dcl_restrictions, privileged_cds) plus
// the composition/lock edges parity consumes. The DCL half is MANDATORY: without it a classic
// AUTHORITY-CHECK → managed-RAP-with-DCL rewrite reads as before=N/after=0 = total auth loss =
// false BLOCK on every modernise-to-RAP node (§5.3 C2). Extraction recipe: RAP_DEEP_EXTRACTION §3.5.

const file = (filename, source) => ({ filename, source });

test("DCL pfcg_auth grants → dcl_restrictions (one {object} per granted auth object, deduped, sorted)", () => {
  const dcl = `@MappingRole: true
define role ZI_Travel_Access {
  grant select on ZI_Travel
    where ( CompanyCode ) = aspect pfcg_auth( F_BKPF_BUK, BUKRS, ACTVT = '03' );
  grant select on ZI_Booking
    where ( CarrierId ) = aspect pfcg_auth( S_CARRID, CARRID );
}`;
  const out = extractBdefDcl([file("zi_travel_access.dcls.asdcls", dcl)]);
  assert.deepEqual(out.dcl_restrictions.map((d) => d.object), ["F_BKPF_BUK", "S_CARRID"]);
});

test("DCL namespaced/slashed auth objects and /-names are captured (no truncation)", () => {
  const dcl = `define role ZR { grant select on ZI_X where (F) = aspect pfcg_auth( /DMO/AUTH, ACTVT ); }`;
  const out = extractBdefDcl([file("zr.dcls.asdcls", dcl)]);
  assert.deepEqual(out.dcl_restrictions, [{ object: "/DMO/AUTH" }]);
});

test("WITH PRIVILEGED ACCESS → privileged_cds {object: the granted CDS, had_row_auth from its where-clause}", () => {
  const dcl = `define role ZI_Analytics_Priv {
  grant select on ZI_Analytics
    where ( CompanyCode ) = aspect pfcg_auth( F_BKPF_BUK, BUKRS )
    with privileged access;
}`;
  const out = extractBdefDcl([file("zi_analytics.dcls.asdcls", dcl)]);
  // Canonical UPPER (like every other extracted object) — ABAP CDS names are case-insensitive and
  // privileged_cds is compared cross-bundle (before-file vs after-file) by invariantDiff.
  assert.deepEqual(out.privileged_cds, [{ object: "ZI_ANALYTICS", had_row_auth: true }]);
});

test("privileged_cds is canonical UPPER — a case-only rewrite of a CARRIED privileged CDS is NOT a false auth-loss", () => {
  // The exact C2/F14 false-BLOCK the adversarial pass caught: before (legacy) and after (generated)
  // are DIFFERENT files, so an ABAP-legal case difference on the same carried-privileged entity must
  // not read as an introduced privileged grant. extractBdefDcl→invariantDiff, real path, no mocks.
  const role = (cds) => `define role ZR { grant select on ${cds} where ( F ) = aspect pfcg_auth( S_X, ACTVT ) with privileged access; }`;
  const before = extractBdefDcl([file("zr.dcls.asdcls", role("ZI_Analytics"))]);
  const after = extractBdefDcl([file("zr.dcls.asdcls", role("zi_analytics"))]);
  const diff = invariantDiff(before, after);
  assert.equal(diff.auth_coverage.lost, false, "same privileged entity (case-insensitive) is not a new privileged grant");
  assert.equal(diff.auth_delta, false, "a case-only rewrite is not an auth-footprint change");
});

test("a grant WITHOUT privileged access is not privileged_cds (no false positive)", () => {
  const dcl = `define role ZR { grant select on ZI_X where (F) = aspect pfcg_auth( S_X, ACTVT ); }`;
  const out = extractBdefDcl([file("zr.dcls.asdcls", dcl)]);
  assert.deepEqual(out.privileged_cds, []);
});

test("DCL comments never fake a grant (keyword-vs-comment defect class)", () => {
  const dcl = `define role ZR {
  // grant select on ZI_Ghost where (F) = aspect pfcg_auth( GHOST_AUTH );
  grant select on ZI_X where (F) = aspect pfcg_auth( S_REAL, ACTVT );
}`;
  const out = extractBdefDcl([file("zr.dcls.asdcls", dcl)]);
  assert.deepEqual(out.dcl_restrictions, [{ object: "S_REAL" }]);
});

test("BDEF lock dependency + composition association → edges (kind lock/composition)", () => {
  const bdef = `managed implementation in class zbp_i_travel unique;
define behavior for ZI_Travel alias Travel
lock master
{
  association _Booking { create; }
}
define behavior for ZI_Booking alias Booking
lock dependent by _Travel
{ }`;
  const out = extractBdefDcl([file("zbp_i_travel.bdef.asbdef", bdef)]);
  assert.ok(out.edges.some((e) => e.kind === "lock" && e.source === "ZI_BOOKING" && e.target === "ZI_TRAVEL"), "lock dependent edge Booking→Travel");
  assert.ok(out.edges.some((e) => e.kind === "composition" && e.source === "ZI_TRAVEL" && e.target === "_BOOKING"), "composition association Travel→_Booking");
});

test("aggregates across a file set + ignores non-BDEF/DCL files", () => {
  const dcl = `define role ZR { grant select on ZI_X where (F) = aspect pfcg_auth( S_A, ACTVT ); }`;
  const bdef = `define behavior for ZI_Y alias Y lock master { }`;
  const out = extractBdefDcl([
    file("zr.dcls.asdcls", dcl),
    file("zbp_y.bdef.asbdef", bdef),
    file("zcl_x.clas.abap", "CLASS zcl_x DEFINITION. ENDCLASS."),
  ]);
  assert.deepEqual(out.dcl_restrictions, [{ object: "S_A" }]);
  assert.equal(out.privileged_cds.length, 0);
});

test("empty / malformed input is total — returns empty bundles, never throws", () => {
  assert.deepEqual(extractBdefDcl([]), { dcl_restrictions: [], privileged_cds: [], edges: [] });
  assert.deepEqual(extractBdefDcl([file("x.dcls.asdcls", "")]), { dcl_restrictions: [], privileged_cds: [], edges: [] });
  assert.doesNotThrow(() => extractBdefDcl([file("x.dcls.asdcls", "define role garbage { grant")]));
});
