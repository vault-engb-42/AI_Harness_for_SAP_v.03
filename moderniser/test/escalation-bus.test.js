import { test } from "node:test";
import assert from "node:assert/strict";
import { raiseEscalation, resolveEscalation, surfaceable, ESCALATION_KINDS } from "../src/exception/escalation-bus.js";

// §3.4 #1/#3/#6 — the escalation bus. Only the 9 taxonomy kinds exist (the 7 §3.4 kinds + the two
// plan-time gates DISPOSITION_REVIEW/B3 and ARCH_REVIEW/B3.5a); raising is idempotent per (kind, node_ids)
// so one root cause never storms the human; surfacing is rate-limited (≤ max per window) with critical-path
// escalations first, the rest QUEUED, never dropped. Pure copy-on-write over the register; timestamps injected.

const empty = () => ({ escalations: [] });
const A = "a".repeat(64);
const B = "b".repeat(64);

test("the taxonomy is exactly the 7 §3.4 kinds + the plan-time DISPOSITION_REVIEW (B3/S2) + ARCH_REVIEW (B3.5a/S12)", () => {
  assert.deepEqual(
    [...ESCALATION_KINDS].sort(),
    ["ARCH_REVIEW", "AUTH_EQUIVALENCE", "BREAK_CYCLE", "DISPOSITION_REVIEW", "NO_RELEASED_SUCCESSOR", "OSCILLATION", "PARITY_REVIEW", "REPLAN_WAVE_MOVE", "RISK_LEVEL_REVIEW"],
  );
});

test("raise appends an OPEN escalation with a deterministic content-derived id", () => {
  const r1 = raiseEscalation(empty(), { kind: "BREAK_CYCLE", node_ids: [B, A] }, { ts: "T1" });
  const e = r1.escalations[0];
  assert.equal(e.status, "OPEN");
  assert.equal(e.opened_at, "T1");
  assert.deepEqual(e.node_ids, [A, B].sort(), "node ids canonically sorted");
  assert.match(e.id, /^esc-[0-9a-f]{12}$/);
  const r2 = raiseEscalation(empty(), { kind: "BREAK_CYCLE", node_ids: [A, B] }, { ts: "T9" });
  assert.equal(r2.escalations[0].id, e.id, "same content → same id regardless of order/time");
});

test("raising the same OPEN escalation twice is idempotent — no storm", () => {
  let r = raiseEscalation(empty(), { kind: "OSCILLATION", node_ids: [A] }, { ts: "T1" });
  r = raiseEscalation(r, { kind: "OSCILLATION", node_ids: [A] }, { ts: "T2" });
  assert.equal(r.escalations.length, 1);
  // …but a RESOLVED one may recur as a fresh escalation
  r = resolveEscalation(r, r.escalations[0].id, { resolved_by: "j.doe", ts: "T3" });
  r = raiseEscalation(r, { kind: "OSCILLATION", node_ids: [A] }, { ts: "T4" });
  assert.equal(r.escalations.length, 2);
});

test("unknown kinds and empty node sets fail closed", () => {
  assert.throws(() => raiseEscalation(empty(), { kind: "RETRY_CEILING", node_ids: [A] }, { ts: "T" }), /kind/i);
  assert.throws(() => raiseEscalation(empty(), { kind: "BREAK_CYCLE", node_ids: [] }, { ts: "T" }), /node/i);
});

test("resolve stamps resolved_by and fails closed on unknown/already-resolved", () => {
  let r = raiseEscalation(empty(), { kind: "PARITY_REVIEW", node_ids: [A] }, { ts: "T1" });
  const id = r.escalations[0].id;
  r = resolveEscalation(r, id, { resolved_by: "j.doe", ts: "T2" });
  assert.equal(r.escalations[0].status, "RESOLVED");
  assert.equal(r.escalations[0].resolved_by, "j.doe");
  assert.throws(() => resolveEscalation(r, id, { resolved_by: "x", ts: "T3" }), /resolved|unknown/i);
  assert.throws(() => resolveEscalation(r, "esc-nope00000000", { resolved_by: "x", ts: "T3" }), /unknown/i);
});

test("surfaceable rate-limits: critical-path first, the rest queued — never dropped", () => {
  let r = empty();
  const sigs = ["c", "d", "e", "f"].map((c) => c.repeat(64));
  for (const s of sigs) r = raiseEscalation(r, { kind: "OSCILLATION", node_ids: [s] }, { ts: "T" });
  const { surfaced, queued } = surfaceable(r, { max: 2, criticalSigs: new Set([sigs[2], sigs[3]]) });
  assert.equal(surfaced.length, 2);
  assert.ok(surfaced.every((e) => e.node_ids.some((n) => n === sigs[2] || n === sigs[3])), "critical-path escalations surface first");
  assert.equal(queued.length, 2, "the rest are queued, not surfaced — and not dropped");
  // resolved ones drop out entirely
  const r2 = resolveEscalation(r, r.escalations[0].id, { resolved_by: "j", ts: "T2" });
  assert.equal(surfaceable(r2, { max: 10 }).surfaced.length, 3);
});

test("surfaceable fails CLOSED on a missing/negative/non-integer max — never an inverted rate limit", () => {
  const r = raiseEscalation(empty(), { kind: "OSCILLATION", node_ids: [A] }, { ts: "T" });
  for (const bad of [undefined, -1, 1.5, NaN]) {
    assert.throws(() => surfaceable(r, { max: bad }), /max/i, String(bad));
  }
  assert.deepEqual(surfaceable(r, { max: 0 }).surfaced, [], "0 surfaces nothing — everything queued");
  assert.equal(surfaceable(r, { max: 0 }).queued.length, 1);
});

test("the register is never mutated (copy-on-write)", () => {
  const r0 = empty();
  raiseEscalation(r0, { kind: "BREAK_CYCLE", node_ids: [A] }, { ts: "T" });
  assert.deepEqual(r0, { escalations: [] });
});
