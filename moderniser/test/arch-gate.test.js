import { test } from "node:test";
import assert from "node:assert/strict";
import { raiseArchReviews, parseArchDecision, recordArchDecision } from "../src/plan/arch-gate.js";
import { raiseEscalation, ESCALATION_KINDS } from "../src/exception/escalation-bus.js";
import { renderPacket, DECISIONS } from "../src/exception/gate-ui.js";
import { buildPromptOptions } from "../src/plan/prompt-options.js";
import { PATTERN_IDS } from "../src/plan/patterns/match.js";

// B3.5a seam 12 (BUILD_PLAN S12): the ARCH_REVIEW gate machinery — the human ratification gate for a
// reasoned re-architecture. ARCH_REVIEW is a first-class escalation kind; arch-gate.js mirrors
// disposition-gate.js (raise / parse / record) with a PARAMETRIZED decision (approve | refine:<notes> |
// reject); buildPromptOptions is generalised so gate 2 keys on target_shape with a corpus validator.

const empty = () => ({ escalations: [] });
const SIG = "s".repeat(64);
const SIG2 = "t".repeat(64);

test("ARCH_REVIEW is a taxonomy kind with a typed decision set + a cause renderer", () => {
  assert.ok(ESCALATION_KINDS.includes("ARCH_REVIEW"));
  assert.deepEqual(DECISIONS.ARCH_REVIEW, ["approve", "refine", "reject"]);
  const reg = raiseEscalation(empty(), { kind: "ARCH_REVIEW", node_ids: [SIG] }, { ts: "T" });
  const packet = renderPacket(reg.escalations[0]);
  assert.match(packet.cause, /architecture review/i);
  assert.deepEqual(packet.decisions, ["approve", "refine", "reject"]);
});

test("raiseArchReviews raises one ARCH_REVIEW per manifest row (idempotent — no storm)", () => {
  const manifest = { rows: [{ sig: SIG }, { sig: SIG2 }] };
  const reg = raiseArchReviews(empty(), manifest, { ts: "T" });
  assert.equal(reg.escalations.filter((e) => e.kind === "ARCH_REVIEW").length, 2);
  assert.equal(raiseArchReviews(reg, manifest, { ts: "T2" }).escalations.length, 2, "idempotent");
});

test("parseArchDecision: approve | refine:<notes> | reject; bare refine + free-form + empty THROW (fail-closed)", () => {
  assert.deepEqual(parseArchDecision("approve"), { verb: "approve" });
  assert.deepEqual(parseArchDecision("reject"), { verb: "reject" });
  assert.deepEqual(parseArchDecision("refine: drop the OData layer, keep headless"), { verb: "refine", notes: "drop the OData layer, keep headless" });
  assert.throws(() => parseArchDecision("refine"), /requires operator notes/i);
  assert.throws(() => parseArchDecision("frobnicate"), /not approve/i);
  assert.throws(() => parseArchDecision(""), /empty/i);
});

test("recordArchDecision approve: binds the ratified contract_hash + reviewer verdict; fail-closed on wrong kind / missing decider", () => {
  const reg = raiseArchReviews(empty(), { rows: [{ sig: SIG }] }, { ts: "T" });
  const id = reg.escalations[0].id;
  const verdict = { verdict: "pass", flags: [] };
  const next = recordArchDecision(reg, id, "approve", { decided_by: "eng", ts: "T2", run_id: "r1", contract_hash: "abc123", reviewer_verdict: verdict });
  const row = next.escalations.find((e) => e.id === id);
  assert.equal(row.status, "RESOLVED");
  assert.equal(row.decision.verb, "approve");
  assert.equal(row.decision.contract_hash, "abc123", "the ratified contract hash is bound to the decision");
  assert.deepEqual(row.decision.reviewer_verdict, verdict);
  assert.throws(() => recordArchDecision(reg, id, "approve", { ts: "T" }), /decided_by/i);
  const disp = raiseEscalation(empty(), { kind: "DISPOSITION_REVIEW", node_ids: [SIG] }, { ts: "T" });
  assert.throws(() => recordArchDecision(disp, disp.escalations[0].id, "approve", { decided_by: "eng", ts: "T" }), /not an ARCH_REVIEW/i);
});

test("recordArchDecision refine/reject: captures notes / blocks, and ratifies NO contract_hash on a non-approve", () => {
  const reg = raiseArchReviews(empty(), { rows: [{ sig: SIG }] }, { ts: "T" });
  const id = reg.escalations[0].id;
  const refined = recordArchDecision(reg, id, "refine: use analytical_cds instead", { decided_by: "eng", ts: "T2", contract_hash: "should-not-bind" });
  const row = refined.escalations.find((e) => e.id === id);
  assert.equal(row.decision.verb, "refine");
  assert.equal(row.decision.notes, "use analytical_cds instead");
  assert.ok(!("contract_hash" in row.decision), "a refine ratifies no contract");
});

test("buildPromptOptions generalises to target_shape (gate 2) while the disposition default (gate 1) is unchanged", () => {
  const isPatternId = (s) => PATTERN_IDS.includes(s);
  const opts = buildPromptOptions(
    { target_shape: "rap_bo_headless", rationale: "no UI/remote surface" },
    [{ target_shape: "rap_bo_fiori", rationale: "if a UI is added" }],
    { labelField: "target_shape", isValid: isPatternId },
  );
  assert.equal(opts[0].target_shape, "rap_bo_headless");
  assert.equal(opts[0].recommended, true);
  assert.ok(opts.some((o) => o.freeform && o.target_shape === "other"), "always an 'other' escape");
  assert.ok(opts.length >= 3);
  assert.throws(
    () => buildPromptOptions({ target_shape: "cap_side_by_side", rationale: "x" }, [], { labelField: "target_shape", isValid: isPatternId }),
    /valid target_shape/i,
    "an out-of-corpus shape is refused (CAP is out of scope)",
  );
  // gate 1 default (disposition) still works untouched
  const d = buildPromptOptions({ disposition: "re_architect", rationale: "x" }, [{ disposition: "refactor", rationale: "y" }]);
  assert.equal(d[0].disposition, "re_architect");
  assert.equal(d[0].recommended, true);
});
