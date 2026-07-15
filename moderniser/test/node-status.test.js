import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canTransition,
  assertTransition,
  isActive,
  STATUSES,
  ACTIVE_STATES,
  MAX_PHASE_RETRY_CYCLES,
  NO_RELEASED_SUCCESSOR,
} from "../src/state/node-status.js";

// §6.3 — the canonical node-state status FSM (supersedes the §3.2/§3.3 inline sketches).
// Only the enumerated transitions are legal; an illegal transition fails closed. This
// prevents a resume from mis-routing on an ad-hoc status string.

const FORWARD = ["PENDING", "GROUNDED", "GENERATED", "SYNTAX_OK", "PUSHED", "ACTIVATED", "GATED", "GREEN"];

test("the full forward path is legal step by step", () => {
  for (let i = 0; i < FORWARD.length - 1; i += 1) {
    assert.equal(canTransition(FORWARD[i], FORWARD[i + 1]), true, `${FORWARD[i]}→${FORWARD[i + 1]}`);
  }
});

test("skipping a forward step is illegal", () => {
  assert.equal(canTransition("PENDING", "GENERATED"), false);
  assert.equal(canTransition("PENDING", "GREEN"), false);
  assert.equal(canTransition("GROUNDED", "PUSHED"), false);
});

test("the syntax/checkpoint retry loops back to GENERATED only while under the cycle ceiling", () => {
  for (const from of ["SYNTAX_OK", "GATED", "PROVISIONAL_GATED"]) {
    assert.equal(canTransition(from, "GENERATED", { cycle: 0 }), true, `${from} cycle 0`);
    assert.equal(canTransition(from, "GENERATED", { cycle: MAX_PHASE_RETRY_CYCLES - 1 }), true);
    assert.equal(canTransition(from, "GENERATED", { cycle: MAX_PHASE_RETRY_CYCLES }), false, `${from} at ceiling`);
    assert.equal(canTransition(from, "GENERATED"), true, "no ctx → cycle defaults to 0, under the ceiling");
  }
});

test("PROVISIONAL_GATED is the offline verdict rest state — from SYNTAX_OK, retryable, escalatable, never GREEN", () => {
  // offline SYNTAX_OK forks to PROVISIONAL_GATED, parallel to the live SYNTAX_OK→PUSHED path.
  assert.equal(canTransition("SYNTAX_OK", "PROVISIONAL_GATED"), true);
  assert.equal(canTransition("SYNTAX_OK", "PUSHED"), true, "the live push path is unaffected");
  // an unfixable offline block escalates; offline NEVER GREENs (P6) — no PROVISIONAL_GATED→GREEN edge.
  assert.equal(canTransition("PROVISIONAL_GATED", "BLOCK"), true);
  assert.equal(canTransition("PROVISIONAL_GATED", "NEEDS_MANUAL_SEAM"), true);
  assert.equal(canTransition("PROVISIONAL_GATED", "GREEN"), false, "offline never GREENs");
  assert.equal(canTransition("PROVISIONAL_GATED", "PUSHED"), false, "offline does not push to DEV");
  assert.equal(isActive("PROVISIONAL_GATED"), true, "an in-flight state, not terminal");
  assert.equal(STATUSES.includes("PROVISIONAL_GATED"), true);
});

test("any active state may escalate to BLOCK or NEEDS_MANUAL_SEAM", () => {
  for (const s of ACTIVE_STATES) {
    assert.equal(canTransition(s, "BLOCK"), true, `${s}→BLOCK`);
    assert.equal(canTransition(s, "NEEDS_MANUAL_SEAM"), true, `${s}→NEEDS_MANUAL_SEAM`);
  }
  assert.equal(canTransition("GREEN", "BLOCK"), false, "GREEN is terminal, not active");
  assert.equal(canTransition("PARK", "BLOCK"), false);
});

test("BLOCK escalates to PARK only for the deterministic no-released-successor reason", () => {
  assert.equal(canTransition("BLOCK", "PARK", { reason: NO_RELEASED_SUCCESSOR }), true);
  assert.equal(canTransition("BLOCK", "PARK"), false, "no reason → not parkable");
  assert.equal(canTransition("BLOCK", "PARK", { reason: "P4_VIOLATION" }), false);
});

test("PARK and NEEDS_MANUAL_SEAM re-enter scheduling at PENDING", () => {
  assert.equal(canTransition("PARK", "PENDING"), true);
  assert.equal(canTransition("NEEDS_MANUAL_SEAM", "PENDING"), true);
});

test("GREEN is terminal", () => {
  for (const s of STATUSES) assert.equal(canTransition("GREEN", s), false, `GREEN→${s}`);
});

test("unknown statuses are never a legal transition", () => {
  assert.equal(canTransition("PENDING", "bogus"), false);
  assert.equal(canTransition("bogus", "PENDING"), false);
  assert.equal(canTransition("pending", "GROUNDED"), false, "case-sensitive — tokens are UPPER");
});

test("assertTransition returns the target on a legal move and throws on an illegal one", () => {
  assert.equal(assertTransition("PENDING", "GROUNDED"), "GROUNDED");
  assert.throws(() => assertTransition("PENDING", "GREEN"), /illegal.*PENDING.*GREEN/i);
  assert.throws(() => assertTransition("SYNTAX_OK", "GENERATED", { cycle: MAX_PHASE_RETRY_CYCLES }), /illegal|ceiling|cycle/i);
});

test("isActive marks exactly the eight in-flight states", () => {
  for (const s of ACTIVE_STATES) assert.equal(isActive(s), true, s);
  for (const s of ["GREEN", "BLOCK", "PARK", "NEEDS_MANUAL_SEAM"]) assert.equal(isActive(s), false, s);
  assert.equal(ACTIVE_STATES.length, 8);
});
