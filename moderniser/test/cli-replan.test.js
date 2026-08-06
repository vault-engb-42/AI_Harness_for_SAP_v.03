import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

// P3 / S-c — `replan <run_id> <findings.json> --by <name>`: the verb that makes an operator override at the
// disposition gate actually change what gets built. Real subprocess, real fs, golden fixture — no mocks.
// The invariant under test: a changed disposition re-freezes under a NEW plan_hash (the L6 REPLAN gate).
// A frozen node is never mutated in place and no disposition ever lives at state level.

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "cli.js");
const FIXTURE = join(HERE, "fixtures", "analyser-findings.json");
const BUNDLE = join(HERE, "fixtures", "bundle");

function mkCli() {
  const base = mkdtempSync(join(tmpdir(), "replan-cli-"));
  const state = join(base, "state");
  const runs = join(base, "runs");
  const run = (...a) => execFileSync(process.execPath, [CLI, ...a, "--state-dir", state, "--runs-dir", runs], { encoding: "utf8" });
  const cli = (...a) => JSON.parse(run(...a));
  cli.planOf = (runId) => JSON.parse(readFileSync(join(state, "plan", `${runId}.plan.json`), "utf8"));
  cli.stateOf = (runId) => JSON.parse(readFileSync(join(state, "runs", `${runId}.state.json`), "utf8"));
  // Test-side write of the run's own durable state — the CLI deliberately exposes no verb for this, and a
  // backdoor added for a test would be a write seam the harness has to defend forever.
  cli.putState = (runId, st) => writeFileSync(join(state, "runs", `${runId}.state.json`), JSON.stringify(st, null, 2));
  cli.putPlan = (runId, p) => writeFileSync(join(state, "plan", `${runId}.plan.json`), JSON.stringify(p, null, 2));
  cli.runsDir = runs;
  return cli;
}

/** plan → disposition → decide the FIRST review with `decision`. Returns {cli, planned, sig}. */
function upToDecision(decision) {
  const cli = mkCli();
  const planned = cli("plan", FIXTURE);
  cli("disposition", planned.run_id);
  const esc = cli("escalations", planned.run_id, "--max", "50").surfaced[0];
  cli("decide", planned.run_id, esc.id, decision, "--by", "alice");
  return { cli, planned, sig: esc.node_ids[0] };
}

test("an override re-freezes the plan under a NEW plan_hash and a NEW run id", () => {
  const { cli, planned, sig } = upToDecision("override:retire");
  const out = cli("replan", planned.run_id, FIXTURE, "--by", "alice");

  assert.equal(out.replanned, true);
  assert.equal(out.old_run_id, planned.run_id);
  assert.notEqual(out.new_run_id, planned.run_id, "a different plan is a different run");
  assert.notEqual(out.new_plan_hash, out.old_plan_hash);
  assert.deepEqual(out.changed, [{ sig, from: "re_architect", to: "retire", decided_by: "alice" }]);

  const node = cli.planOf(out.new_run_id).nodes.find((n) => n.id === sig);
  assert.equal(node.disposition, "retire", "the human's decision is now the frozen plan's disposition");
  assert.equal(node.disposition_source, "operator_override");
  assert.equal(node.disposition_decided_by, "alice");
});

