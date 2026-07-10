import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ratchetGate, onPass, warnOnChangedLines } from "../src/state/ratchet.js";

// §3.3 #4 + §6.4 (L6, L10) — the deterministic ratchet gate. WARN delta on CHANGED LINES
// only, vs the node's own baseline seeded ∞ (first pass establishes, later passes only-down);
// coverage only-up (per-object ?? the shipped global floor); atc_p1 == 0 is the hard,
// non-overridable conjunct; parity-required nodes need a proven bite before coverage counts.
// Pure: baselines in → verdict + NEW baselines out; persistence is the loop's job.

const HERE = dirname(fileURLToPath(import.meta.url));

const node = (o = {}) => ({
  canonical_sig: "sig-1",
  parity_required: false,
  diff_changed_lines: [{ file: "zprog.abap", lines: [10, 11, 12] }],
  ...o,
});
const evidence = (o = {}) => ({
  atc_p1: 0,
  atc_warns: [],
  coverage: { pct: 0.5, bite_proven: false },
  ...o,
});
const empty = () => ({ atcBaseline: { per_object: {} }, covBaseline: { per_object: {} } });

// --- warnOnChangedLines (L6(2)) ---

test("counts only warns landing on this diff's changed lines", () => {
  const diff = [{ file: "a.abap", lines: [5, 6] }, { file: "b.abap", lines: [1] }];
  const warns = [
    { file: "a.abap", line: 5 }, //   changed → counts
    { file: "a.abap", line: 99 }, //  same file, untouched line → carried debt, not counted
    { file: "b.abap", line: 1 }, //   changed → counts
    { file: "c.abap", line: 5 }, //   other file → not counted
  ];
  assert.equal(warnOnChangedLines(diff, warns), 2);
});

test("empty diff or empty warns → 0", () => {
  assert.equal(warnOnChangedLines([], [{ file: "a.abap", line: 1 }]), 0);
  assert.equal(warnOnChangedLines([{ file: "a.abap", lines: [1] }], []), 0);
});

// --- ratchetGate ---

test("first pass (no baseline): seed ∞ — any delta passes and establishes", () => {
  const n = node();
  const ev = evidence({ atc_warns: [{ file: "zprog.abap", line: 10 }, { file: "zprog.abap", line: 11 }] });
  const r = ratchetGate(n, ev, empty());
  assert.equal(r.verdict, "PASS");
  assert.equal(r.delta, 2);
  const next = onPass(n, ev, empty());
  assert.equal(next.atcBaseline.per_object["sig-1"], 2, "baseline established at the observed delta");
});

test("later pass: delta ≤ its own baseline passes; delta above it BLOCKs (only-down)", () => {
  const base = { atcBaseline: { per_object: { "sig-1": 2 } }, covBaseline: { per_object: {} } };
  const at = (k) => evidence({ atc_warns: Array.from({ length: k }, (_, i) => ({ file: "zprog.abap", line: 10 + (i % 3) })) });
  assert.equal(ratchetGate(node(), at(2), base).verdict, "PASS", "equal is fine");
  assert.equal(ratchetGate(node(), at(1), base).verdict, "PASS", "down is fine");
  const r = ratchetGate(node(), at(3), base);
  assert.equal(r.verdict, "BLOCK");
  assert.ok(r.reasons.some((x) => x.includes("warn-delta")), "names the regressed ratchet");
});

test("atc_p1 != 0 BLOCKs regardless of a passing delta — hard, non-overridable", () => {
  const r = ratchetGate(node(), evidence({ atc_p1: 1 }), empty());
  assert.equal(r.verdict, "BLOCK");
  assert.ok(r.reasons.includes("atc-p1-nonzero"));
});

test("missing evidence fails CLOSED: absent atc_p1, non-array warns, non-finite coverage", () => {
  assert.equal(ratchetGate(node(), evidence({ atc_p1: undefined }), empty()).verdict, "BLOCK");
  assert.equal(ratchetGate(node(), evidence({ atc_warns: undefined }), empty()).verdict, "BLOCK");
  assert.equal(ratchetGate(node(), evidence({ coverage: {} }), empty()).verdict, "BLOCK");
  assert.equal(ratchetGate(node(), {}, empty()).verdict, "BLOCK");
});

test("a parity-required node needs a PROVEN bite (L6(1)); a non-parity node does not", () => {
  const pn = node({ parity_required: true });
  assert.equal(ratchetGate(pn, evidence(), empty()).verdict, "BLOCK", "unbitten");
  assert.equal(ratchetGate(pn, evidence({ coverage: { pct: 0.5, bite_proven: true } }), empty()).verdict, "PASS");
  assert.equal(ratchetGate(node(), evidence(), empty()).verdict, "PASS", "bite not required without parity classes");
});

