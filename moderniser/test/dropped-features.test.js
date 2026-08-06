import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDroppedFeatures } from "../src/plan/dropped-features.js";

// The DROPPED-FEATURES ledger (BUILD_PLAN B4). SKILL.md's retire step told the fulfiller to "record the drop
// in the run's dropped-features ledger with the grounded no-released-successor basis" — and no verb, file or
// function existed to record it into. An instruction the lane cannot perform is the inert-mechanism defect
// this arc has shipped three times; this is the mechanism.
//
// It is DERIVED, not a second source of truth: `state.disposition_register` already holds the audited
// sign-off (who authorised the drop, why), and the frozen plan holds P1's grounded basis. The ledger joins
// them so the proof bundle can answer "what was dropped, on whose authority, and on what evidence" without a
// reader having to correlate two artifacts.

const node = (id, o = {}) => ({
  id, object: `Z${id}`, disposition: "retire", disposition_source: "operator_override", disposition_decided_by: "alice",
  disposition_evidence: { no_successor_refs: [], standard_domains: [] }, ...o,
});
const state = (rows) => ({ disposition_register: rows });

test("a ledger row joins the audited sign-off with the node's grounded basis", () => {
  const plan = {
    plan_hash: "h",
    nodes: [node("N1", { disposition_evidence: { no_successor_refs: ["CL_HTTP_CLIENT"], standard_domains: ["G/L Account"] } })],
  };
  const s = state([{ sig: "N1", status: "RETIRED", reason: "no released successor", signed_by: "alice", justification: "capability dropped" }]);
  const led = buildDroppedFeatures(plan, s, { run_id: "r1" });

  assert.equal(led.run_id, "r1");
  assert.equal(led.plan_hash, "h");
  assert.deepEqual(led.rows, [{
    sig: "N1",
    object: "ZN1",
    status: "RETIRED",
    disposition: "retire",
    reason: "no released successor",
    signed_by: "alice",
    justification: "capability dropped",
    decided_by: "alice",
    disposition_source: "operator_override",
    grounded_basis: { no_successor_refs: ["CL_HTTP_CLIENT"], standard_domains: ["G/L Account"] },
  }]);
});

test("an EMPTY basis is reported as empty, never omitted — absence of evidence is itself the record", () => {
  // A drop with no grounded basis is a legitimate business decision, and the proof bundle must show that it
  // rested on the human's judgement rather than on a registry fact.
  const plan = { plan_hash: "h", nodes: [node("N1")] };
  const led = buildDroppedFeatures(plan, state([{ sig: "N1", status: "RETIRED", signed_by: "bob", justification: "obsolete process" }]), { run_id: "r1" });
  assert.deepEqual(led.rows[0].grounded_basis, { no_successor_refs: [], standard_domains: [] });
  assert.equal(led.rows[0].signed_by, "bob");
});

test("REBUILT_HANDOFF is a drop from the in-stack estate too, and appears in the ledger", () => {
  const plan = { plan_hash: "h", nodes: [node("N1", { disposition: "rebuild" })] };
  const led = buildDroppedFeatures(plan, state([{ sig: "N1", status: "REBUILT_HANDOFF", signed_by: "eng", justification: "moved side-by-side" }]), { run_id: "r1" });
  assert.equal(led.rows[0].status, "REBUILT_HANDOFF");
  assert.equal(led.rows[0].disposition, "rebuild");
});

test("rows are ordered by sig and the ledger is deterministic", () => {
  const plan = { plan_hash: "h", nodes: [node("B"), node("A")] };
  const s = state([
    { sig: "B", status: "RETIRED", signed_by: "x", justification: "j" },
    { sig: "A", status: "RETIRED", signed_by: "x", justification: "j" },
  ]);
  const a = buildDroppedFeatures(plan, s, { run_id: "r" });
  assert.deepEqual(a.rows.map((r) => r.sig), ["A", "B"]);
  assert.equal(JSON.stringify(a), JSON.stringify(buildDroppedFeatures(plan, s, { run_id: "r" })));
});

test("an empty register yields an empty ledger, not a missing one", () => {
  assert.deepEqual(buildDroppedFeatures({ plan_hash: "h", nodes: [] }, state([]), { run_id: "r" }).rows, []);
});

test("fail closed: a register row naming a node the plan does not contain is refused", () => {
  // The register is durable run state; a row that matches no frozen node would put an object in the proof
  // bundle that this plan never dropped.
  const plan = { plan_hash: "h", nodes: [node("N1")] };
  assert.throws(
    () => buildDroppedFeatures(plan, state([{ sig: "GHOST", status: "RETIRED", signed_by: "x", justification: "j" }]), { run_id: "r" }),
    /not a plan node/,
  );
});