// R1 (adversarial pass, CONFIRMED + reproduced): a run that `replan` itself produced carries overrides in
// its frozen nodes, so re-assembling it from the classifier alone can never reproduce its own plan_hash —
// the honesty check was structurally unsatisfiable for exactly the runs the lane tells the operator to
// continue under. A second decision was therefore hard-refused with a diagnosis blaming --bundle (never
// passed), and the fallback of re-running the FIRST replan reported success while dropping it.
test("R1 a SECOND override chains: `replan` runs on a run that `replan` itself produced", () => {
  const { cli, planned, sig } = upToDecision("override:retire");
  const first = cli("replan", planned.run_id, FIXTURE, "--by", "alice");

  // continue under .new_run_id, exactly as the SKILL prescribes
  cli("disposition", first.new_run_id);
  const next = cli("escalations", first.new_run_id, "--max", "50").surfaced
    .find((e) => e.kind === "DISPOSITION_REVIEW" && !e.node_ids.includes(sig));
  assert.ok(next, "the other nodes still have an open disposition review");
  cli("decide", first.new_run_id, next.id, "override:retire", "--by", "bob");

  const second = cli("replan", first.new_run_id, FIXTURE, "--by", "alice");
  assert.equal(second.replanned, true, "the chained replan must not be refused");
  assert.notEqual(second.new_run_id, first.new_run_id);
  assert.deepEqual(second.changed.map((c) => c.sig), next.node_ids, "only the NEW decision is a delta — the inherited one already rides the plan");

  const nodes = cli.planOf(second.new_run_id).nodes.filter((n) => n.disposition_source === "operator_override");
  assert.equal(nodes.length, 2, "BOTH human decisions ride the frozen plan");
  assert.deepEqual(nodes.map((n) => n.disposition_decided_by).sort(), ["alice", "bob"], "each decision keeps its own accountable human");
});

test("R1 an inherited override is not re-reported as a change, and a no-new-decision replan is a no-op", () => {
  const { cli, planned } = upToDecision("override:retire");
  const first = cli("replan", planned.run_id, FIXTURE, "--by", "alice");
  const again = cli("replan", first.new_run_id, FIXTURE, "--by", "alice");
  assert.equal(again.replanned, false, "nothing new was decided against this run");
  assert.deepEqual(again.changed, []);
  assert.equal(again.run_id, first.new_run_id);
});

test("the ORIGINAL plan is left untouched — a frozen artifact is never edited in place", () => {
  const { cli, planned, sig } = upToDecision("override:retire");
  cli("replan", planned.run_id, FIXTURE, "--by", "alice");
  const old = cli.planOf(planned.run_id);
  assert.equal(old.plan_hash, planned.plan_hash);
  assert.equal(old.nodes.find((n) => n.id === sig).disposition, "re_architect", "the old plan still records what the classifier said");
});

test("the new run's state binds to the NEW plan and carries the findings identity forward", () => {
  const { cli, planned } = upToDecision("override:retire");
  const out = cli("replan", planned.run_id, FIXTURE, "--by", "alice");
  const st = cli.stateOf(out.new_run_id);
  const before = cli.stateOf(planned.run_id);
  assert.equal(st.plan_hash, out.new_plan_hash, "loadRun re-hashes on every verb — a mis-bound state fails every later step closed");
  assert.equal(st.source_hash, before.source_hash, "the run still knows which analyser doc it was planned from");
  assert.equal(st.config_hash, before.config_hash);
  assert.equal(st.run_epoch, before.run_epoch, "the same planning episode, re-frozen — not a new attestation domain");
  assert.ok(cli("resume", out.new_run_id).verified, "the migrated run resumes");
});

test("no override → no re-freeze (an approve leaves the classifier's disposition standing)", () => {
  const { cli, planned } = upToDecision("approve");
  const out = cli("replan", planned.run_id, FIXTURE, "--by", "alice");
  assert.equal(out.replanned, false);
  assert.deepEqual(out.changed, []);
  assert.equal(out.run_id, planned.run_id);
});

test("an override to the disposition the classifier ALREADY chose is not a replan", () => {
  const { cli, planned } = upToDecision("override:re_architect");
  const out = cli("replan", planned.run_id, FIXTURE, "--by", "alice");
  assert.equal(out.replanned, false, "no delta, no new plan identity");
});

/**
 * Put one node in flight. Reaching GROUNDED through `dispatch` is impossible for these fixture nodes — they
 * are all re_architect, so the reducer's arch veto refuses them until an Architecture Contract is ratified,
 * which costs a full judge + reviewer round trip. This writes the run's own durable state into a shape the
 * FSM legitimately reaches; it substitutes nothing on the path under test.
 */
function groundOne(cli, runId) {
  const sig = cli.planOf(runId).nodes[0].id;
  const st = cli.stateOf(runId);
  st.status[sig] = "GROUNDED";
  cli.putState(runId, st);
  return sig;
}

