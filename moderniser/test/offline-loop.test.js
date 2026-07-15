import { test } from "node:test";
import assert from "node:assert/strict";
import { initRun, dispatch, applyProgress } from "../src/sched/loop.js";
import { recordProvisionalVerdict, renderOfflineVerdict } from "../src/sched/verdict-ops.js";

// Phase 2 offline seam in the reducer: SYNTAX_OK forks to PROVISIONAL_GATED (the offline rest
// state), recordProvisionalVerdict records the offline verdict there (mirroring recordVerdict's
// GATED-only guard), the offline retry bumps the cycle counter, and a regenerate voids any stale
// provisional verdict. The offline-verdict input (checkpoint/warn evidence) is fed by gap-2b.

const PLAN = { plan_hash: "h1", nodes: [{ id: "N1", dependencies: [] }] };

function toProvisionalGated() {
  let s = initRun(PLAN);
  s = dispatch(PLAN, s, ["N1"]); // PENDING → GROUNDED
  s = applyProgress(PLAN, s, "N1", "GENERATED"); // GROUNDED → GENERATED
  s = applyProgress(PLAN, s, "N1", "SYNTAX_OK"); // GENERATED → SYNTAX_OK
  s = applyProgress(PLAN, s, "N1", "PROVISIONAL_GATED"); // SYNTAX_OK → PROVISIONAL_GATED
  return s;
}

test("initRun seeds a verdict_provisional map", () => {
  assert.deepEqual(initRun(PLAN).verdict_provisional, {});
});

test("SYNTAX_OK forks to PROVISIONAL_GATED via applyProgress (the offline rest state)", () => {
  assert.equal(toProvisionalGated().status.N1, "PROVISIONAL_GATED");
});

test("recordProvisionalVerdict records the result at PROVISIONAL_GATED", () => {
  const s = recordProvisionalVerdict(PLAN, toProvisionalGated(), "N1", { provisional: true });
  assert.equal(s.verdict_provisional.N1, true);
});

test("recordProvisionalVerdict refuses a node not at PROVISIONAL_GATED (mirrors recordVerdict's GATED-only)", () => {
  let s = initRun(PLAN);
  s = dispatch(PLAN, s, ["N1"]);
  s = applyProgress(PLAN, s, "N1", "GENERATED");
  s = applyProgress(PLAN, s, "N1", "SYNTAX_OK");
  assert.throws(() => recordProvisionalVerdict(PLAN, s, "N1", { provisional: true }), /not PROVISIONAL_GATED/);
});

test("a PROVISIONAL_GATED→GENERATED retry bumps the cycle counter (else unbounded offline retry)", () => {
  let s = toProvisionalGated();
  assert.equal(s.cycle.N1 ?? 0, 0);
  s = applyProgress(PLAN, s, "N1", "GENERATED");
  assert.equal(s.cycle.N1, 1, "the offline retry incremented the cycle counter");
});

test("regenerating voids a recorded provisional verdict (a stale verdict must not bless a new artifact)", () => {
  let s = recordProvisionalVerdict(PLAN, toProvisionalGated(), "N1", { provisional: true });
  assert.equal(s.verdict_provisional.N1, true);
  s = applyProgress(PLAN, s, "N1", "GENERATED");
  assert.equal(s.verdict_provisional.N1, undefined, "voided on regeneration");
});

// renderOfflineVerdict composes the OFFLINE ratchet + offlineVerdict (Option A) — the offline
// analogue of renderVerdict, resting in `provisional` (never `green`). Warn evidence is synthetic
// here; gap-2b feeds it live.
const planNode = { canonical_sig: "N1", parity_required: false, diff_changed_lines: [{ file: "z", lines: [1] }] };
const cleanCheckpoint = { atc_p1: 0, invariants: { intact: true }, auth_coverage: { lost: false }, parity: { verdict: "equivalent" } };
const cleanEvidence = { atc_p1: 0, atc_warns: [] };
const baselines = { atcBaseline: {}, covBaseline: {} };

test("renderOfflineVerdict → provisional when both the offline ratchet and offlineVerdict pass", () => {
  const r = renderOfflineVerdict(planNode, cleanCheckpoint, cleanEvidence, baselines);
  assert.equal(r.gate.verdict, "PASS");
  assert.equal(r.verdict.verdict, "PROVISIONAL");
  assert.equal(r.provisional, true);
  assert.deepEqual(r.reasons, []);
  assert.equal(r.green, undefined, "offline renders `provisional`, never `green`");
});

test("renderOfflineVerdict is NOT provisional when the offline ratchet blocks on a warn-delta regression", () => {
  const ev = { atc_p1: 0, atc_warns: [{ file: "z", line: 1 }] };
  const bl = { atcBaseline: { per_object: { N1: 0 } }, covBaseline: {} };
  const r = renderOfflineVerdict(planNode, cleanCheckpoint, ev, bl);
  assert.equal(r.provisional, false);
  assert.ok(r.reasons.some((x) => x.startsWith("warn-delta-regressed")));
});

test("renderOfflineVerdict uses offlineVerdict — a DEV-only failing conjunct (unit) does NOT block", () => {
  const r = renderOfflineVerdict(planNode, { ...cleanCheckpoint, unit: { green: false }, activated: undefined }, cleanEvidence, baselines);
  assert.equal(r.provisional, true, "unit + activated are DEV-only, excluded offline");
});
