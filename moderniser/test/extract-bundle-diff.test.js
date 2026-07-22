import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleBundle, invariantInput } from "../src/extract/bundle.js";
import { diffBundles } from "../src/extract/bundle-diff.js";
import { parity } from "../src/node/parity.js";
import { invariantDiff } from "../src/node/invariants.js";
import { analyzePackage } from "../../analyser/src/orchestrator.js";

// gap-2b B4 — the before/after DIFF. Emits ALL 12 fields `parity.js` consumes (a 4-field extractor
// produces no deduction signals → score = 1 always → permanent false-GREEN). Every field is a
// DELTA, never a snapshot: an unchanged bundle must yield an inert diff (F14).

const clazz = (body) => `CLASS zcl_x DEFINITION PUBLIC. PUBLIC SECTION. METHODS m. ENDCLASS.
CLASS zcl_x IMPLEMENTATION. METHOD m.
${body}
ENDMETHOD. ENDCLASS.`;
const abap = (body, filename = "zcl_x.clas.abap") => ({ filename, source: clazz(body) });

const CLASSIC = abap(`  AUTHORITY-CHECK OBJECT 'S_CARRID' ID 'ACTVT' FIELD '03'.
  IF sy-subrc <> 0. RETURN. ENDIF.
  TRY.
      SELECT * FROM zt INTO TABLE @DATA(lt).
    CATCH cx_root INTO DATA(lx).
      RAISE EXCEPTION lx.
  ENDTRY.
  COMMIT WORK.`);

test("an UNCHANGED bundle produces an inert diff → parity PASS_STRUCTURAL, invariants intact (F14)", () => {
  const b = assembleBundle([CLASSIC]);
  const d = diffBundles(b, b);
  assert.deepEqual(d.changed_edges, []);
  assert.deepEqual(d.transformations, []);
  assert.deepEqual(d.money_operands, []);
  assert.deepEqual(d.statement_kind_changes, []);
  assert.equal(d.client_specified_delta, false);
  assert.equal(d.auth_vanished, false);
  assert.equal(d.reassembly_broken, false);
  for (const k of ["auth_object_changed", "exception_path_dropped", "cfg_branch_regression", "max_nesting_regression"]) {
    assert.equal(d[k], false, `${k} must not phantom-fire on an unchanged bundle`);
  }
  const p = parity(d);
  assert.equal(p.score, 1);
  assert.equal(p.verdict, "PASS_STRUCTURAL");
  assert.equal(invariantDiff(invariantInput(b), invariantInput(b)).intact, true);
});

test("an unchanged MONEY-touching bundle owes no `money` class — symmetric difference, not union", () => {
  const b = assembleBundle([abap(`  DATA lv_amount TYPE dmbtr.
  DATA lv_qty TYPE menge.
  WRITE lv_amount.`)]);
  assert.equal(b.money_operands.length, 2, "the side really does carry money operands");
  assert.deepEqual(diffBundles(b, b).money_operands, [], "nothing changed → no currency-matrix evidence owed");
  assert.deepEqual(parity(diffBundles(b, b)).classes, []);
});

test("emits ALL 12 parity fields — a partial bundle is the permanent-false-GREEN trap", () => {
  const b = assembleBundle([CLASSIC]);
  assert.deepEqual(Object.keys(diffBundles(b, b)).sort(), [
    "auth_object_changed", "auth_vanished", "cfg_branch_regression", "changed_edges",
    "client_specified_delta", "exception_path_dropped", "max_nesting_regression", "money_operands",
    "reassembly_broken", "statement_kind_changes", "transformations",
  ].sort());
});

test("a dropped exception path deducts 0.40 → needs_review (never a silent pass)", () => {
  const before = assembleBundle([CLASSIC]);
  const after = assembleBundle([abap(`  AUTHORITY-CHECK OBJECT 'S_CARRID' ID 'ACTVT' FIELD '03'.
  IF sy-subrc <> 0. RETURN. ENDIF.
  SELECT * FROM zt INTO TABLE @DATA(lt).
  COMMIT WORK.`)]);
  const d = diffBundles(before, after);
  assert.equal(d.exception_path_dropped, true);
  const p = parity(d);
  assert.equal(p.score, 0.6);
  assert.equal(p.verdict, "needs_review");
  assert.ok(p.evidence.includes("deduct:exception_path_dropped:-0.4"));
});

