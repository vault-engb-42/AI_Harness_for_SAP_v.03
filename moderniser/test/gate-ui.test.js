import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPacket, recordDecision, DECISIONS } from "../src/exception/gate-ui.js";
import { raiseEscalation } from "../src/exception/escalation-bus.js";

// §3.4 #8 — the gate UI contract. Each GatePacket carries: kind + one-line cause, the
// DETERMINISTIC evidence, the analyser plan fields, and a TYPED decision set — never free
// ordering. Every decision writes an audited row; NOTHING lets a human grant a machine
// PASS (7.5 asymmetry). Pure; registers copy-on-write.

const A = "a".repeat(64);
const raise = (kind, extra = {}) =>
  raiseEscalation({ escalations: [] }, { kind, node_ids: [A], ...extra }, { ts: "T1" });

const CONTEXT = {
  evidence: { atc_p1_list: [], parity: { verdict: "needs_review", score: 0.55 }, p4_diff: { intact: true }, blast: { total_affected_programs: 3, highest_impact: "low" } },
  plan_fields: { modernization_target: "RAP Business Object", effort_tier: "L", priority_rank: "P1", migration_complexity: 3, grade: "D", cloud_state: "classicAPI" },
};

test("every taxonomy kind has a TYPED decision set and none of them grants a machine PASS", () => {
  for (const [kind, decisions] of Object.entries(DECISIONS)) {
    assert.ok(Array.isArray(decisions) && decisions.length >= 2, kind);
    for (const d of decisions) assert.doesNotMatch(d, /^(PASS|GREEN|FORCE)/, "no human-granted machine PASS (7.5)");
  }
  assert.deepEqual(DECISIONS.BREAK_CYCLE, ["CUT", "COGEN_RAP_BO", "SPROUT_DEFER"], "§3.4 CycleResolution kinds");
  assert.deepEqual(DECISIONS.AUTH_EQUIVALENCE, ["ATTEST", "REJECT"]);
  assert.deepEqual(DECISIONS.NO_RELEASED_SUCCESSOR, ["PARK_JUSTIFY", "DENY"]);
  assert.deepEqual(DECISIONS.OSCILLATION, ["RESEED_GENERATOR", "MANUAL_SEAM", "DEFER"]);
  assert.deepEqual(DECISIONS.RISK_LEVEL_REVIEW, ["ADVANCE", "HOLD_FLAGGED"]);
});

test("renderPacket assembles kind + cause + evidence + plan fields + the typed decisions", () => {
  const reg = raise("BREAK_CYCLE", { seam_candidates: [{ source: A, target: "b".repeat(64), rank: 1, confidence: 0.5 }] });
  const p = renderPacket(reg.escalations[0], CONTEXT);
  assert.equal(p.kind, "BREAK_CYCLE");
  assert.ok(typeof p.cause === "string" && p.cause.length > 0 && !p.cause.includes("\n"), "one-line cause");
  assert.deepEqual(p.evidence, CONTEXT.evidence);
  assert.deepEqual(p.plan_fields, CONTEXT.plan_fields);
  assert.deepEqual(p.decisions, DECISIONS.BREAK_CYCLE);
  assert.equal(p.seam_candidates[0].rank, 1, "the ranked seams ride the packet");
});

test("recordDecision writes the audited resolution row and fails closed off the typed set", () => {
  const reg = raise("OSCILLATION");
  const id = reg.escalations[0].id;
  const next = recordDecision(reg, id, "RESEED_GENERATOR", { decided_by: "j.doe", ts: "T2" });
  const e = next.escalations[0];
  assert.equal(e.status, "RESOLVED");
  assert.equal(e.resolved_by, "j.doe");
  assert.equal(e.decision, "RESEED_GENERATOR");
  assert.equal(e.resolved_at, "T2");
  assert.throws(() => recordDecision(reg, id, "JUST_PASS_IT", { decided_by: "j.doe", ts: "T2" }), /decision/i, "free-form decisions refused");
  assert.throws(() => recordDecision(reg, id, "ADVANCE", { decided_by: "j.doe", ts: "T2" }), /decision/i, "another kind's decision refused");
  assert.throws(() => recordDecision(next, id, "DEFER", { decided_by: "x", ts: "T3" }), /resolved|unknown/i, "no double-deciding");
  assert.throws(() => recordDecision(reg, id, "RESEED_GENERATOR", { ts: "T2" }), /decided_by/i, "audited row needs the named human");
});

test("registers are copy-on-write end to end", () => {
  const reg = raise("PARITY_REVIEW");
  const snapshot = JSON.stringify(reg);
  recordDecision(reg, reg.escalations[0].id, DECISIONS.PARITY_REVIEW[1], { decided_by: "j", ts: "T" });
  assert.equal(JSON.stringify(reg), snapshot);
});
