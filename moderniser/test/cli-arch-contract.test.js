import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPlan, planHash } from "../src/sched/plan.js";
import { consumptionFacts } from "../src/plan/consumption-facts.js";
import { persistenceFacts } from "../src/plan/persistence-facts.js";
import { factHash, factStream } from "../src/plan/arch-facts.js";
import { matchTargetShapes } from "../src/plan/patterns/match.js";
import { putEntry } from "../src/state/arch-verdict-cache.js";
import { groupingDecision } from "../src/plan/arch-row.js";
import {
  CLI, FIXTURE, GROUPING_FIXTURE, mk, seedCache, seedCacheWithForeignShared, topShape, consOf, persOf,
  archNode, PLACEABLE, PLACEABLE_GROUPING, archNodes, stateOf, manifestOf, archEscs, writeShared,
  reviewOk, reviewAndApprove, humanRatify,
} from "./helpers/arch-cli.js";

// cli-arch, split by concern: contract freeze, ratification lifecycle and the fail-closed guards.
// Bodies moved VERBATIM from the former single 998-line suite; the shared harness lives in
// ./helpers/arch-cli.js so it is defined once rather than copied. See that file for why the split exists.

// ---- the F2 anchor: plan persists the doc hashes ----

test("plan persists source_hash/config_hash into run state (the F2 augment-safe anchor)", () => {
  const { stateDir, run } = mk();
  const planned = run("plan", FIXTURE);
  const doc = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const st = stateOf(stateDir, planned.run_id);
  assert.equal(st.source_hash, doc.source_hash);
  assert.equal(st.config_hash, doc.config_hash);
});

// ---- cache MISS: every node escalates → NO contracts, NO ARCH_REVIEW (RESOLVED-only, reviewer LOW) ----

test("arch: every node escalates (cache miss) → 0 contracts, 0 ARCH_REVIEW, pending requests in the manifest", () => {
  const { stateDir, runsDir, run } = mk();
  const planned = run("plan", FIXTURE);
  const out = run("arch", planned.run_id, FIXTURE, "--model", "opus", "--prompt-hash", "ph1");
  assert.equal(out.resolved, 0);
  assert.equal(out.pending, PLACEABLE);
  assert.equal(archEscs(run, planned.run_id).length, 0, "no ARCH_REVIEW without a bound contract");
  assert.deepEqual(stateOf(stateDir, planned.run_id).arch_contracts, {}, "no contracts bound");
  const m = manifestOf(runsDir, planned.run_id);
  assert.equal(m.rows.length, 0);
  assert.equal(m.pending.length, PLACEABLE);
  assert.ok(m.pending.every((p) => p.fact && Array.isArray(p.candidates)), "each pending row carries the P8 fact + candidates the fulfiller judges");
});

// ---- cache HIT: a resolved node binds a contract + raises ONE ARCH_REVIEW + a fit_to_standard row ----

test("arch: a cached node → binds a contract + raises ONE ARCH_REVIEW + a fit_to_standard row + options", () => {
  const { stateDir, runsDir, run } = mk();
  const planned = run("plan", FIXTURE);
  const target = archNode(loadPlan(planned.run_id, stateDir));
  seedCache(stateDir, target, consOf(), persOf());
  const out = run("arch", planned.run_id, FIXTURE, "--model", "opus", "--prompt-hash", "ph1");
  assert.equal(out.resolved, 1);
  assert.equal(out.pending, PLACEABLE - 1);
  assert.equal(out.rows[0].sig, target.id);
  assert.equal(out.rows[0].target_shape, "rap_bo_headless");

  const arch = archEscs(run, planned.run_id);
  assert.equal(arch.length, 1, "exactly one ARCH_REVIEW, for the resolved node");
  assert.deepEqual(arch[0].node_ids, [target.id]);

  assert.ok(existsSync(join(runsDir, planned.run_id, `arch-contract-${target.id}.json`)), "the contract file is written");
  const st = stateOf(stateDir, planned.run_id);
  assert.ok(st.arch_contracts[target.id].hash, "the contract is bound into run state");
  assert.equal(st.arch_contracts[target.id].ratified_by, null, "bound but not yet ratified");

  assert.ok(!/^([A-Za-z]:[\\/]|\/)/.test(st.arch_contracts[target.id].ref), "the persisted ref is host-portable, not an absolute path");
  assert.equal(st.arch_contracts[target.id].ref, `${planned.run_id}/arch-contract-${target.id}.json`);

  const row = manifestOf(runsDir, planned.run_id).rows.find((r) => r.sig === target.id);
  assert.ok(["verify_live", "build"].includes(row.fit_to_standard.action), "a fit_to_standard advisory is carried");
  assert.equal(row.options[0].target_shape, "rap_bo_headless");
  assert.equal(row.options[0].recommended, true);
  assert.ok(row.options.some((o) => o.freeform && o.target_shape === "other"), "a single-candidate node still carries the 'other' refine escape");
});