test("CFG-branch and max-nesting regressions each deduct", () => {
  const before = assembleBundle([abap(`  LOOP AT lt INTO DATA(ls). IF ls IS INITIAL. WRITE 1. ENDIF. ENDLOOP.`)]);
  const after = assembleBundle([abap(`  WRITE 1.`)]);
  const d = diffBundles(before, after);
  assert.equal(d.cfg_branch_regression, true);
  assert.equal(d.max_nesting_regression, true);
  assert.equal(parity(d).score, 0.65);
});

test("classic AUTHORITY-CHECK → managed RAP with a DCL grant: auth relocated, NOT vanished (the C2 false-BLOCK guard)", () => {
  const before = assembleBundle([CLASSIC]);
  const after = assembleBundle([
    { filename: "zc_x.dcls.asdcls", source: `define role zc_x { grant select on zi_x where (carrid) = aspect pfcg_auth( S_CARRID, ACTVT ); }` },
    abap(`  COMMIT ENTITIES.`, "zbp_x.clas.abap"),
  ]);
  const d = diffBundles(before, after);
  assert.equal(d.auth_vanished, false, "the DCL grant relocates the auth — no veto");
  assert.equal(d.auth_object_changed, false, "same auth OBJECT, different carrier");
  const inv = invariantDiff(invariantInput(before), invariantInput(after));
  assert.equal(inv.auth_coverage.lost, false);
  assert.equal(inv.auth_delta, true, "the footprint moved → an attestation is owed");
  assert.notEqual(parity(d).verdict, "auth_vanished");
});

test("auth removed with NO relocation → the auth_vanished veto (score 0, BLOCK)", () => {
  const before = assembleBundle([CLASSIC]);
  const after = assembleBundle([abap(`  SELECT * FROM zt INTO TABLE @DATA(lt).
  COMMIT WORK.`)]);
  const d = diffBundles(before, after);
  assert.equal(d.auth_vanished, true);
  const p = parity(d);
  assert.equal(p.score, 0);
  assert.equal(p.verdict, "auth_vanished");
});

test("a changed auth OBJECT deducts 0.30 (distinct from the vanish veto)", () => {
  const before = assembleBundle([CLASSIC]);
  const after = assembleBundle([abap(`  AUTHORITY-CHECK OBJECT 'S_DEVELOP' ID 'ACTVT' FIELD '03'.
  IF sy-subrc <> 0. RETURN. ENDIF.
  TRY.
      SELECT * FROM zt INTO TABLE @DATA(lt).
    CATCH cx_root INTO DATA(lx).
      RAISE EXCEPTION lx.
  ENDTRY.
  COMMIT WORK.`)]);
  const d = diffBundles(before, after);
  assert.equal(d.auth_vanished, false);
  assert.equal(d.auth_object_changed, true);
  assert.equal(parity(d).score, 0.7);
});

test("SELECT → EML is a read-idiom change; money + client deltas classify", () => {
  const before = assembleBundle([abap(`  SELECT * FROM zt INTO TABLE @DATA(lt).
  SELECT SINGLE * FROM zt CLIENT SPECIFIED INTO @DATA(ls).`)]);
  const after = assembleBundle([abap(`  DATA lv_amount TYPE dmbtr.
  READ ENTITIES OF zi_x IN LOCAL MODE ENTITY x ALL FIELDS WITH lt RESULT rt.`)]);
  const d = diffBundles(before, after);
  assert.deepEqual(d.statement_kind_changes, [{ from: "SELECT", to: "EML" }]);
  assert.deepEqual(d.money_operands, [{ field: "LV_AMOUNT", type: "CURR" }]);
  assert.equal(d.client_specified_delta, true);
  assert.deepEqual(parity(d).classes, ["client", "money", "read-idiom"]);
});

test("changed_edges are CPG-node-granular: a comment-only edit spawns NO phantom edge change (devepos R1)", () => {
  const src = `REPORT zr_x.
  SELECT * FROM lfb1 INTO TABLE @DATA(lt).`;
  const files = (s) => [{ filename: "zr_x.prog.abap", source: s }];
  const before = assembleBundle(files(src), { analysis: analyzePackage(files(src)) });
  const commented = `REPORT zr_x.
* a new comment line that shifts every statement down
  SELECT * FROM lfb1 INTO TABLE @DATA(lt).`;
  const after = assembleBundle(files(commented), { analysis: analyzePackage(files(commented)) });

  assert.ok(before.cpg_edges.length > 0, "the CPG must actually carry edges for this to prove anything");
  assert.notDeepEqual(before.file_hashes, after.file_hashes, "the TEXT did change");
  assert.deepEqual(diffBundles(before, after).changed_edges, [], "…but no CPG edge did");
});

