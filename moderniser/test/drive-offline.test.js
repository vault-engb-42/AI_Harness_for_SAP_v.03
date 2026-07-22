import { test } from "node:test";
import assert from "node:assert/strict";
import { driveOfflineVerdict, driveReport } from "../src/sched/drive.js";
import { initRun, dispatch, applyProgress } from "../src/sched/loop.js";
import { MAX_PHASE_RETRY_CYCLES } from "../src/state/node-status.js";

// gap-2b B6 — the driver's offline-verdict step. After the gap-2a rule gate passes, the node
// advances SYNTAX_OK → PROVISIONAL_GATED, the rendered offline verdict is recorded, and the driver
// decides: rest, regenerate-with-findings (budget permitting), or escalate to a human.
//
// The load-bearing decision is that an offline BLOCK is NOT one thing. A defect (ATC, P4, parity
// scope_reduced) is fixable by regenerating. An owed ATTESTATION is not — no amount of regeneration
// produces a security reviewer's signature, so routing it through the retry loop would burn the
// whole cycle budget and land a false ceiling BLOCK on every classic→RAP node, since relocating
// auth to DCL always sets auth_delta on the first pass.

const PLAN = { plan_hash: "h1", nodes: [{ id: "N1", object: "ZCL_X", wave: 0, dependencies: [] }] };
const pass = { provisional: true, reasons: [] };
const block = (...reasons) => ({ provisional: false, reasons });

function atSyntaxOk() {
  let s = initRun(PLAN);
  s = dispatch(PLAN, s, ["N1"]);
  s = applyProgress(PLAN, s, "N1", "GENERATED");
  return applyProgress(PLAN, s, "N1", "SYNTAX_OK");
}

test("a provisional pass advances to PROVISIONAL_GATED and records the verdict", () => {
  const { state, action } = driveOfflineVerdict(PLAN, atSyntaxOk(), "N1", pass);
  assert.equal(state.status.N1, "PROVISIONAL_GATED");
  assert.equal(state.verdict_provisional.N1, true);
  assert.equal(action.action, "provisional_complete", "offline rests provisionally — it NEVER completes GREEN (P6)");
});

test("a DEFECT block regenerates with the findings, inside budget", () => {
  const { state, action } = driveOfflineVerdict(PLAN, atSyntaxOk(), "N1", block("atc-p1-nonzero", "p4-invariant-broken"));
  assert.equal(state.status.N1, "GENERATED", "the PROVISIONAL_GATED→GENERATED retry edge");
  assert.equal(state.cycle.N1, 1, "the retry bumped the cycle counter (else unbounded offline retry)");
  assert.equal(action.action, "generate");
  assert.equal(action.packets[0].sig, "N1");
  assert.equal(action.packets[0].retry, true);
  assert.deepEqual(action.packets[0].findings, ["atc-p1-nonzero", "p4-invariant-broken"],
    "regenerate-WITH-findings — a bare retry would reproduce the same defect");
});

test("the regenerate voids the recorded verdict (a stale pass must not bless the new artifact)", () => {
  let s = driveOfflineVerdict(PLAN, atSyntaxOk(), "N1", pass).state;
  assert.equal(s.verdict_provisional.N1, true);
  s = applyProgress(PLAN, s, "N1", "GENERATED");
  s = applyProgress(PLAN, s, "N1", "SYNTAX_OK");
  const out = driveOfflineVerdict(PLAN, s, "N1", block("atc-p1-nonzero"));
  assert.equal(out.state.status.N1, "GENERATED");
  assert.equal(out.state.verdict_provisional.N1, undefined, "the fresh BLOCK verdict is voided again on re-entry");
});