test("idempotent repeat: replanning twice returns the same run and does not reset it", () => {
  const { cli, planned } = upToDecision("override:retire");
  const first = cli("replan", planned.run_id, FIXTURE, "--by", "alice");
  const sig = groundOne(cli, first.new_run_id);
  const second = cli("replan", planned.run_id, FIXTURE, "--by", "alice");
  assert.equal(second.new_run_id, first.new_run_id);
  assert.equal(second.already, true, "the overrides were already applied");
  assert.equal(cli.stateOf(first.new_run_id).status[sig], "GROUNDED", "a repeat must never discard the new run's progress");
});

test("fail closed: mid-flight work is not silently restarted — refused without an accountable --force", () => {
  const { cli, planned } = upToDecision("override:retire");
  groundOne(cli, planned.run_id);
  assert.throws(() => cli("replan", planned.run_id, FIXTURE, "--by", "alice"), /in flight|--force/);
  const forced = cli("replan", planned.run_id, FIXTURE, "--by", "alice", "--force");
  assert.equal(forced.replanned, true);
  assert.equal(forced.restarted.length, 1, "the forced restart names the work it discarded");
  assert.equal(cli.stateOf(forced.new_run_id).status[forced.restarted[0]], "PENDING", "the restart is real, not just reported");
});

test("fail closed: a run frozen under an older node schema is named as such, not blamed on the bundle", () => {
  // schema_version is deliberately outside plan_hash, so an older-schema plan still loads and verifies —
  // it simply cannot re-assemble to its own hash, because the node fields moved underneath it. Without this
  // guard the reproduction check reports a bundle mismatch, sending the operator after the wrong cause.
  const { cli, planned } = upToDecision("override:retire");
  const plan = cli.planOf(planned.run_id);
  cli.putPlan(planned.run_id, { ...plan, schema_version: "1.5.0" });
  assert.throws(() => cli("replan", planned.run_id, FIXTURE, "--by", "alice"), /schema 1\.5\.0/);
});

// R9 (adversarial pass, CONFIRMED): SKILL.md declares --bundle MANDATORY for `plan`, yet every replan test
// ran the abnormal unsealed path — so the sealed path the operator actually uses had no coverage at all,
// and the reproduction check is precisely where a bundle mismatch surfaces.
test("R9 replan reproduces a run planned WITH --bundle, and refuses the same run without it", () => {
  const cli = mkCli();
  const planned = cli("plan", FIXTURE, "--bundle", BUNDLE);
  cli("disposition", planned.run_id);
  const esc = cli("escalations", planned.run_id, "--max", "50").surfaced[0];
  cli("decide", planned.run_id, esc.id, "override:retire", "--by", "alice");

  // omitting the bundle plans a DIFFERENT (unsealed) graph — the check must catch it, not absorb it
  assert.throws(() => cli("replan", planned.run_id, FIXTURE, "--by", "alice"), /--bundle/);

  const out = cli("replan", planned.run_id, FIXTURE, "--bundle", BUNDLE, "--by", "alice");
  assert.equal(out.replanned, true);
  assert.equal(cli.planOf(out.new_run_id).nodes.find((n) => n.id === esc.node_ids[0]).disposition, "retire");
});

test("fail closed: a replan needs a named human", () => {
  const { cli, planned } = upToDecision("override:retire");
  assert.throws(() => cli("replan", planned.run_id, FIXTURE), /--by/);
});

test("fail closed: replanning against a DIFFERENT findings doc is refused", () => {
  const { cli, planned } = upToDecision("override:retire");
  const drifted = join(mkdtempSync(join(tmpdir(), "replan-doc-")), "findings.json");
  writeFileSync(drifted, JSON.stringify({ ...JSON.parse(readFileSync(FIXTURE, "utf8")), source_hash: "deadbeef" }));
  assert.throws(() => cli("replan", planned.run_id, drifted, "--by", "alice"), /source_hash/);
});