test("a data-source edge swap emits target_before/target_after → the data-source parity class", () => {
  const g = (target) => ({ graph: { edges: [{ source: "ZR_X", target, kind: "uses-table", evidence: "zr_x.prog.abap:2" }], nodes: [{ id: "ZR_X" }] } });
  const before = assembleBundle([], { analysis: g("LFB1") });
  const after = assembleBundle([], { analysis: g("I_SUPPLIER") });
  const d = diffBundles(before, after);
  assert.deepEqual(d.changed_edges, [
    { kind: "uses-table", source: "ZR_X", target_before: "LFB1", target_after: null },
    { kind: "uses-table", source: "ZR_X", target_before: null, target_after: "I_SUPPLIER" },
  ]);
  assert.deepEqual(parity(d).classes, ["data-source"]);
});

test("transformations: a blast-radius object that left the CPG is a released-api swap", () => {
  const before = assembleBundle([], {
    analysis: { graph: { nodes: [{ id: "ZR_X" }, { id: "LFB1" }], edges: [] }, blast_radius: [{ object: "LFB1", successor_kind: "CDS_STOB" }] },
  });
  const after = assembleBundle([], { analysis: { graph: { nodes: [{ id: "ZR_X" }, { id: "I_SUPPLIER" }], edges: [] } } });
  const d = diffBundles(before, after);
  assert.deepEqual(d.transformations, [{ kind: "released-api", object: "LFB1", successor_kind: "CDS_STOB" }]);
  assert.deepEqual(parity(d).classes, ["data-source"]);
});

test("a named released_successor resolves its kind through the blast-radius map (parity's owed step)", () => {
  const before = assembleBundle([], {
    analysis: {
      graph: { nodes: [{ id: "ZR_X" }], edges: [] },
      blast_radius: [{ object: "I_SUPPLIER", successor_kind: "DDLS" }],
      modernization_plan: { objects: [{ transformations: [{ kind: "clean-core", released_successor: "I_Supplier" }] }] },
    },
  });
  const after = assembleBundle([], { analysis: { graph: { nodes: [{ id: "ZR_X" }], edges: [] } } });
  assert.deepEqual(diffBundles(before, after).transformations,
    [{ kind: "released-api", object: "I_SUPPLIER", successor_kind: "DDLS" }]);
});

test("no AFTER-side CPG → no phantom transformations (absence of evidence is not a swap)", () => {
  const before = assembleBundle([], {
    analysis: { graph: { nodes: [{ id: "ZR_X" }, { id: "LFB1" }], edges: [] }, blast_radius: [{ object: "LFB1", successor_kind: "CDS_STOB" }] },
  });
  const after = assembleBundle([]); // caller supplied an analysis doc for ONE side only
  assert.deepEqual(diffBundles(before, after).transformations, []);
  assert.deepEqual(parity(diffBundles(before, after)).classes, []);
});

test("reassembly_broken: an UNTOUCHED file's bytes changed → veto; unknown touched-set → no assertion", () => {
  const other = { filename: "zcl_other.clas.abap", source: clazz("  WRITE 1.") };
  const before = assembleBundle([CLASSIC, other]);
  const after = assembleBundle([CLASSIC, { ...other, source: clazz("  WRITE 2.") }]);

  assert.equal(diffBundles(before, after, { touched_files: ["zcl_x.clas.abap"] }).reassembly_broken, true);
  assert.equal(diffBundles(before, after, { touched_files: ["zcl_x.clas.abap", "zcl_other.clas.abap"] }).reassembly_broken, false);
  assert.equal(diffBundles(before, after).reassembly_broken, false, "no declared touched set → cannot assert the veto");
  assert.equal(parity(diffBundles(before, after, { touched_files: [] })).verdict, "reassembly_broken");
});

test("deterministic + total: repeated diffs are deep-equal; missing sides never throw", () => {
  const before = assembleBundle([CLASSIC]);
  const after = assembleBundle([abap("  WRITE 1.")]);
  assert.deepEqual(diffBundles(before, after), diffBundles(before, after));
  assert.doesNotThrow(() => diffBundles(undefined, undefined));
  assert.doesNotThrow(() => diffBundles(before, {}));
});