test("coverage is only-up vs the node's own baseline", () => {
  const base = { atcBaseline: { per_object: {} }, covBaseline: { per_object: { "sig-1": { pct: 0.71, bite_proven: true } } } };
  assert.equal(ratchetGate(node(), evidence({ coverage: { pct: 0.7, bite_proven: false } }), base).verdict, "BLOCK");
  assert.equal(ratchetGate(node(), evidence({ coverage: { pct: 0.71, bite_proven: false } }), base).verdict, "PASS");
  assert.equal(ratchetGate(node(), evidence({ coverage: { pct: 0.8, bite_proven: false } }), base).verdict, "PASS");
});

test("with no per-object coverage baseline, the SHIPPED global floor applies (else 0)", () => {
  const floored = { atcBaseline: { per_object: {} }, covBaseline: { coverage_floor_pct: 0.4, per_object: {} } };
  assert.equal(ratchetGate(node(), evidence({ coverage: { pct: 0.39, bite_proven: false } }), floored).verdict, "BLOCK");
  assert.equal(ratchetGate(node(), evidence({ coverage: { pct: 0.4, bite_proven: false } }), floored).verdict, "PASS");
  assert.equal(ratchetGate(node(), evidence({ coverage: { pct: 0, bite_proven: false } }), empty()).verdict, "PASS", "no floor → 0");
});

test("tolerates the SHIPPED baseline file shapes (atc-baseline has no per_object map yet)", () => {
  const atcBaseline = JSON.parse(readFileSync(join(HERE, "..", "..", ".claude", "state", "atc-baseline.json"), "utf8"));
  const covBaseline = JSON.parse(readFileSync(join(HERE, "..", "..", ".claude", "state", "abapunit-baseline.json"), "utf8"));
  const r = ratchetGate(node(), evidence(), { atcBaseline, covBaseline });
  assert.equal(r.verdict, "PASS", "missing per_object → seed ∞ / floor 0 — first pass establishes");
  const next = onPass(node(), evidence(), { atcBaseline, covBaseline });
  assert.equal(next.atcBaseline.per_object["sig-1"], 0);
  assert.equal(atcBaseline.per_object, undefined, "the input file object is not mutated");
});

test("BLOCK reasons name every failed conjunct (collected, not short-circuited)", () => {
  const r = ratchetGate(node({ parity_required: true }), evidence({ atc_p1: 3, coverage: { pct: NaN } }), empty());
  assert.equal(r.verdict, "BLOCK");
  assert.ok(r.reasons.includes("atc-p1-nonzero"));
  assert.ok(r.reasons.includes("bite-not-proven"));
  assert.ok(r.reasons.some((x) => x.includes("coverage")));
});

// --- onPass ---

test("onPass returns NEW baselines (inputs untouched) recording delta and the ACTUAL bite state", () => {
  const base = empty();
  const ev = evidence({ atc_warns: [{ file: "zprog.abap", line: 10 }], coverage: { pct: 0.6, bite_proven: false } });
  const next = onPass(node(), ev, base);
  assert.equal(next.atcBaseline.per_object["sig-1"], 1);
  assert.deepEqual(next.covBaseline.per_object["sig-1"], { pct: 0.6, bite_proven: false });
  assert.deepEqual(base.atcBaseline.per_object, {}, "input atcBaseline not mutated");
  assert.deepEqual(base.covBaseline.per_object, {}, "input covBaseline not mutated");
});

test("onPass fails closed when the gate would BLOCK — baselines are never touched on BLOCK", () => {
  assert.throws(() => onPass(node(), evidence({ atc_p1: 5 }), empty()), /BLOCK/);
});

test("ratchet sequence is monotone: establish 2 → tighten to 1 → 2 now BLOCKs", () => {
  const n = node();
  const at = (k) => evidence({ atc_warns: Array.from({ length: k }, (_, i) => ({ file: "zprog.abap", line: 10 + (i % 3) })) });
  let b = empty();
  b = onPass(n, at(2), b); //          establish at 2
  assert.equal(b.atcBaseline.per_object["sig-1"], 2);
  b = onPass(n, at(1), b); //          tighten to 1
  assert.equal(b.atcBaseline.per_object["sig-1"], 1);
  assert.equal(ratchetGate(n, at(2), b).verdict, "BLOCK", "quality only tightens — 2 is no longer acceptable");
});
