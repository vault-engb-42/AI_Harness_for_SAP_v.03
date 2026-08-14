import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { raiseEscalation, ESCALATION_KINDS } from "../src/exception/escalation-bus.js";
import { renderPacket, DECISIONS } from "../src/exception/gate-ui.js";
import { raiseNoTargetShape, recordNoTargetShapeDecision } from "../src/plan/arch-gate.js";
import { collectOverrides } from "../src/plan/replan-overrides.js";

// F-8.2 — the gate for an object NO target shape fits.
//
// `reasonArchitecture` returns `no_shape` for a node whose facts justify no shape (arch-reason.js), and the
// arch manifest lists it under `unplaceable`. But the documented remedy — "re-disposition it
// (`decide … override:<disposition>` → `replan`)" — names an ESCALATION ID, and no escalation was ever
// raised. The node is neither resolved nor pending, holds no Architecture Contract, and so can never be
// ratified: `drive` reports await_human/arch_ratification forever, against a gate that does not exist.
//
// The remedy is its own taxonomy kind, NOT a reuse of DISPOSITION_REVIEW. The register keys an escalation id
// on sha256([kind, node_ids]) (escalation-bus.js), so reusing that kind for the same node would produce the
// SAME id as the disposition gate's own review — the second raise dedupes into the first while it is open,
// and this gate never reaches the human at all. That is the DROPPED_DEPENDENCY precedent, for the same reason.

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "cli.js");
const FIXTURE = join(HERE, "fixtures", "analyser-findings.json");

const empty = () => ({ escalations: [] });
const SIG = "s".repeat(64);
const SIG2 = "t".repeat(64);
const UNPLACEABLE = [{ sig: SIG, reason: "no target shape fits this object's evidence" }];

test("NO_TARGET_SHAPE is a taxonomy kind whose typed decisions are the two things a human can actually do", () => {
  assert.ok(ESCALATION_KINDS.includes("NO_TARGET_SHAPE"), "the closed §3.4 taxonomy must carry the kind");
  // No `approve`. There is nothing to approve — approving the classified disposition leaves the node exactly
  // where it was, unplaceable and unbuildable, with a human's name on the deadlock.
  assert.deepEqual(DECISIONS.NO_TARGET_SHAPE, ["override", "other"]);
  const reg = raiseNoTargetShape(empty(), UNPLACEABLE, { ts: "T" });
  const packet = renderPacket(reg.escalations[0]);
  assert.match(packet.cause, /shape/i, `the cause must say what is missing: ${packet.cause}`);
  assert.match(packet.cause, /re-disposition|disposition/i, `and what to do about it: ${packet.cause}`);
  assert.deepEqual(packet.decisions, ["override", "other"]);
});

test("raiseNoTargetShape raises one per unplaceable node, idempotent (no storm on a re-run)", () => {
  const reg = raiseNoTargetShape(empty(), [{ sig: SIG }, { sig: SIG2 }], { ts: "T" });
  assert.equal(reg.escalations.filter((e) => e.kind === "NO_TARGET_SHAPE").length, 2);
  assert.equal(raiseNoTargetShape(reg, [{ sig: SIG }, { sig: SIG2 }], { ts: "T2" }).escalations.length, 2);
});

// The trap in the obvious fix, encoded so nobody re-introduces it: reusing DISPOSITION_REVIEW here collides.
test("a NO_TARGET_SHAPE and the same node's DISPOSITION_REVIEW are DISTINCT rows — the id keys on kind", () => {
  const reg = raiseNoTargetShape(raiseEscalation(empty(), { kind: "DISPOSITION_REVIEW", node_ids: [SIG] }, { ts: "T" }), UNPLACEABLE, { ts: "T" });
  assert.equal(reg.escalations.length, 2, "both gates must reach the human");
  assert.notEqual(reg.escalations[0].id, reg.escalations[1].id);
  assert.ok(reg.escalations.every((e) => e.status === "OPEN"));
});

