import { test } from "node:test";
import assert from "node:assert/strict";
import { isOscillating, clusterOscillations } from "../src/exception/oscillation.js";

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