test("arch is idempotent — a re-run rebinds the same contract hash + raises no duplicate ARCH_REVIEW", () => {
  const { stateDir, run } = mk();
  const planned = run("plan", FIXTURE);
  const target = archNode(loadPlan(planned.run_id, stateDir));
  seedCache(stateDir, target, consOf(), persOf());
  const a = run("arch", planned.run_id, FIXTURE, "--model", "opus", "--prompt-hash", "ph1");
  const b = run("arch", planned.run_id, FIXTURE, "--model", "opus", "--prompt-hash", "ph1");
  assert.equal(a.rows[0].contract_hash, b.rows[0].contract_hash);
  assert.equal(archEscs(run, planned.run_id).length, 1, "no duplicate review on re-run");
});

// ---- the ratification-preservation invariant (cli-arch.js: "a re-run never silently un-ratifies") ----

test("arch re-run PRESERVES an existing ratification when the contract hash is unchanged", () => {
  const { stateDir, run } = mk();
  const planned = run("plan", FIXTURE);
  const target = archNode(loadPlan(planned.run_id, stateDir));
  seedCache(stateDir, target, consOf(), persOf());
  run("arch", planned.run_id, FIXTURE, "--model", "opus", "--prompt-hash", "ph1");
  humanRatify(run, planned.run_id, target.id);
  assert.equal(stateOf(stateDir, planned.run_id).arch_contracts[target.id].ratified_by, "eng", "precondition: ratified");

  run("arch", planned.run_id, FIXTURE, "--model", "opus", "--prompt-hash", "ph1"); // identical facts → identical hash
  const after = stateOf(stateDir, planned.run_id).arch_contracts[target.id];
  assert.equal(after.ratified_by, "eng", "a re-run must NEVER silently un-ratify (it would re-block the driver)");
});

test("arch re-run CLEARS the ratification when the contract hash changes (re-ratification is required)", () => {
  const { stateDir, run } = mk();
  const planned = run("plan", FIXTURE);
  const target = archNode(loadPlan(planned.run_id, stateDir));
  seedCache(stateDir, target, consOf(), persOf());
  run("arch", planned.run_id, FIXTURE, "--model", "opus", "--prompt-hash", "ph1");
  humanRatify(run, planned.run_id, target.id);

  // What the human ratified is a SPECIFIC contract hash. Simulate the contract having been ratified under a
  // different hash (the shape the operator approved is not the shape now being frozen): the re-run must NOT
  // carry that ratification over. Written against the durable state, since this fixture's node has exactly
  // one structural candidate — a different shape could never legitimately reach the cache (see M3).
  const statePath = join(stateDir, "runs", `${planned.run_id}.state.json`);
  const st = JSON.parse(readFileSync(statePath, "utf8"));
  st.arch_contracts[target.id].hash = "a-different-contract-hash";
  writeFileSync(statePath, JSON.stringify(st, null, 2));

  run("arch", planned.run_id, FIXTURE, "--model", "opus", "--prompt-hash", "ph1");
  const after = stateOf(stateDir, planned.run_id).arch_contracts[target.id];
  assert.equal(after.ratified_by, null, "a changed contract voids the ratification — the human must re-ratify what changed");
});

test("decide reject leaves the node UNRATIFIED, so the driver refuses to build it", () => {
  const { stateDir, run } = mk();
  const planned = run("plan", FIXTURE);
  const target = archNode(loadPlan(planned.run_id, stateDir));
  seedCache(stateDir, target, consOf(), persOf());
  run("arch", planned.run_id, FIXTURE, "--model", "opus", "--prompt-hash", "ph1");
  run("decide", planned.run_id, archEscs(run, planned.run_id)[0].id, "reject", "--by", "eng");
  assert.equal(stateOf(stateDir, planned.run_id).arch_contracts[target.id].ratified_by, null, "a reject ratifies nothing");
  assert.equal(run("drive", planned.run_id).action, "await_human", "and the driver will not build it");
});

