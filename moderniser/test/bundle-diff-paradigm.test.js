import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleBundle, invariantInput } from "../src/extract/bundle.js";
import { diffBundles } from "../src/extract/bundle-diff.js";
import { invariantDiff } from "../src/node/invariants.js";
import { parity } from "../src/node/parity.js";

// gap-2b B6.5 remediation — F9 and F10, the two FALSE-BLOCK defects. Both fire on the single most
// canonical thing this harness exists to do: classic ABAP with COMMIT WORK → managed RAP.
//
//   F9  `commit_work` counted ABAP STATEMENTS only. A managed RAP BO has no explicit COMMIT — the
//       framework owns the save — so the after side counted 0 against a before side of 1 and
//       invariantDiff raised P4b:commit-suppressed. A P4 violation is non-attestable, so the node
//       regenerated to a ceiling BLOCK every time.
//   F10 the parity structure deductions (exception paths, CFG branches, max nesting) are IMPERATIVE
//       measures. A faithful declarative rewrite moves that structure into CDS and BDEF artifacts
//       the counters cannot see, so it scored 0.25 → scope_reduced → also non-attestable → ceiling.
//
// The fix is not to soften either judge. It is to stop comparing apples to oranges: count the RAP
// save boundary as a save boundary, and route an imperative→declarative rewrite to the HUMAN
// (needs_review → PARITY_REVIEW) instead of asserting a structural verdict the counters cannot support.

const clazz = (body) => `CLASS zcl_x DEFINITION PUBLIC. PUBLIC SECTION. METHODS m. ENDCLASS.
CLASS zcl_x IMPLEMENTATION. METHOD m.
${body}
ENDMETHOD. ENDCLASS.`;

const CLASSIC = [{ filename: "zcl_x.clas.abap", source: clazz(`  TRY.
      SELECT * FROM zt INTO TABLE @DATA(lt).
      LOOP AT lt INTO DATA(ls).
        IF ls IS INITIAL. CONTINUE. ENDIF.
      ENDLOOP.
    CATCH cx_root INTO DATA(lx).
      RAISE EXCEPTION lx.
  ENDTRY.
  COMMIT WORK.`) }];

const MANAGED_RAP = [{ filename: "zbp_x.bdef.asbdef", source: `managed implementation in class zbp_x unique;
define behavior for ZI_X alias X
  authorization master ( global )
  lock master { }` }];

// ---------------------------------------------------------------- F9: the RAP save boundary

test("F9: a managed RAP behaviour definition IS a save boundary (the framework owns the COMMIT)", () => {
  assert.equal(assembleBundle(MANAGED_RAP).commit_work, 1);
});

test("F9: classic COMMIT WORK → managed RAP does NOT read as a suppressed commit", () => {
  const d = invariantDiff(invariantInput(assembleBundle(CLASSIC)), invariantInput(assembleBundle(MANAGED_RAP)));
  assert.ok(!d.violations.includes("P4b:commit-suppressed"), `violations: ${d.violations}`);
});

test("F9: a projection behaviour is NOT a save boundary (it delegates to its root)", () => {
  const projection = [{ filename: "zbp_p.bdef.asbdef", source: `projection;\ndefine behavior for ZC_X alias X { use create; }` }];
  assert.equal(assembleBundle(projection).commit_work, 0);
});

test("F9: dropping the save boundary entirely IS still a suppression (the guard is not defanged)", () => {
  const noSave = [{ filename: "zcl_x.clas.abap", source: clazz("  WRITE 1.") }];
  const d = invariantDiff(invariantInput(assembleBundle(CLASSIC)), invariantInput(assembleBundle(noSave)));
  assert.ok(d.violations.includes("P4b:commit-suppressed"), `violations: ${d.violations}`);
});

// ---------------------------------------------------------------- F10: the paradigm shift

test("F10: an imperative→declarative rewrite is flagged, and the incomparable deductions are suppressed", () => {
  const d = diffBundles(assembleBundle(CLASSIC), assembleBundle(MANAGED_RAP));
  assert.equal(d.paradigm_shift, true);
  assert.equal(d.exception_path_dropped, false, "the exception path moved into RAP, it was not dropped");
  assert.equal(d.cfg_branch_regression, false);
  assert.equal(d.max_nesting_regression, false);
});

test("F10: it routes to HUMAN REVIEW, not to a non-attestable scope_reduced BLOCK", () => {
  const p = parity(diffBundles(assembleBundle(CLASSIC), assembleBundle(MANAGED_RAP)));
  assert.equal(p.verdict, "needs_review", "scope_reduced would burn the cycle budget to a ceiling BLOCK");
  assert.ok(p.evidence.includes("band:paradigm_shift"), `evidence: ${p.evidence}`);
});

test("F10: a paradigm shift NEVER auto-passes — it cannot reach equivalent or PASS_STRUCTURAL", () => {
  const p = parity(diffBundles(assembleBundle(CLASSIC), assembleBundle(MANAGED_RAP)));
  assert.notEqual(p.verdict, "PASS_STRUCTURAL");
  assert.notEqual(p.verdict, "equivalent");
});

test("F10: a VETO still outranks the paradigm shift (auth loss is never a review item)", () => {
  const d = { ...diffBundles(assembleBundle(CLASSIC), assembleBundle(MANAGED_RAP)), auth_vanished: true };
  assert.equal(parity(d).verdict, "auth_vanished");
});

test("F10: an ABAP→ABAP rewrite is unaffected — dropped structure still deducts", () => {
  const stripped = [{ filename: "zcl_x.clas.abap", source: clazz("  COMMIT WORK.") }];
  const d = diffBundles(assembleBundle(CLASSIC), assembleBundle(stripped));
  assert.equal(d.paradigm_shift, false);
  assert.equal(d.exception_path_dropped, true);
  assert.equal(parity(d).verdict, "scope_reduced");
});

test("F10: a RAP→RAP rewrite is not a paradigm shift (both sides are already declarative)", () => {
  assert.equal(diffBundles(assembleBundle(MANAGED_RAP), assembleBundle(MANAGED_RAP)).paradigm_shift, false);
});

test("the diff emits exactly the 12 fields parity consumes", () => {
  const b = assembleBundle(CLASSIC);
  assert.equal(Object.keys(diffBundles(b, b)).length, 12);
});
