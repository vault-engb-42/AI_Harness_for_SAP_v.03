import { test } from "node:test";
import assert from "node:assert/strict";
import { driveDecision } from "../src/sched/drive.js";
import { initRun } from "../src/sched/loop.js";

// driveDecision is the deterministic stepper (Phase 2, thick-verb): given the durable run state,
// it returns the next action the fulfiller must take — {generate | await_human |
// provisional_complete | complete | blocked}. Pure over (plan, state); the CLI wraps it.

const node = (id, deps = []) => ({ id, object: id.toLowerCase(), wave: deps.length, members: [id], dependencies: deps, conflict_keys: [] });
const PLAN = { plan_hash: "h1", generator_team_size: 8, nodes: [node("N1"), node("N2", ["N1"])] };
const stateWith = (statuses) => ({ ...initRun(PLAN), status: { ...initRun(PLAN).status, ...statuses } });

test("a fresh run returns generate for the ready frontier (roots only; N2 waits on N1)", () => {
  const d = driveDecision(PLAN, initRun(PLAN));
  assert.equal(d.action, "generate");
  assert.deepEqual(d.packets.map((p) => p.sig), ["N1"]);
  assert.equal(d.packets[0].object, "n1");
});

test("all nodes GREEN → complete", () => {
  assert.equal(driveDecision(PLAN, stateWith({ N1: "GREEN", N2: "GREEN" })).action, "complete");
});

test("frontier empty + rested SYNTAX_OK + a starved PENDING dependent → provisional_complete (sweep exit)", () => {
  // N1 rests at SYNTAX_OK offline; N2 is PENDING with indegree 1 (N1 never GREENs offline) — a
  // starved dependent is a SWEEP target, not a wedge.
  assert.equal(driveDecision(PLAN, stateWith({ N1: "SYNTAX_OK" })).action, "provisional_complete");
});

test("a machine-quarantined BLOCK node with rested peers still sweeps (BLOCK is not a human gate)", () => {
  assert.equal(driveDecision(PLAN, stateWith({ N1: "BLOCK", N2: "PENDING" })).action, "provisional_complete");
});

test("a NEEDS_MANUAL_SEAM node → await_human", () => {
  const d = driveDecision(PLAN, stateWith({ N1: "NEEDS_MANUAL_SEAM" }));
  assert.equal(d.action, "await_human");
  assert.ok(d.nodes.includes("N1"));
});

test("a parked node → await_human", () => {
  const s = stateWith({ N1: "PARK" });
  s.park_register = [{ sig: "N1", reason: "NO_RELEASED_SUCCESSOR" }];
  const d = driveDecision(PLAN, s);
  assert.equal(d.action, "await_human");
  assert.ok(d.nodes.includes("N1"));
});

test("a node wedged mid-flight (GROUNDED, not dispatchable, not rested) → blocked (fail-closed surface)", () => {
  const d = driveDecision(PLAN, stateWith({ N1: "GROUNDED" }));
  assert.equal(d.action, "blocked");
  assert.ok(d.nodes.some((n) => n.sig === "N1" && n.status === "GROUNDED"));
});