// G (adversarial pass #2, conflicting verdicts — adjudicated): raising a review for a contract the human
// already ratified at the SAME hash shows a gate the driver correctly ignores, accumulates duplicate rows,
// and contradicts the lane's promise that re-ratification is required only for what CHANGED.

test("G a re-run does NOT re-raise ARCH_REVIEW for a still-ratified, unchanged contract", () => {
  const { stateDir, run } = mk();
  const planned = run("plan", FIXTURE);
  const target = archNode(loadPlan(planned.run_id, stateDir));
  seedCache(stateDir, target, consOf(), persOf());
  run("arch", planned.run_id, FIXTURE, "--model", "opus", "--prompt-hash", "ph1");
  humanRatify(run, planned.run_id, target.id);

  run("arch", planned.run_id, FIXTURE, "--model", "opus", "--prompt-hash", "ph1");
  assert.equal(archEscs(run, planned.run_id).length, 0, "nothing to ask: the human already approved this exact contract");
  assert.equal(stateOf(stateDir, planned.run_id).arch_contracts[target.id].ratified_by, "eng", "and the ratification survives");
});

test("G a CHANGED contract DOES raise a fresh ARCH_REVIEW (re-ratify exactly what changed)", () => {
  const { stateDir, run } = mk();
  const planned = run("plan", FIXTURE);
  const target = archNode(loadPlan(planned.run_id, stateDir));
  seedCache(stateDir, target, consOf(), persOf());
  run("arch", planned.run_id, FIXTURE, "--model", "opus", "--prompt-hash", "ph1");
  humanRatify(run, planned.run_id, target.id);

  const statePath = join(stateDir, "runs", `${planned.run_id}.state.json`);
  const st = JSON.parse(readFileSync(statePath, "utf8"));
  st.arch_contracts[target.id].hash = "a-different-contract-hash"; // what was ratified is not what is now frozen
  writeFileSync(statePath, JSON.stringify(st, null, 2));

  run("arch", planned.run_id, FIXTURE, "--model", "opus", "--prompt-hash", "ph1");
  assert.equal(archEscs(run, planned.run_id).length, 1, "the changed contract must be re-ratified");
  assert.equal(stateOf(stateDir, planned.run_id).arch_contracts[target.id].ratified_by, null);
});

// ---- fail-closed guards ----

test("arch fails closed when the findings doc source_hash drifts from the planned run (F2)", () => {
  const { base, run } = mk();
  const planned = run("plan", FIXTURE);
  const drifted = JSON.parse(readFileSync(FIXTURE, "utf8"));
  drifted.source_hash = "0".repeat(64);
  const p = join(base, "drifted.json");
  writeFileSync(p, JSON.stringify(drifted));
  assert.throws(() => run("arch", planned.run_id, p, "--model", "opus", "--prompt-hash", "ph1"));
});

test("M2 arch fails CLOSED when the findings doc carries no source_hash/config_hash (the check must not no-op)", () => {
  const { base, run } = mk();
  const hashless = JSON.parse(readFileSync(FIXTURE, "utf8"));
  delete hashless.source_hash;
  delete hashless.config_hash;
  const p = join(base, "hashless.json");
  writeFileSync(p, JSON.stringify(hashless));
  const planned = run("plan", p);
  // Both sides are absent, so a `?? null` comparison finds them EQUAL — under which ANY unidentified doc
  // verifies against a run planned from ANY other. Identity must be positively established, not merely
  // "not mismatched".
  assert.throws(() => run("arch", planned.run_id, p, "--model", "opus", "--prompt-hash", "ph1"));
  assert.throws(() => run("arch-verdict", planned.run_id, p, "0".repeat(64), "--shape", "rap_bo_headless", "--by", "j", "--rationale", "batch_report only, no interactive or remote surface", "--confidence", "medium"));
});

test("arch requires a findings doc (positional or --findings)", () => {
  const { run } = mk();
  const planned = run("plan", FIXTURE);
  assert.throws(() => run("arch", planned.run_id));
});

