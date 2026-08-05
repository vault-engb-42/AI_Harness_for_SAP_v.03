import { test } from "node:test";
import assert from "node:assert/strict";
import { raiseDispositionReviews, parseDispositionDecision, recordDispositionDecision, droppedDependencies, raiseDroppedDependencies } from "../src/plan/disposition-gate.js";

// B3 / S1-S2 — the disposition gate wiring: one DISPOSITION_REVIEW per prompted node, and a PARAMETRIZED
// recorder (approve | override:<disposition> | other:<freeform>) validated against the enum allowlist.

const empty = () => ({ escalations: [] });
const manifest = (rows) => ({ rows });

test("raiseDispositionReviews raises one DISPOSITION_REVIEW per PROMPT row; auto rows raise none", () => {
  const reg = raiseDispositionReviews(empty(), manifest([
    { sig: "s1", autonomy: "prompt", confidence: 0.85 },
    { sig: "s2", autonomy: "auto", confidence: 1 },
    { sig: "s3", autonomy: "prompt", confidence: 0.7 },
  ]), { ts: "T1" });
  assert.equal(reg.escalations.length, 2, "only the 2 prompt rows raise");
  assert.ok(reg.escalations.every((e) => e.kind === "DISPOSITION_REVIEW" && e.status === "OPEN"));
  assert.deepEqual(reg.escalations.flatMap((e) => e.node_ids).sort(), ["s1", "s3"]);
});

test("parseDispositionDecision handles approve | override:<disposition> | other:<text>", () => {
  assert.deepEqual(parseDispositionDecision("approve"), { verb: "approve" });
  assert.deepEqual(parseDispositionDecision("override:re_architect"), { verb: "override", disposition: "re_architect" });
  assert.deepEqual(parseDispositionDecision("other: move to BTP side-by-side"), { verb: "other", freeform: "move to BTP side-by-side" });
});

test("parseDispositionDecision refuses an invalid verb, an invalid override target, or an empty other", () => {
  assert.throws(() => parseDispositionDecision("yolo"), /approve|override|other/);
  assert.throws(() => parseDispositionDecision("override:port"), /disposition/i);
  assert.throws(() => parseDispositionDecision("other:"), /instruction|other/i);
});

test("recordDispositionDecision resolves the escalation with the parsed decision + a named decider", () => {
  const reg0 = raiseDispositionReviews(empty(), manifest([{ sig: "s1", autonomy: "prompt", confidence: 0.85 }]), { ts: "T1" });
  const id = reg0.escalations[0].id;
  const reg1 = recordDispositionDecision(reg0, id, "override:refactor", { decided_by: "alice", ts: "T2", run_id: "r1" });
  const e = reg1.escalations[0];
  assert.equal(e.status, "RESOLVED");
  assert.equal(e.resolved_by, "alice");
  assert.deepEqual(e.decision, { verb: "override", disposition: "refactor" });
});

test("recordDispositionDecision fails closed on a missing decider, an unknown id, and a wrong-kind escalation", () => {
  const reg = raiseDispositionReviews(empty(), manifest([{ sig: "s1", autonomy: "prompt" }]), { ts: "T1" });
  const id = reg.escalations[0].id;
  assert.throws(() => recordDispositionDecision(reg, id, "approve", { ts: "T2" }), /decided_by/);
  assert.throws(() => recordDispositionDecision(reg, "esc-nope", "approve", { decided_by: "a", ts: "T2" }), /unknown/);
});

// §7.4 (operator-ruled 2026-08-05) — DROPPED DEPENDENCY. Retiring an object releases its dependents'
// readiness counter (9a574e5), so an operator can drop B while A — which still calls it — goes on to be
// built. The ruling was ALLOW, but make the consequence visible at gate 1 instead of letting it surface far
// from its cause as an ATC/syntax failure on a generated object. This is deliberately not a block: the
// human may know the call is dead, or intend to adapt A.

const node = (id, disposition, dependencies = []) => ({ id, object: `Z${id}`, disposition, dependencies });
const planOf = (...nodes) => ({ nodes });

test("a retired node with a live dependent is reported, naming both sides", () => {
  const plan = planOf(node("B", "retire"), node("A", "refactor", ["B"]));
  assert.deepEqual(droppedDependencies(plan), [{ retired: "B", object: "ZB", dependents: ["A"] }]);
});

test("no report when every dependent is dropped too — retiring a whole cluster is coherent", () => {
  const plan = planOf(node("B", "retire"), node("A", "retire", ["B"]));
  assert.deepEqual(droppedDependencies(plan), []);
});

test("no report for a plan with nothing retired, or for a retired leaf nothing depends on", () => {
  assert.deepEqual(droppedDependencies(planOf(node("A", "refactor"), node("B", "re_architect", ["A"]))), []);
  assert.deepEqual(droppedDependencies(planOf(node("B", "retire"), node("A", "refactor"))), []);
});

test("every non-retire disposition counts as live — a sealed or handed-off dependent still calls the dropped object", () => {
  const plan = planOf(node("B", "retire"), node("A", "seal", ["B"]), node("C", "rebuild", ["B"]));
  assert.deepEqual(droppedDependencies(plan), [{ retired: "B", object: "ZB", dependents: ["A", "C"] }]);
});

test("deterministic: reports are ordered by retired sig, dependents sorted", () => {
  const plan = planOf(node("B2", "retire"), node("B1", "retire"), node("A2", "refactor", ["B1", "B2"]), node("A1", "refactor", ["B1"]));
  assert.deepEqual(droppedDependencies(plan), [
    { retired: "B1", object: "ZB1", dependents: ["A1", "A2"] },
    { retired: "B2", object: "ZB2", dependents: ["A2"] },
  ]);
});

test("two dropped objects sharing one dependent raise TWO distinct escalations", () => {
  // The register keys an escalation id on (kind, node_ids). Reporting only the DEPENDENTS would give both
  // drops the same id, so the second would dedupe into the first and one dropped object would never be
  // surfaced. The retired sig therefore rides node_ids as well as root_signature.
  const plan = planOf(node("B1", "retire"), node("B2", "retire"), node("A", "refactor", ["B1", "B2"]));
  const reg = raiseDroppedDependencies(empty(), plan, { ts: "T1" });
  assert.equal(reg.escalations.length, 2);
  assert.equal(new Set(reg.escalations.map((e) => e.id)).size, 2, "distinct ids");
  assert.deepEqual(reg.escalations.map((e) => e.root_signature).sort(), ["B1", "B2"]);
  assert.ok(reg.escalations.every((e) => e.kind === "DROPPED_DEPENDENCY" && e.status === "OPEN"));
  assert.ok(reg.escalations.every((e) => e.node_ids.includes("A") && e.node_ids.includes(e.root_signature)));
});

test("raising is idempotent — a re-run of the gate raises no duplicate", () => {
  const plan = planOf(node("B", "retire"), node("A", "refactor", ["B"]));
  const once = raiseDroppedDependencies(empty(), plan, { ts: "T1" });
  const twice = raiseDroppedDependencies(once, plan, { ts: "T2" });
  assert.equal(twice.escalations.length, 1);
});

test("a clean plan raises nothing and returns the register untouched", () => {
  const reg = empty();
  assert.equal(raiseDroppedDependencies(reg, planOf(node("A", "refactor")), { ts: "T1" }), reg);
});