test("recordNoTargetShapeDecision: override:<disposition> | other:<text>; approve + free-form + wrong kind THROW", () => {
  const reg = raiseNoTargetShape(empty(), UNPLACEABLE, { ts: "T" });
  const id = reg.escalations[0].id;

  const overridden = recordNoTargetShapeDecision(reg, id, "override:seal", { decided_by: "alice", ts: "T2", run_id: "r1" });
  const row = overridden.escalations.find((e) => e.id === id);
  assert.equal(row.status, "RESOLVED");
  assert.deepEqual(row.decision, { verb: "override", disposition: "seal" });
  assert.equal(row.run_id, "r1", "the decision is scoped to the run whose plan it re-freezes");

  assert.deepEqual(
    recordNoTargetShapeDecision(reg, id, "other: this needs a new corpus shape", { decided_by: "alice", ts: "T2" })
      .escalations.find((e) => e.id === id).decision,
    { verb: "other", freeform: "this needs a new corpus shape" },
  );

  // `approve` would resolve the gate and change nothing — the node stays arch-gated with no shape, so `drive`
  // goes straight back to await_human. The only difference is that the register now says a human signed it off.
  assert.throws(() => recordNoTargetShapeDecision(reg, id, "approve", { decided_by: "alice", ts: "T2" }), /approve|nothing to approve/i);
  assert.throws(() => recordNoTargetShapeDecision(reg, id, "override:frobnicate", { decided_by: "alice", ts: "T2" }), /not a disposition/i);
  assert.throws(() => recordNoTargetShapeDecision(reg, id, "override:seal", { ts: "T2" }), /decided_by/i);
  const arch = raiseEscalation(empty(), { kind: "ARCH_REVIEW", node_ids: [SIG] }, { ts: "T" });
  assert.throws(
    () => recordNoTargetShapeDecision(arch, arch.escalations[0].id, "override:seal", { decided_by: "alice", ts: "T" }),
    /not a NO_TARGET_SHAPE/i,
  );
});

// The load-bearing wiring. Without it the decision is parsed, allowlisted and durably recorded — and read by
// nobody, which is the exact failure replan-overrides.js was built to close for the disposition gate.
test("collectOverrides reads a NO_TARGET_SHAPE override: this gate's decision IS a disposition", () => {
  const raised = raiseNoTargetShape(empty(), UNPLACEABLE, { ts: "T" });
  const reg = recordNoTargetShapeDecision(raised, raised.escalations[0].id, "override:seal", { decided_by: "alice", ts: "T2", run_id: "r1" });
  assert.deepEqual(collectOverrides(reg, "r1"), { [SIG]: { disposition: "seal", decided_by: "alice", decided_at: "T2" } });
  assert.deepEqual(collectOverrides(reg, "other-run"), {}, "still run-scoped — another run's decision must not leak in");
});

test("an `other:` decision is recorded but is NOT an override — nothing is re-dispositioned on a freeform note", () => {
  const raised = raiseNoTargetShape(empty(), UNPLACEABLE, { ts: "T" });
  const reg = recordNoTargetShapeDecision(raised, raised.escalations[0].id, "other: add an ALV-report shape to the corpus", { decided_by: "alice", ts: "T2", run_id: "r1" });
  assert.deepEqual(collectOverrides(reg, "r1"), {});
});

// ---- end-to-end: the lane the operator is actually told to walk ----

function mkCli() {
  const base = mkdtempSync(join(tmpdir(), "nts-cli-"));
  const state = join(base, "state");
  const runs = join(base, "runs");
  const cli = (...a) => JSON.parse(execFileSync(process.execPath, [CLI, ...a, "--state-dir", state, "--runs-dir", runs], { encoding: "utf8" }));
  cli.planOf = (runId) => JSON.parse(readFileSync(join(state, "plan", `${runId}.plan.json`), "utf8"));
  return cli;
}

test("E2E plan → disposition → arch → decide override:seal → replan: an unplaceable node becomes buildable again", () => {
  const cli = mkCli();
  const planned = cli("plan", FIXTURE);
  cli("disposition", planned.run_id); // the disposition gate's own reviews are open on these same nodes
  const arch = cli("arch", planned.run_id, FIXTURE);
  assert.ok(arch.unplaceable.length > 0, "the fixture must still exercise the unplaceable path");

  const all = cli("escalations", planned.run_id, "--max", "99");
  const gates = [...all.surfaced, ...all.queued].filter((e) => e.kind === "NO_TARGET_SHAPE");
  assert.equal(gates.length, arch.unplaceable.length, "one gate per unplaceable node — the id the remedy names now exists");
  const sig = arch.unplaceable[0].sig;
  const gate = gates.find((e) => e.node_ids[0] === sig);
  assert.ok(gate, `no gate names ${sig}`);

  cli("decide", planned.run_id, gate.id, "override:seal", "--by", "alice");
  const out = cli("replan", planned.run_id, FIXTURE, "--by", "alice");
  assert.equal(out.replanned, true);
  assert.ok(out.changed.some((c) => c.sig === sig && c.to === "seal"), `the override must reach the plan: ${JSON.stringify(out.changed)}`);

  const node = cli.planOf(out.new_run_id).nodes.find((n) => n.id === sig);
  assert.equal(node.disposition, "seal", "the node is no longer arch-gated — it routes to the manual seam");
  assert.equal(node.disposition_source, "operator_override");
});
