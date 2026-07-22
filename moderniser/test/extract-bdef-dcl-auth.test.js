import { test } from "node:test";
import assert from "node:assert/strict";
import { extractBdefDcl } from "../src/extract/bdef-dcl.js";

// gap-2b B6.5 remediation — engine 2 auth surface. Four adversarially-confirmed defects:
//   F2  stripComments deleted real grants (block-strip ran BEFORE the line strip, and was
//       literal-blind), so `// note /*` … `*/` swallowed everything between.
//   F3  the same regex was quadratic — 234 KB of "/* " took 2.7 s (P8 DoS on untrusted ABAP).
//   F4  the BDEF `authorization master ( global )` clause — which CLAUDE.md P4a NAMES as the RAP
//       authorization gate — was never extracted, so deleting it was invisible.
//   F7  privilegedCds matched `with privileged access` inside a DCL grant. That clause does not
//       exist in DCL grammar; WITH PRIVILEGED ACCESS is an ABAP-SQL addition. The branch was dead
//       on real code and both REAL bypasses went unmonitored.

const dcls = (source, filename = "zc_x.dcls.asdcls") => ({ filename, source });
const bdef = (source, filename = "zbp_x.bdef.asbdef") => ({ filename, source });
const ddls = (source, filename = "zi_x.ddls.asddls") => ({ filename, source });

const GRANT = `define role zc_x { grant select on zi_x where (carrid) = aspect pfcg_auth( S_CARRID, ACTVT ); }`;

// ---------------------------------------------------------------- F2: comment scanning

test("F2: a `//` line comment containing `/*` does NOT swallow the grant that follows", () => {
  const src = `// restore the /* note\n${GRANT}\n/* a real block comment */`;
  assert.deepEqual(extractBdefDcl([dcls(src)]).dcl_restrictions, [{ object: "S_CARRID", entity: "ZI_X" }]);
});

test("F2: a `/*` inside a string literal is not a comment opener", () => {
  const src = `define role zc_x { grant select on zi_x where (txt) = '/*' and (carrid) = aspect pfcg_auth( S_CARRID, ACTVT ); }`;
  assert.deepEqual(extractBdefDcl([dcls(src)]).dcl_restrictions, [{ object: "S_CARRID", entity: "ZI_X" }]);
});

test("F2: a genuinely commented-out grant still does not count", () => {
  assert.deepEqual(extractBdefDcl([dcls(`// ${GRANT}`)]).dcl_restrictions, []);
  assert.deepEqual(extractBdefDcl([dcls(`/* ${GRANT} */`)]).dcl_restrictions, []);
});

test("F2: an unterminated block comment consumes to EOF and never throws", () => {
  assert.doesNotThrow(() => extractBdefDcl([dcls(`/*` + ` unterminated
${GRANT}`)]));
  assert.deepEqual(extractBdefDcl([dcls(`/* unterminated\n${GRANT}`)]).dcl_restrictions, []);
});

test("F3: comment stripping is LINEAR — 1 MB of block-comment openers completes fast (P8)", () => {
  const started = Date.now();
  extractBdefDcl([dcls("/* ".repeat(350000))]);
  const ms = Date.now() - started;
  assert.ok(ms < 1000, `stripComments took ${ms}ms on ~1MB — quadratic behaviour has returned`);
});

// ---------------------------------------------------------------- F4: the BDEF auth gate

test("F4: `authorization master ( global )` is extracted per entity (P4a's RAP auth gate)", () => {
  const src = `managed implementation in class zbp_x unique;
define behavior for ZI_X alias X
  authorization master ( global, instance )
  lock master { }
define behavior for ZI_Item alias Item
  authorization dependent by _X
  lock dependent by _X { }`;
  assert.deepEqual(extractBdefDcl([bdef(src)]).auth_bdef, [
    { entity: "ZI_ITEM", mode: "dependent", scope: "_X" },
    { entity: "ZI_X", mode: "master", scope: "GLOBAL,INSTANCE" },
  ]);
});

test("F4: DELETING the authorization clause is VISIBLE (it was byte-identical before)", () => {
  const withAuth = `define behavior for ZI_X alias X\n  authorization master ( global )\n  lock master { }`;
  const without = `define behavior for ZI_X alias X\n  lock master { }`;
  assert.equal(extractBdefDcl([bdef(withAuth)]).auth_bdef.length, 1);
  assert.deepEqual(extractBdefDcl([bdef(without)]).auth_bdef, []);
});

test("F4: namespaced /NS/ entity names are captured and canonical UPPER", () => {
  const src = `define behavior for /NS/I_Thing alias T\n  authorization master ( global )\n  lock master { }`;
  assert.deepEqual(extractBdefDcl([bdef(src)]).auth_bdef, [{ entity: "/NS/I_THING", mode: "master", scope: "GLOBAL" }]);
});

// ---------------------------------------------------------------- F4b: DCL grant forms

test("F4b: EVERY grant form is recorded, so a pfcg_auth→inheriting migration reads as continuity", () => {
  const inheriting = `define role zc_x { grant select on zi_x where inheriting conditions from entity zi_base; }`;
  assert.deepEqual(extractBdefDcl([dcls(GRANT)]).dcl_grants, [{ entity: "ZI_X", form: "pfcg_auth" }]);
  assert.deepEqual(extractBdefDcl([dcls(inheriting)]).dcl_grants, [{ entity: "ZI_X", form: "inheriting" }]);
});

test("F4b: an unconditional grant is recorded as such (it is a grant, not an absence)", () => {
  assert.deepEqual(extractBdefDcl([dcls(`define role zc_x { grant select on zi_x; }`)]).dcl_grants,
    [{ entity: "ZI_X", form: "unconditional" }]);
});

