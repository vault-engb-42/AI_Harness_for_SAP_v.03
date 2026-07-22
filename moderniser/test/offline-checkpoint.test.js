import { test } from "node:test";
import assert from "node:assert/strict";
import { offlineCheckpoint, offlineEvidence, changedLines, renderOfflineNodeVerdict } from "../src/node/offline-checkpoint.js";
import { assembleBundle } from "../src/extract/bundle.js";
import { recordProvisionalVerdict } from "../src/sched/verdict-ops.js";
import { initRun, dispatch, applyProgress } from "../src/sched/loop.js";

// gap-2b B5 — the offline verdict seam's PRODUCER. B4's bundles → invariantDiff + parity →
// the checkpoint (§4.4 split) + the offline ratchet evidence → renderOfflineVerdict. The FSM
// status, the reducer and the record verb already exist (Phase 2); B5 only feeds them.

const clazz = (body) => `CLASS zcl_x DEFINITION PUBLIC. PUBLIC SECTION. METHODS m. ENDCLASS.
CLASS zcl_x IMPLEMENTATION. METHOD m.
${body}
ENDMETHOD. ENDCLASS.`;
const abap = (body, filename = "zcl_x.clas.abap") => ({ filename, source: clazz(body) });

const GUARDED = [abap(`  AUTHORITY-CHECK OBJECT 'S_CARRID' ID 'ACTVT' FIELD '03'.
  IF sy-subrc <> 0. RETURN. ENDIF.
  COMMIT WORK.`)];
const CLEAN_FINDINGS = { findings: [] };
const NODE = { canonical_sig: "N1" };
const BASELINES = { atcBaseline: {}, covBaseline: {} };

// ---------------------------------------------------------------- the §4.4 checkpoint split

test("§4.4 split: auth_coverage is a TOP-LEVEL sibling, and invariants carries exactly 3 keys", () => {
  const b = assembleBundle(GUARDED);
  const cp = offlineCheckpoint(b, b, { findings: CLEAN_FINDINGS });
  assert.deepEqual(Object.keys(cp.invariants).sort(), ["auth_delta", "intact", "violations"]);
  assert.equal(cp.invariants.auth_coverage, undefined, "auth_coverage must NOT be nested under invariants");
  assert.deepEqual(Object.keys(cp.auth_coverage).sort(), ["lost", "lost_scopes"]);
});

test("the split is LOAD-BEARING: proven auth loss must BLOCK (nesting it would silently disable the conjunct)", () => {
  const before = assembleBundle(GUARDED);
  const after = assembleBundle([abap(`  AUTHORITY-CHECK OBJECT 'S_OTHER' ID 'ACTVT' FIELD '03'.
  IF sy-subrc <> 0. RETURN. ENDIF.
  COMMIT WORK.`)]);
  const cp = offlineCheckpoint(before, after, { findings: CLEAN_FINDINGS });
  assert.equal(cp.auth_coverage.lost, true);
  const out = renderOfflineNodeVerdict(NODE, { before, after, findings: CLEAN_FINDINGS, baselines: BASELINES, beforeFiles: GUARDED, afterFiles: GUARDED });
  assert.equal(out.provisional, false);
  assert.ok(out.reasons.includes("auth-coverage-lost"), `reasons: ${out.reasons}`);
});

test("the checkpoint carries parity(diff) and the asserted ATC counts", () => {
  const b = assembleBundle(GUARDED);
  const cp = offlineCheckpoint(b, b, { findings: CLEAN_FINDINGS });
  assert.equal(cp.parity.verdict, "PASS_STRUCTURAL");
  assert.equal(cp.parity.score, 1);
  assert.equal(cp.atc_p1, 0);
  assert.equal(cp.atc_p2, 0);
});

test("attestations and block_reason pass through only when supplied", () => {
  const b = assembleBundle(GUARDED);
  assert.equal(offlineCheckpoint(b, b, { findings: CLEAN_FINDINGS }).block_reason, undefined);
  const cp = offlineCheckpoint(b, b, { findings: CLEAN_FINDINGS, attestations: { auth_equivalence: "sec-reviewer" }, block_reason: "NO_RELEASED_SUCCESSOR" });
  assert.equal(cp.attestations.auth_equivalence, "sec-reviewer");
  assert.equal(cp.block_reason, "NO_RELEASED_SUCCESSOR");
});