// P3 / S-e — the whole loop, end to end. This is the proof that the override path is REAL: before P3 the
// decision was recorded and ignored, so `outcome RETIRED` was unreachable (assertDispositionTerminal reads
// the FROZEN disposition, which still said re_architect) and the driver kept offering the node as build work.
test("END-TO-END: override:retire → replan → drive routes to retire → RETIRED terminals complete the run", () => {
  const cli = mkCli();
  const planned = cli("plan", FIXTURE);
  cli("disposition", planned.run_id);
  for (const e of cli("escalations", planned.run_id, "--max", "50").surfaced) {
    cli("decide", planned.run_id, e.id, "override:retire", "--by", "alice");
  }

  const out = cli("replan", planned.run_id, FIXTURE, "--by", "alice");
  assert.equal(out.changed.length, planned.nodes.length, "every node the human re-dispositioned moved");

  let decision = cli("drive", out.new_run_id);
  assert.equal(decision.action, "retire", "the driver routes retire to its own action, never to the generator");
  assert.ok(decision.packets.length < planned.nodes.length, "dependency order still holds: a dependent is not offered before its dependency resolves");

  const retired = [];
  for (let round = 0; decision.action === "retire" && round < planned.nodes.length; round += 1) {
    for (const p of decision.packets) {
      cli("dispatch", out.new_run_id, p.sig); // a retire node GROUNDS to establish its basis, then terminates
      cli("outcome", out.new_run_id, p.sig, "RETIRED", "--signed-by", "alice", "--justification", "no released successor; capability dropped");
      retired.push(p.sig);
    }
    decision = cli("drive", out.new_run_id);
  }
  // The cascade is the point: before P3 only GREEN released a dependent, so a dropped dependency left its
  // dependents waiting at indegree > 0 with no verb able to move them.
  assert.deepEqual(retired.sort(), out.changed.map((c) => c.sig).sort(), "every node reached its terminal");
  assert.deepEqual(decision, { action: "complete" });

  // The manifest is what a human ratifies: it must show the drop was a human's call, not a classification.
  const gate = cli("disposition", out.new_run_id);
  assert.deepEqual(gate.dropped_dependencies, [], "§7.4: retiring the WHOLE cluster is coherent — nothing is left calling a dropped object");
  const row = JSON.parse(readFileSync(join(cli.runsDir, out.new_run_id, "disposition-manifest.json"), "utf8")).rows[0];
  assert.equal(row.source, "operator_override");
  assert.equal(row.decided_by, "alice");
  assert.equal(row.confidence, null, "no classifier confidence is reported for a decision the classifier did not make");

  // B4: the run removed three objects from the in-stack estate with no verdict behind any of them, so the
  // ledger is the only place the evidence pack records what went, on whose authority, and on what basis.
  const ledger = JSON.parse(readFileSync(join(cli.runsDir, out.new_run_id, "dropped-features.json"), "utf8"));
  assert.equal(ledger.rows.length, planned.nodes.length, "every drop is in the ledger");
  assert.ok(ledger.rows.every((r) => r.signed_by === "alice" && r.justification), "each row carries its audited sign-off");
  assert.ok(ledger.rows.every((r) => r.grounded_basis), "and the grounded basis the retire option rested on");

  const status = cli("status", out.new_run_id);
  assert.equal(status.complete, true, "a run of dropped objects completes with no verdict — and only with signed terminals");
  assert.equal(cli.stateOf(out.new_run_id).disposition_register.length, planned.nodes.length, "each drop is audited to a named human");
});

