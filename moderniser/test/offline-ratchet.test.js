import { test } from "node:test";
import assert from "node:assert/strict";
import { offlineRatchetGate, ratchetGate } from "../src/state/ratchet.js";

// offlineRatchetGate PARTITIONS ratchetGate: it drops the DEV-only coverage % and parity-bite
// conjuncts (offline can't run ABAP Unit) and keeps atc_p1 + diff validity + the warn-delta
// ratchet — exactly as offlineVerdict drops activated/reconciled/unit. The warn EVIDENCE
// (atc_warns on changed lines) is fed by the gap-2b offline extractor; here it is synthetic.

const node = { canonical_sig: "N1", parity_required: true, diff_changed_lines: [{ file: "z", lines: [1] }] };
const cleanEvidence = { atc_p1: 0, atc_warns: [] }; // offline has NO coverage evidence
const baselines = { atcBaseline: {}, covBaseline: {} };

test("offlineRatchetGate PASSes without coverage/bite — the DEV-only conjuncts are excluded", () => {
  const r = offlineRatchetGate(node, cleanEvidence, baselines);
  assert.equal(r.verdict, "PASS");
  assert.deepEqual(r.reasons, []);
  assert.equal(r.atc_warn_delta, 0, "no baseline ceiling → seed-∞ establish-pass 0");
});

test("the SAME inputs BLOCK the online ratchetGate (proves offline drops coverage + bite)", () => {
  const r = ratchetGate(node, cleanEvidence, baselines);
  assert.equal(r.verdict, "BLOCK");
  assert.ok(r.reasons.includes("coverage-missing"));
  assert.ok(r.reasons.includes("bite-not-proven"));
});

test("offlineRatchetGate keeps the warn-delta and diff conjuncts", () => {
  const ev = { atc_p1: 0, atc_warns: [{ file: "z", line: 1 }] };
  const bl = { atcBaseline: { per_object: { N1: 0 } }, covBaseline: {} };
  const r = offlineRatchetGate(node, ev, bl);
  assert.equal(r.verdict, "BLOCK");
  assert.ok(r.reasons.some((x) => x.startsWith("warn-delta-regressed")));
  assert.ok(offlineRatchetGate({ canonical_sig: "N1" }, cleanEvidence, baselines).reasons.includes("diff-changed-lines-missing"));
});

test("offlineRatchetGate keeps the atc_p1 hard conjunct", () => {
  assert.ok(offlineRatchetGate(node, { atc_p1: 2, atc_warns: [] }, baselines).reasons.includes("atc-p1-nonzero"));
});