// ---------------------------------------------------------------- the offline ratchet evidence

test("evidence counts p1/p2 and routes ONLY priority-3 to atc_warns (info is neither gate nor ratchet)", () => {
  const findings = { findings: [
    { severity: "priority-1", file: "a.abap", line: 1 },
    { severity: "priority-2", file: "a.abap", line: 2 },
    { severity: "priority-2", file: "a.abap", line: 3 },
    { severity: "priority-3", file: "a.abap", line: 4 },
    { severity: "info", file: "a.abap", line: 5 },
  ] };
  const e = offlineEvidence({ findings, beforeFiles: [], afterFiles: [] });
  assert.equal(e.atc_p1, 1);
  assert.equal(e.atc_p2, 2);
  assert.deepEqual(e.atc_warns, [{ file: "a.abap", line: 4 }]);
});

test("evidence drops unmatchable warns rather than emitting a malformed shape the gate fails closed on", () => {
  const findings = { findings: [
    { severity: "priority-3", file: "a.abap", line: 4 },
    { severity: "priority-3", file: "a.abap" },
    { severity: "priority-3", line: 7 },
  ] };
  assert.deepEqual(offlineEvidence({ findings, beforeFiles: [], afterFiles: [] }).atc_warns, [{ file: "a.abap", line: 4 }]);
});

// ---------------------------------------------------------------- the changed-line join key

test("changedLines: an identical file set has NO changed lines (the ratchet must not count carried debt)", () => {
  const files = [{ filename: "a.abap", source: "LINE ONE.\nLINE TWO.\n" }];
  assert.deepEqual(changedLines(files, files), []);
});

test("changedLines: only genuinely new lines count; a MOVED identical line is not a change", () => {
  const before = [{ filename: "a.abap", source: "ALPHA.\nBETA.\nGAMMA.\n" }];
  const after = [{ filename: "a.abap", source: "GAMMA.\nALPHA.\nDELTA.\n" }];
  assert.deepEqual(changedLines(before, after), [{ file: "a.abap", lines: [3] }], "only DELTA is new; GAMMA/ALPHA moved");
});

test("changedLines: a duplicate added line counts (multiset, not set)", () => {
  const before = [{ filename: "a.abap", source: "X.\n" }];
  const after = [{ filename: "a.abap", source: "X.\nX.\n" }];
  assert.deepEqual(changedLines(before, after), [{ file: "a.abap", lines: [2] }]);
});

test("changedLines: a wholly new after-file has every line changed; a deleted file contributes none", () => {
  const before = [{ filename: "gone.abap", source: "OLD.\n" }];
  const after = [{ filename: "new.abap", source: "A.\nB.\n" }];
  assert.deepEqual(changedLines(before, after), [{ file: "new.abap", lines: [1, 2] }]);
});

test("changedLines: blank lines are ignored and files are sorted deterministically", () => {
  const before = [];
  const after = [{ filename: "z.abap", source: "Z.\n" }, { filename: "a.abap", source: "\n\nA.\n" }];
  assert.deepEqual(changedLines(before, after), [{ file: "a.abap", lines: [3] }, { file: "z.abap", lines: [1] }]);
});

// ---------------------------------------------------------------- the composed seam

test("a clean unchanged node rests PROVISIONAL — and never GREEN (P6)", () => {
  const b = assembleBundle(GUARDED);
  const out = renderOfflineNodeVerdict(NODE, { before: b, after: b, findings: CLEAN_FINDINGS, baselines: BASELINES, beforeFiles: GUARDED, afterFiles: GUARDED });
  assert.equal(out.provisional, true);
  assert.equal(out.verdict.verdict, "PROVISIONAL");
  assert.equal(out.gate.verdict, "PASS");
  assert.equal(out.green, undefined, "offline NEVER GREENs");
});

test("a priority-2 finding hard-blocks (C3: SAP blocks transport on P1 AND P2)", () => {
  const b = assembleBundle(GUARDED);
  const findings = { findings: [{ severity: "priority-2", file: "zcl_x.clas.abap", line: 3 }] };
  const out = renderOfflineNodeVerdict(NODE, { before: b, after: b, findings, baselines: BASELINES, beforeFiles: GUARDED, afterFiles: GUARDED });
  assert.equal(out.provisional, false);
  assert.ok(out.reasons.includes("atc-p2-nonzero"));
});

