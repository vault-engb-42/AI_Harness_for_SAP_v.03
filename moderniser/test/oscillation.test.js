import { test } from "node:test";
import assert from "node:assert/strict";
import { isOscillating, clusterOscillations, VERDICT_WINDOW } from "../src/exception/oscillation.js";
import { initRun, dispatch, applyProgress } from "../src/sched/loop.js";
import { oscillationClusters } from "../src/sched/drive.js";
import { recordProvisionalVerdict } from "../src/sched/verdict-ops.js";

// §3.4 #3 (L2, 7.6) — flip-count >= 2 over the last 5 verdicts marks a node oscillating
// (it cannot count toward the ratchet and hard-escalates); clustering by shared root
// signature (failing_atc_rule_id, shared_dep_id) turns one generator weakness into ONE
// escalation with N instances, never N storms. Pure, deterministic.

test("flips >= 2 over the LAST 5 verdicts marks oscillation", () => {
  assert.equal(isOscillating(["BLOCK", "GREEN", "BLOCK"]), true, "two flips");
  assert.equal(isOscillating(["BLOCK", "BLOCK", "GREEN"]), false, "one flip — converging, not oscillating");
  assert.equal(isOscillating(["GREEN", "GREEN", "GREEN"]), false);
  assert.equal(isOscillating(["BLOCK"]), false);
  assert.equal(isOscillating([]), false);
});

test("only the last 5 verdicts count — old thrash that settled does not escalate", () => {
  const settled = ["BLOCK", "GREEN", "BLOCK", "GREEN", /* last 5: */ "BLOCK", "BLOCK", "BLOCK", "BLOCK", "GREEN"];
  assert.equal(isOscillating(settled), false, "one flip in the window");
  const thrashing = ["GREEN", "GREEN", /* last 5: */ "BLOCK", "GREEN", "BLOCK", "GREEN", "BLOCK"];
  assert.equal(isOscillating(thrashing), true);
});

test("clusters group by (top_fail_rule_id, shared_dep): one weakness = ONE escalation with N instances", () => {
  const node = (sig, rule, dep, verdicts) => ({ sig, top_fail_rule_id: rule, shared_dep: dep, verdicts });
  const osc = ["BLOCK", "GREEN", "BLOCK"];
  const clusters = clusterOscillations([
    node("a".repeat(64), "talos-select-in-loop", "SKB1", osc),
    node("b".repeat(64), "talos-select-in-loop", "SKB1", osc),
    node("c".repeat(64), "talos-cloud-006-write", "SKB1", osc),
    node("d".repeat(64), "talos-select-in-loop", "SKB1", ["BLOCK", "BLOCK"]), // not oscillating → excluded
  ]);
  assert.equal(clusters.length, 2, "two distinct root signatures");
  const big = clusters.find((c) => c.node_ids.length === 2);
  assert.equal(big.kind, "OSCILLATION");
  assert.equal(big.root_signature, "talos-select-in-loop|SKB1");
  assert.deepEqual(big.node_ids, ["a".repeat(64), "b".repeat(64)].sort());
});

test("deterministic: cluster order is stable regardless of input order", () => {
  const node = (sig, rule, dep) => ({ sig, top_fail_rule_id: rule, shared_dep: dep, verdicts: ["BLOCK", "GREEN", "BLOCK"] });
  const nodes = [node("a".repeat(64), "r2", "D2"), node("b".repeat(64), "r1", "D1"), node("c".repeat(64), "r1", "D1")];
  assert.equal(
    JSON.stringify(clusterOscillations(nodes)),
    JSON.stringify(clusterOscillations([...nodes].reverse())),
  );
});

test("no oscillating nodes → no clusters; missing fields group under 'unknown' rather than crash", () => {
  assert.deepEqual(clusterOscillations([]), []);
  const c = clusterOscillations([{ sig: "e".repeat(64), verdicts: ["BLOCK", "GREEN", "BLOCK"] }]);
  assert.equal(c.length, 1);
  assert.equal(c[0].root_signature, "unknown|unknown", "fail-safe grouping, not a TypeError");
});

// ---- WIRING: the detector had no input (operator-ratified OWED 2026-09-11, closed 2026-09-13) ----
//
// `isOscillating` wants a CHRONOLOGICAL verdict series and state kept only the LATEST verdict per node as a
// scalar, so the detector had nothing to detect on and zero production callers - built, tested, unreachable.
//
// THE SERIES MUST SURVIVE RE-ENTRY, and that is the whole subtlety. Re-entry deliberately VOIDS the
// recorded verdict (a stale verdict must never bless a regenerated artifact) - but oscillation IS
// flip-flopping ACROSS regeneration cycles, so clearing the history with the verdict would make the
// detector permanently blind to the only thing it exists to see.