// §7.4 (operator-ruled) — dropping an object that other in-plan work still depends on is ALLOWED, but the
// consequence must reach the human at the plan gate. Whole-cluster drops raise nothing (covered above: the
// end-to-end retires all three nodes and asserts no DROPPED_DEPENDENCY).
test("§7.4 dropping an object other nodes still depend on raises a DROPPED_DEPENDENCY at gate 1", () => {
  const cli = mkCli();
  const planned = cli("plan", FIXTURE);
  cli("disposition", planned.run_id);
  // pick a node that something else in the plan actually depends on, rather than assuming an ordering
  const plan = cli.planOf(planned.run_id);
  const depended = plan.nodes.find((n) => plan.nodes.some((m) => (m.dependencies ?? []).includes(n.id)));
  assert.ok(depended, "the golden fixture has a dependency edge to exercise");

  const esc = cli("escalations", planned.run_id, "--max", "50").surfaced.find((e) => e.node_ids[0] === depended.id);
  cli("decide", planned.run_id, esc.id, "override:retire", "--by", "alice");
  const out = cli("replan", planned.run_id, FIXTURE, "--by", "alice");

  const gate = cli("disposition", out.new_run_id);
  assert.equal(gate.dropped_dependencies.length, 1, "the drop is reported at the gate, not left to an ATC failure downstream");
  assert.equal(gate.dropped_dependencies[0].retired, depended.id);
  assert.ok(gate.dropped_dependencies[0].dependents.length > 0);

  const raised = cli("packets", out.new_run_id, "--max", "50").packets.find((p) => p.kind === "DROPPED_DEPENDENCY");
  assert.ok(raised, "it reaches the human as a GatePacket");
  assert.ok(raised.cause.includes(depended.id), "the packet names the object being dropped");
  assert.deepEqual(raised.decisions, ["ACCEPT_DROP", "REVISE_DISPOSITION"]);

  // A gate the human cannot DECIDE is an inert mechanism. `decide` routes this kind through the generic
  // recorder, so prove both that a typed decision resolves it and that an untyped one is refused.
  const row = cli("decide", out.new_run_id, raised.id, "ACCEPT_DROP", "--by", "alice");
  assert.equal(row.status, "RESOLVED");
  assert.equal(row.resolved_by, "alice");
  assert.equal(row.decision, "ACCEPT_DROP");
});

test("§7.4 an untyped decision on a DROPPED_DEPENDENCY is refused", () => {
  const cli = mkCli();
  const planned = cli("plan", FIXTURE);
  const plan = cli.planOf(planned.run_id);
  const depended = plan.nodes.find((n) => plan.nodes.some((m) => (m.dependencies ?? []).includes(n.id)));
  cli("disposition", planned.run_id);
  const esc = cli("escalations", planned.run_id, "--max", "50").surfaced.find((e) => e.node_ids[0] === depended.id);
  cli("decide", planned.run_id, esc.id, "override:retire", "--by", "alice");
  const out = cli("replan", planned.run_id, FIXTURE, "--by", "alice");
  cli("disposition", out.new_run_id);
  const id = cli("packets", out.new_run_id, "--max", "50").packets.find((p) => p.kind === "DROPPED_DEPENDENCY").id;
  assert.throws(() => cli("decide", out.new_run_id, id, "LOOKS_FINE", "--by", "alice"), /LOOKS_FINE|decision/i);
});

test("a ratified architecture survives a replan of a DIFFERENT node, and is voided for the changed one", () => {
  // The contract the human approved describes THIS node's architecture. Untouched nodes keep their
  // ratification (re-asking for approval of unchanged work is the fail-closed-into-deadlock failure H1
  // removed); the overridden node loses it, because it was ratified for a disposition that no longer holds.
  const { cli, planned, sig } = upToDecision("override:retire");
  const other = cli.planOf(planned.run_id).nodes.map((n) => n.id).find((s) => s !== sig);
  const st = cli.stateOf(planned.run_id);
  st.arch_contracts = {
    [sig]: { ref: `${planned.run_id}/arch-contract-${sig}.json`, hash: "h1", ratified_by: "alice", reviewer_verdict: "pass" },
    [other]: { ref: `${planned.run_id}/arch-contract-${other}.json`, hash: "h2", ratified_by: "alice", reviewer_verdict: "pass" },
  };
  cli.putState(planned.run_id, st);
  // --force is REQUIRED here: discarding an architecture a human already approved is exactly the kind of
  // decision that must be signed for, never absorbed silently.
  assert.throws(() => cli("replan", planned.run_id, FIXTURE, "--by", "alice"), /ratif/i);
  const out = cli("replan", planned.run_id, FIXTURE, "--by", "alice", "--force");
  const migrated = cli.stateOf(out.new_run_id);
  assert.equal(migrated.arch_contracts[sig], undefined, "the overridden node's ratification is void");
  assert.equal(migrated.arch_contracts[other]?.ratified_by, "alice", "the untouched node keeps its human approval");
});