test("F4b: deleting the whole role IS a loss — no grants at all", () => {
  assert.deepEqual(extractBdefDcl([dcls(`define role zc_x { }`)]).dcl_grants, []);
});

// ---------------------------------------------------------------- F7: real privileged access

test("F7: the dead `with privileged access`-in-DCL branch is gone", () => {
  const fake = `define role zc_x { grant select on zi_x with privileged access; }`;
  assert.deepEqual(extractBdefDcl([dcls(fake)]).privileged_cds, [],
    "WITH PRIVILEGED ACCESS is ABAP-SQL, not DCL grammar — matching it here was matching nothing real");
});

test("F7: a CDS view declaring #NOT_REQUIRED IS a real authorization bypass", () => {
  const src = `@AccessControl.authorizationCheck: #NOT_REQUIRED\ndefine view entity ZI_X as select from zt { key id }`;
  assert.deepEqual(extractBdefDcl([ddls(src)]).privileged_cds, [{ object: "ZI_X", had_row_auth: false }]);
});

test("F7: #NOT_REQUIRED on a view that a DCL role also grants → had_row_auth (the F14 trigger)", () => {
  const view = `@AccessControl.authorizationCheck: #NOT_REQUIRED\ndefine view entity ZI_X as select from zt { key id }`;
  assert.deepEqual(extractBdefDcl([ddls(view), dcls(GRANT)]).privileged_cds, [{ object: "ZI_X", had_row_auth: true }]);
});

test("F7: #CHECK is the safe default and is never a bypass", () => {
  const src = `@AccessControl.authorizationCheck: #CHECK\ndefine view entity ZI_X as select from zt { key id }`;
  assert.deepEqual(extractBdefDcl([ddls(src)]).privileged_cds, []);
});

test("F7: #NOT_ALLOWED is also a bypass", () => {
  const src = `@AccessControl.authorizationCheck: #NOT_ALLOWED\ndefine view entity ZI_X as select from zt { key id }`;
  assert.deepEqual(extractBdefDcl([ddls(src)]).privileged_cds, [{ object: "ZI_X", had_row_auth: false }]);
});

// ---------------------------------------------------------------- totality

test("all new surfaces are total and deterministic", () => {
  const files = [dcls(GRANT), bdef(`define behavior for ZI_X alias X authorization master ( global ) { }`), ddls(`@AccessControl.authorizationCheck: #NOT_REQUIRED\ndefine view entity ZI_X as select from zt { key id }`)];
  assert.deepEqual(extractBdefDcl(files), extractBdefDcl(files));
  // Hostile bytes are CONSTRUCTED, never literal in source: a NUL, an RTL override, an
  // unterminated literal, an unterminated block comment (P8 — retrieved ABAP is untrusted data).
  const hostile = String.fromCharCode(0, 0x202e) + "{{{ unterminated '";
  assert.doesNotThrow(() => extractBdefDcl([dcls(hostile), bdef('/' + '*'), ddls('@AccessControl')]));
});

// B7 acceptance found this: the real abap_fico corpus uses BOTH naming conventions — abapGit's
// `<name>.<type>.<ext>` and ADT's bare `<name>.<ext>`. Requiring the `.bdef`/`.ddls` infix made
// engine 2 silently skip every bare-named artifact, returning zero features, so a missing
// authorization clause was indistinguishable from an object that never had one.

test("routing accepts BOTH the abapGit infix form and the bare ADT form", () => {
  const body = `managed implementation in class zbp_x unique;
define behavior for ZI_X alias X
  authorization master ( global )
  lock master { }`;
  const expected = [{ entity: "ZI_X", mode: "master", scope: "GLOBAL" }];
  for (const name of ["zbp_x.bdef.asbdef", "ZBP_X.asbdef", "zbp_x.bdef"]) {
    assert.deepEqual(extractBdefDcl([{ filename: name, source: body }]).auth_bdef, expected, `BDEF routing failed for ${name}`);
    assert.equal(extractBdefDcl([{ filename: name, source: body }]).save_boundaries, 1, `save boundary missed for ${name}`);
  }
  const role = `define role zc_x { grant select on zi_x where (c) = aspect pfcg_auth( S_CARRID, ACTVT ); }`;
  for (const name of ["zc_x.dcls.asdcls", "ZC_X.asdcls", "zc_x.dcls"]) {
    assert.deepEqual(extractBdefDcl([{ filename: name, source: role }]).dcl_restrictions,
      [{ object: "S_CARRID", entity: "ZI_X" }], `DCL routing failed for ${name}`);
  }
  const view = `@AccessControl.authorizationCheck: #NOT_REQUIRED\ndefine view entity ZI_X as select from zt { key id }`;
  for (const name of ["zi_x.ddls.asddls", "ZI_X.asddls", "zi_x.ddls"]) {
    assert.deepEqual(extractBdefDcl([{ filename: name, source: view }]).privileged_cds,
      [{ object: "ZI_X", had_row_auth: false }], `DDLS routing failed for ${name}`);
  }
});

test("a REAL abap_fico corpus artifact with a bare .asbdef name is extracted", async () => {
  const { readFileSync } = await import("node:fs");
  const path = "demos/abap_fico-e2e-2026-07-14/after/modernised-source/ZCREATE_ASSET/ZR_ZASSETCOPYCC.asbdef";
  const out = extractBdefDcl([{ filename: "ZR_ZASSETCOPYCC.asbdef", source: readFileSync(path, "utf8") }]);
  assert.equal(out.save_boundaries, 1, "this returned ZERO features before the routing fix");
});