const DCL = { filename: "zc_x.dcls.asdcls", source: `define role zc_x { grant select on zi_x where (carrid) = aspect pfcg_auth( S_CARRID, ACTVT ); }` };

test("an auth-footprint change owes an attestation before a provisional pass (L7/D1)", () => {
  const before = assembleBundle(GUARDED);
  // The RAP behaviour pool keeps an equivalent guard + save boundary, so only the AUTH footprint moved.
  const after = assembleBundle([DCL, abap(`  IF lt IS INITIAL. RETURN. ENDIF.
  COMMIT ENTITIES.`, "zbp_x.clas.abap")]);
  const inputs = { before, after, findings: CLEAN_FINDINGS, baselines: BASELINES, beforeFiles: GUARDED, afterFiles: GUARDED };
  const unattested = renderOfflineNodeVerdict(NODE, inputs);
  assert.equal(unattested.provisional, false);
  assert.ok(unattested.reasons.includes("auth-delta-unattested"), `reasons: ${unattested.reasons}`);
  assert.ok(!unattested.reasons.includes("auth-coverage-lost"), "the DCL grant COVERS S_CARRID — no coverage loss");

  const attested = renderOfflineNodeVerdict(NODE, { ...inputs, attestations: { auth_equivalence: "sec-reviewer" } });
  assert.equal(attested.provisional, true, "auth RELOCATED to DCL + attested → provisional pass, not a false BLOCK");
});

test("dropping the AUTHORITY-CHECK's guard clause routes to human review, not a silent pass", () => {
  // The canonical classic→managed-RAP shape: the check AND its `IF sy-subrc` guard both vanish
  // because the DCL now carries the authorization. Auth is relocated (no veto, no coverage loss),
  // but the lost branch + nesting are real structure loss — 1 − 0.20 − 0.15 = 0.65 → needs_review.
  const before = assembleBundle(GUARDED);
  const after = assembleBundle([DCL, abap(`  COMMIT ENTITIES.`, "zbp_x.clas.abap")]);
  const cp = offlineCheckpoint(before, after, { findings: CLEAN_FINDINGS });
  assert.equal(cp.auth_coverage.lost, false);
  assert.equal(cp.parity.score, 0.65);
  assert.equal(cp.parity.verdict, "needs_review");

  const out = renderOfflineNodeVerdict(NODE, { before, after, findings: CLEAN_FINDINGS, baselines: BASELINES, attestations: { auth_equivalence: "sec-reviewer" } });
  assert.equal(out.provisional, false);
  assert.ok(out.reasons.includes("parity-not-equivalent:needs_review"), `reasons: ${out.reasons}`);
});

test("the rendered result feeds recordProvisionalVerdict at PROVISIONAL_GATED (the seam closes)", () => {
  const PLAN = { plan_hash: "h1", nodes: [{ id: "N1", dependencies: [] }] };
  let s = initRun(PLAN);
  s = dispatch(PLAN, s, ["N1"]);
  s = applyProgress(PLAN, s, "N1", "GENERATED");
  s = applyProgress(PLAN, s, "N1", "SYNTAX_OK");
  s = applyProgress(PLAN, s, "N1", "PROVISIONAL_GATED");

  const b = assembleBundle(GUARDED);
  const out = renderOfflineNodeVerdict(NODE, { before: b, after: b, findings: CLEAN_FINDINGS, baselines: BASELINES, beforeFiles: GUARDED, afterFiles: GUARDED });
  assert.equal(recordProvisionalVerdict(PLAN, s, "N1", out).verdict_provisional.N1, true);
});

test("deterministic + total: repeated renders are deep-equal; empty inputs never throw", () => {
  const b = assembleBundle(GUARDED);
  const inputs = { before: b, after: b, findings: CLEAN_FINDINGS, baselines: BASELINES, beforeFiles: GUARDED, afterFiles: GUARDED };
  assert.deepEqual(renderOfflineNodeVerdict(NODE, inputs), renderOfflineNodeVerdict(NODE, inputs));
  assert.doesNotThrow(() => offlineCheckpoint(undefined, undefined, {}));
  assert.doesNotThrow(() => offlineEvidence({}));
  assert.doesNotThrow(() => changedLines(undefined, undefined));
});
