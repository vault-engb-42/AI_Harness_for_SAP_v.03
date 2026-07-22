import { test } from "node:test";
import assert from "node:assert/strict";
import { offlineEvidence, offlineCheckpoint, renderOfflineNodeVerdict } from "../src/node/offline-checkpoint.js";
import { assembleBundle } from "../src/extract/bundle.js";

// gap-2b B6.5 remediation — F5. The producer ERASED ABSENCE.
//
// Every hard conjunct downstream fails CLOSED on `undefined` (ratchet.js:134-135,
// verdict.js:134-135). But `atcCounts` mapped an absent — or ERRORED — findings document to
// `atc_p1 = atc_p2 = 0`, and `changedLines` mapped absent file lists to `[]`, which is a
// well-formed array. So the producer manufactured CLEAN evidence out of NO evidence and every
// fail-closed guard downstream became unreachable. `cli.js:214-216` already forbids exactly this
// on the ONLINE path ("NO ?? [] fallback … F1"); the offline path diverged from it.
//
// Absence must stay absent. The judges need no change — they already do the right thing.

const clazz = (body) => `CLASS zcl_x DEFINITION PUBLIC. PUBLIC SECTION. METHODS m. ENDCLASS.
CLASS zcl_x IMPLEMENTATION. METHOD m.
${body}
ENDMETHOD. ENDCLASS.`;
const FILES = [{ filename: "zcl_x.clas.abap", source: clazz("  COMMIT WORK.") }];
const NODE = { canonical_sig: "N1" };
const BASELINES = { atcBaseline: {}, covBaseline: {} };
const CLEAN = { findings: [] };

test("F5: an ABSENT findings document yields undefined counts, never a fabricated zero", () => {
  const e = offlineEvidence({});
  assert.equal(e.atc_p1, undefined);
  assert.equal(e.atc_p2, undefined);
  assert.equal(e.atc_warns, undefined);
});

test("F5: an ERRORED findings document is absence too — a crashed analyser is not a clean one", () => {
  const e = offlineEvidence({ findings: { error: "analyzePackage crashed" } });
  assert.equal(e.atc_p1, undefined);
  assert.equal(e.atc_p2, undefined);
});

test("F5: a genuinely EMPTY findings array is real evidence of zero", () => {
  const e = offlineEvidence({ findings: { findings: [] }, afterFiles: FILES });
  assert.equal(e.atc_p1, 0);
  assert.equal(e.atc_p2, 0);
  assert.deepEqual(e.atc_warns, []);
});

test("F5: absent file lists yield undefined diff_changed_lines, not an inert empty array", () => {
  assert.equal(offlineEvidence({ findings: CLEAN }).diff_changed_lines, undefined);
  assert.deepEqual(offlineEvidence({ findings: CLEAN, afterFiles: [] }).diff_changed_lines, []);
});

test("F5: the checkpoint carries the same absence, so offlineVerdict's ATC conjuncts fail closed", () => {
  const cp = offlineCheckpoint(assembleBundle(FILES), assembleBundle(FILES), {});
  assert.equal(cp.atc_p1, undefined);
  assert.equal(cp.atc_p2, undefined);
});

test("F5 END TO END: a node with NO findings document BLOCKS on both ATC conjuncts", () => {
  const b = assembleBundle(FILES);
  const out = renderOfflineNodeVerdict(NODE, { before: b, after: b, baselines: BASELINES, afterFiles: FILES });
  assert.equal(out.provisional, false, "this rested PROVISIONAL with live priority-1s before");
  assert.ok(out.reasons.includes("atc-p1-nonzero"), `reasons: ${out.reasons}`);
  assert.ok(out.reasons.includes("atc-p2-nonzero"), `reasons: ${out.reasons}`);
});

test("F5 END TO END: omitting the file evidence BLOCKS instead of silently disabling the WARN ratchet", () => {
  const b = assembleBundle(FILES);
  const out = renderOfflineNodeVerdict(NODE, { before: b, after: b, findings: CLEAN, baselines: BASELINES });
  assert.equal(out.provisional, false);
  assert.ok(out.reasons.includes("diff-changed-lines-missing"), `reasons: ${out.reasons}`);
});

test("a node with COMPLETE evidence still rests provisional (the guard is not a blanket block)", () => {
  const b = assembleBundle(FILES);
  const out = renderOfflineNodeVerdict(NODE, { before: b, after: b, findings: CLEAN, baselines: BASELINES, afterFiles: FILES, beforeFiles: FILES });
  assert.equal(out.provisional, true, `reasons: ${out.reasons}`);
});