test("at the cycle ceiling a defect block quarantines instead of retrying forever", () => {
  let s = atSyntaxOk();
  for (let i = 0; i < MAX_PHASE_RETRY_CYCLES; i++) {
    const out = driveOfflineVerdict(PLAN, s, "N1", block("atc-p1-nonzero"));
    s = out.state;
    if (i < MAX_PHASE_RETRY_CYCLES - 1) s = applyProgress(PLAN, s, "N1", "SYNTAX_OK");
  }
  assert.equal(s.cycle.N1, MAX_PHASE_RETRY_CYCLES);
  s = applyProgress(PLAN, s, "N1", "SYNTAX_OK");
  const out = driveOfflineVerdict(PLAN, s, "N1", block("atc-p1-nonzero"));
  assert.equal(out.state.status.N1, "BLOCK");
  assert.deepEqual(out.state.deferral_track.at(-1), { sig: "N1", reason: "OFFLINE_VERDICT_CEILING" });
  // A quarantined node RESTS (BLOCK is a rest state) — `blocked` is reserved for a WEDGED node that
  // is neither dispatchable nor rested. The offline pass is done; the proof bundle carries the BLOCK.
  assert.equal(out.action.action, "provisional_complete");
});

test("an OWED ATTESTATION escalates to a human and never touches the retry budget", () => {
  const s = atSyntaxOk();
  const out = driveOfflineVerdict(PLAN, s, "N1", block("auth-delta-unattested"));
  assert.equal(out.state.status.N1, "PROVISIONAL_GATED", "it rests — regeneration cannot produce a signature");
  assert.equal(out.state.verdict_provisional.N1, false);
  assert.equal(out.state.cycle.N1 ?? 0, 0, "the retry budget is untouched");
  assert.equal(out.action.action, "await_human");
  assert.deepEqual(out.action.nodes, ["N1"]);
  assert.deepEqual(out.action.escalations, [{ kind: "AUTH_EQUIVALENCE", node_ids: ["N1"] }]);
});

test("a needs_review parity band escalates PARITY_REVIEW, not a regenerate", () => {
  const out = driveOfflineVerdict(PLAN, atSyntaxOk(), "N1", block("parity-not-equivalent:needs_review"));
  assert.equal(out.action.action, "await_human");
  assert.deepEqual(out.action.escalations, [{ kind: "PARITY_REVIEW", node_ids: ["N1"] }]);
  assert.equal(out.state.cycle.N1 ?? 0, 0);
});

test("a parity VETO is a defect, not an attestable band — vetoes are never attestable (§7.5)", () => {
  for (const v of ["auth_vanished", "reassembly_broken", "scope_reduced"]) {
    const out = driveOfflineVerdict(PLAN, atSyntaxOk(), "N1", block(`parity-not-equivalent:${v}`));
    assert.equal(out.action.action, "generate", `${v} must regenerate, never await_human`);
  }
});

test("a MIXED block regenerates: a real defect outranks an owed attestation", () => {
  const out = driveOfflineVerdict(PLAN, atSyntaxOk(), "N1", block("auth-delta-unattested", "atc-p2-nonzero"));
  assert.equal(out.action.action, "generate", "fix the defect first — attesting a defective artifact is meaningless");
  assert.equal(out.state.cycle.N1, 1);
});

test("both attestable reasons at once raise both escalations, deduped and ordered", () => {
  const out = driveOfflineVerdict(PLAN, atSyntaxOk(), "N1", block("parity-not-equivalent:needs_review", "auth-delta-unattested"));
  assert.deepEqual(out.action.escalations, [
    { kind: "AUTH_EQUIVALENCE", node_ids: ["N1"] },
    { kind: "PARITY_REVIEW", node_ids: ["N1"] },
  ]);
});

test("replaying the same verdict at PROVISIONAL_GATED is idempotent (no double transition)", () => {
  const first = driveOfflineVerdict(PLAN, atSyntaxOk(), "N1", pass);
  const second = driveOfflineVerdict(PLAN, first.state, "N1", pass);
  assert.equal(second.state.status.N1, "PROVISIONAL_GATED");
  assert.deepEqual(second.action, first.action);
});

test("fails closed on an unknown node and on a node that has not reached SYNTAX_OK", () => {
  assert.throws(() => driveOfflineVerdict(PLAN, atSyntaxOk(), "NOPE", pass), /unknown node/);
  let s = initRun(PLAN);
  s = dispatch(PLAN, s, ["N1"]);
  assert.throws(() => driveOfflineVerdict(PLAN, s, "N1", pass), /GROUNDED/);
});

test("the online driveReport path is untouched by the offline step", () => {
  const { state, action } = driveReport(PLAN, atSyntaxOk(), "N1", "syntax_ok");
  assert.equal(state.status.N1, "SYNTAX_OK");
  assert.equal(action.action, "provisional_complete");
});
