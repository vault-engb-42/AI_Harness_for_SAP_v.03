import { test } from "node:test";
import assert from "node:assert/strict";
import { proposeSeams, applyResolution, lookupLearnedSeam, memberSigSetKey } from "../src/exception/cycle-gate.js";

// §3.4 #4 (L5) — the break-the-cycle gate. proposeSeams wraps graph/feedback's
// minFeedbackArcSet; resolved seams are LEARNED keyed by member-signature-set, so an
// identical cycle in a later run auto-proposes the prior resolution with raised
// confidence. The human approves a CUT/COGEN_RAP_BO/SPROUT_DEFER — never an ordering.
// Pure copy-on-write over the seam-memory; timestamps injected.

const ring = (ids) => ids.map((id, i) => [id, ids[(i + 1) % ids.length]]);
const SIGS = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];
const SCC = { members: SIGS, edges: ring(SIGS) };
const CUT = { kind: "CUT", edge: [SIGS[0], SIGS[1]] };

test("memberSigSetKey is canonical — order-independent, content-derived", () => {
  const k1 = memberSigSetKey([SIGS[2], SIGS[0], SIGS[1]]);
  assert.equal(k1, memberSigSetKey(SIGS));
  assert.match(k1, /^[0-9a-f]{64}$/);
  assert.notEqual(k1, memberSigSetKey(SIGS.slice(0, 2)));
});

test("a fresh cycle proposes computed seams (no learned entry)", () => {
  const p = proposeSeams(SCC, 1, { learned: {} });
  assert.equal(p.learned, null);
  assert.ok(p.seams.length >= 1, "minFeedbackArcSet candidates");
  assert.ok(p.seams[0].source && p.seams[0].target);
  assert.ok(p.sub_components.every((c) => c.length <= 1));
});

test("a resolved cycle is learned; the identical cycle later auto-proposes it with RAISED confidence", () => {
  let memory = { learned: {} };
  memory = applyResolution(memory, SIGS, CUT, { ts: "T1" });
  const first = lookupLearnedSeam(memory, SIGS);
  assert.deepEqual(first.resolution, CUT);
  assert.equal(first.resolved_at, "T1");
  const c1 = first.confidence;
  assert.ok(c1 > 0 && c1 < 1);

  memory = applyResolution(memory, SIGS, CUT, { ts: "T2" }); // re-confirmed on a later run
  const second = lookupLearnedSeam(memory, SIGS);
  assert.ok(second.confidence > c1, "confidence rises on re-confirmation");
  assert.ok(second.confidence < 1, "never certainty");

  const p = proposeSeams(SCC, 1, memory);
  assert.deepEqual(p.learned.resolution, CUT, "the prior resolution leads the proposal");
  assert.equal(p.learned.confidence, second.confidence);
  assert.ok(p.seams.length >= 1, "fresh candidates still listed beneath the learned one");
});

test("a DIFFERENT member set never inherits another cycle's learning", () => {
  let memory = applyResolution({ learned: {} }, SIGS, CUT, { ts: "T1" });
  assert.equal(lookupLearnedSeam(memory, SIGS.slice(0, 2)), null);
  assert.equal(proposeSeams({ members: SIGS.slice(0, 2), edges: ring(SIGS.slice(0, 2)) }, 1, memory).learned, null);
});

test("resolutions are validated fail-closed against the §3.4 CycleResolution type", () => {
  const m = { learned: {} };
  assert.throws(() => applyResolution(m, SIGS, { kind: "CUT" }, { ts: "T" }), /edge/i);
  assert.throws(() => applyResolution(m, SIGS, { kind: "COGEN_RAP_BO" }, { ts: "T" }), /members/i);
  assert.throws(() => applyResolution(m, SIGS, { kind: "SPROUT_DEFER" }, { ts: "T" }), /member/i);
  assert.throws(() => applyResolution(m, SIGS, { kind: "SKIP_IT" }, { ts: "T" }), /kind/i);
  assert.deepEqual(m, { learned: {} }, "input memory untouched on every throw (copy-on-write)");
  // the valid shapes all record
  applyResolution(m, SIGS, { kind: "COGEN_RAP_BO", members: SIGS }, { ts: "T" });
  applyResolution(m, SIGS, { kind: "SPROUT_DEFER", member: SIGS[0] }, { ts: "T" });
});