test("the verdict SERIES records each verdict in order, and a flip pattern reads as thrash", () => {
  // The FSM caps regeneration at MAX_PHASE_RETRY_CYCLES, so WITHIN one generation episode a node can only
  // produce a handful of verdicts - which is itself the point: oscillation is a CROSS-episode signal, and
  // that is exactly why the series must outlive the re-entry that voids the verdict (next test).
  const PLAN = { plan_hash: "h1", nodes: [{ id: "N1", object: "ZCL_X", wave: 0, dependencies: [] }] };
  let s = initRun(PLAN);
  s = dispatch(PLAN, s, ["N1"]);
  for (const passed of [false, true, false]) {
    s = applyProgress(PLAN, s, "N1", "GENERATED");
    s = applyProgress(PLAN, s, "N1", "SYNTAX_OK");
    s = applyProgress(PLAN, s, "N1", "PROVISIONAL_GATED");
    s = recordProvisionalVerdict(PLAN, s, "N1", { provisional: passed });
  }
  assert.deepEqual(s.verdict_series.N1, ["fail", "pass", "fail"], "chronological, most recent last");
  assert.ok(isOscillating(s.verdict_series.N1), "two flips is what thrash looks like");
});

test("the series is BOUNDED to the detector window - history nothing reads is not kept", () => {
  // Across re-entries a node can accumulate verdicts without limit, and an unbounded per-node history over
  // a 100K-LOC corpus is state that grows forever to feed a detector that reads only the last few.
  const PLAN = { plan_hash: "h1", nodes: [{ id: "N1", object: "ZCL_X", wave: 0, dependencies: [] }] };
  let s = initRun(PLAN);
  s = dispatch(PLAN, s, ["N1"]);
  s = applyProgress(PLAN, s, "N1", "GENERATED");
  s = applyProgress(PLAN, s, "N1", "SYNTAX_OK");
  s = applyProgress(PLAN, s, "N1", "PROVISIONAL_GATED");
  // a real state object carrying the history a long-lived node would have accrued
  s = { ...s, verdict_series: { N1: ["pass", "fail", "pass", "fail", "pass"] } };
  const after = recordProvisionalVerdict(PLAN, s, "N1", { provisional: false });
  assert.equal(after.verdict_series.N1.length, VERDICT_WINDOW);
  assert.deepEqual(after.verdict_series.N1, ["fail", "pass", "fail", "pass", "fail"], "oldest dropped, newest appended");
});

test("re-entry voids the VERDICT but keeps the SERIES - the history is the whole signal", () => {
  const PLAN = { plan_hash: "h1", nodes: [{ id: "N1", object: "ZCL_X", wave: 0, dependencies: [] }] };
  let s = initRun(PLAN);
  s = dispatch(PLAN, s, ["N1"]);
  s = applyProgress(PLAN, s, "N1", "GENERATED");
  s = applyProgress(PLAN, s, "N1", "SYNTAX_OK");
  s = applyProgress(PLAN, s, "N1", "PROVISIONAL_GATED");
  s = recordProvisionalVerdict(PLAN, s, "N1", { provisional: false });
  assert.deepEqual(s.verdict_series.N1, ["fail"]);

  // the re-walk: a regenerated artifact must not inherit the old verdict...
  s = applyProgress(PLAN, s, "N1", "GENERATED");
  assert.equal(s.verdict_provisional.N1, undefined, "the stale verdict is voided, as before");
  // ...but the history of HOW IT GOT HERE is precisely what oscillation detection reads.
  assert.deepEqual(s.verdict_series.N1, ["fail"], "clearing this with the verdict would blind the detector");
});

test("the run-level reader clusters thrashing nodes by shared cause, and ignores settled ones", () => {
  // ONE escalation per generator weakness, never one per node - the human is an exception handler, not a
  // volume gate. Two nodes failing the SAME rule are one question; a node that simply failed twice is not
  // thrashing at all and must not reach anyone.
  const plan = { nodes: [{ id: "A", dependencies: ["D"] }, { id: "B", dependencies: ["D"] }, { id: "C", dependencies: [] }] };
  const state = {
    verdict_series: { A: ["pass", "fail", "pass"], B: ["fail", "pass", "fail"], C: ["fail", "fail", "fail"] },
    verdict_top_fail: { A: "talos-duplicate-block", B: "talos-duplicate-block", C: "talos-duplicate-block" },
  };
  const clusters = oscillationClusters(plan, state);
  assert.equal(clusters.length, 1, `one shared cause, one escalation: ${JSON.stringify(clusters)}`);
  assert.deepEqual(clusters[0].node_ids, ["A", "B"], "C never flipped - it is failing, not thrashing");
  assert.equal(clusters[0].kind, "OSCILLATION");
  assert.match(clusters[0].root_signature, /talos-duplicate-block/);
});

test("nodes thrashing on DIFFERENT causes are different questions", () => {
  const plan = { nodes: [{ id: "A", dependencies: [] }, { id: "B", dependencies: [] }] };
  const state = {
    verdict_series: { A: ["pass", "fail", "pass"], B: ["pass", "fail", "pass"] },
    verdict_top_fail: { A: "rule-one", B: "rule-two" },
  };
  assert.equal(oscillationClusters(plan, state).length, 2, "clustering must not merge unrelated causes");
});

test("a run with no history produces nothing - absence is not thrash", () => {
  assert.deepEqual(oscillationClusters({ nodes: [{ id: "A" }] }, {}), []);
});
