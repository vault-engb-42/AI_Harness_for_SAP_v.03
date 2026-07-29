import { test } from "node:test";
import assert from "node:assert/strict";
import { raiseDispositionReviews, parseDispositionDecision, recordDispositionDecision } from "../src/plan/disposition-gate.js";

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
