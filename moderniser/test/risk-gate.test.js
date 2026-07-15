import { test } from "node:test";
import assert from "node:assert/strict";
import { levelDisposition } from "../src/exception/risk-gate.js";

// §3.4 #2 (L2 risk gate) — the per-level pause is a human-approval batching rhythm over
// ALREADY-GREEN nodes only. All-clear → AUTO (advance silently); ANY flagged node → one
// RISK_LEVEL_REVIEW ('REVIEW') naming the flagged nodes + reasons. Missing evidence is
// flagged, never assumed clear (fail-closed). Pure, deterministic.

const clear = (sig) => ({
  sig,
  atc_p1: 0,
  atc_p2: 0,
  parity: "equivalent",
  touches_ddic: false,
  touches_invariant: false,
  touches_data_source: false,
  touches_money: false,
  blast_total: 0,
});
const A = "a".repeat(64);
const B = "b".repeat(64);

test("an all-clear level auto-advances silently", () => {
  const r = levelDisposition([clear(A), { ...clear(B), parity: "PASS_STRUCTURAL" }], { blastThreshold: 10 });
  assert.equal(r.disposition, "AUTO");
  assert.deepEqual(r.flagged, []);
});

test("each risk dimension flags REVIEW and names the reason", () => {
  const cases = [
    [{ ...clear(A), atc_p1: 1 }, /atc/i],
    [{ ...clear(A), parity: "needs_review" }, /parity/i],
    [{ ...clear(A), touches_ddic: true }, /ddic/i],
    [{ ...clear(A), touches_invariant: true }, /invariant/i],
    [{ ...clear(A), touches_data_source: true }, /data.source/i],
    [{ ...clear(A), touches_money: true }, /money/i],
    [{ ...clear(A), blast_total: 11 }, /blast/i],
  ];
  for (const [node, reasonRe] of cases) {
    const r = levelDisposition([node, clear(B)], { blastThreshold: 10 });
    assert.equal(r.disposition, "REVIEW", JSON.stringify(node));
    assert.equal(r.flagged.length, 1, "one flagged node → ONE review, others named clear");
    assert.equal(r.flagged[0].sig, A);
    assert.ok(r.flagged[0].reasons.some((x) => reasonRe.test(x)), `${reasonRe}`);
  }
});

test("C3: a priority-2 ATC finding flags REVIEW (P6 gate blocks priority-1 AND priority-2)", () => {
  const r = levelDisposition([{ ...clear(A), atc_p2: 1 }, clear(B)], { blastThreshold: 10 });
  assert.equal(r.disposition, "REVIEW");
  assert.equal(r.flagged.length, 1);
  assert.equal(r.flagged[0].sig, A);
  assert.ok(r.flagged[0].reasons.some((x) => /atc/i.test(x)));
});

test("blast at exactly the threshold is clear; one over is flagged", () => {
  assert.equal(levelDisposition([{ ...clear(A), blast_total: 10 }], { blastThreshold: 10 }).disposition, "AUTO");
  assert.equal(levelDisposition([{ ...clear(A), blast_total: 11 }], { blastThreshold: 10 }).disposition, "REVIEW");
});

test("missing evidence is FLAGGED, never assumed clear (fail-closed)", () => {
  const r = levelDisposition([{ sig: A }], { blastThreshold: 10 });
  assert.equal(r.disposition, "REVIEW");
  assert.ok(r.flagged[0].reasons.length >= 1);
});

test("an empty level auto-advances; a missing threshold fails closed", () => {
  assert.equal(levelDisposition([], { blastThreshold: 10 }).disposition, "AUTO");
  assert.throws(() => levelDisposition([clear(A)], {}), /threshold/i);
});
