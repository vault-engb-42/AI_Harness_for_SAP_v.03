import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { loadPlan } from "../src/sched/plan.js";
import { consumptionFacts } from "../src/plan/consumption-facts.js";
import { factHash } from "../src/plan/arch-facts.js";
import { putEntry } from "../src/state/arch-verdict-cache.js";

// B3.5a wiring seam 2 (§4c "cmdArch verb"): the plan-time ARCHITECTURE gate, end-to-end (real subprocess,
// real fs, real modules — no mocks). cmdArch re-reads the findings doc (augment-safe source_hash/config_hash
// check, reviewer F2), reasons a target_shape per re_architect/rebuild node (deterministic | cached | await),
// runs the mandatory app-blueprint tier (reviewer F1) before freezing per-object contracts, binds them into
// run state, emits the architecture-manifest (with a fit_to_standard slot, F4), and raises one ARCH_REVIEW
// per RESOLVED node only (reviewer LOW). `decide` ratifies an ARCH_REVIEW into state.arch_contracts.

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "cli.js");
const FIXTURE = join(HERE, "fixtures", "analyser-findings.json");

function mk() {
  const base = mkdtempSync(join(tmpdir(), "arch-cli-"));
  const stateDir = join(base, "state");
  const runsDir = join(base, "runs");
  const run = (...a) => JSON.parse(execFileSync(process.execPath, [CLI, ...a, "--state-dir", stateDir, "--runs-dir", runsDir], { encoding: "utf8" }));
  return { base, stateDir, runsDir, run };
}

// Seed the CROSS-RUN verdict cache so a named node resolves as 'cached' — the real fulfiller flow (the judge
// writes the cache, cmdArch re-run hits it). A real cache file + the real fact hash; no mocks.
function seedCache(stateDir, node, cons, { model = "opus", promptHash = "ph1", shape = "rap_bo_headless" } = {}) {
  const rec = { sig: node.id, target_shape: shape, components: [], invariants: [], candidates: [{ id: shape, score: 1 }], source: "judge" };
  const cache = putEntry({ entries: {} }, factHash(node, cons), model, promptHash, rec);
  writeFileSync(join(stateDir, "arch-verdict-cache.json"), JSON.stringify(cache, null, 2));
  return rec;
}

const consOf = () => consumptionFacts(JSON.parse(readFileSync(FIXTURE, "utf8")));
const stateOf = (stateDir, runId) => JSON.parse(readFileSync(join(stateDir, "runs", `${runId}.state.json`), "utf8"));
const manifestOf = (runsDir, runId) => JSON.parse(readFileSync(join(runsDir, runId, "architecture-manifest.json"), "utf8"));
const archEscs = (run, runId) => {
  const e = run("escalations", runId, "--max", "50");
  return [...e.surfaced, ...e.queued].filter((x) => x.kind === "ARCH_REVIEW");
};

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
  assert.equal(out.pending, planned.nodes.length);
  assert.equal(archEscs(run, planned.run_id).length, 0, "no ARCH_REVIEW without a bound contract");
  assert.deepEqual(stateOf(stateDir, planned.run_id).arch_contracts, {}, "no contracts bound");
  const m = manifestOf(runsDir, planned.run_id);
  assert.equal(m.rows.length, 0);
  assert.equal(m.pending.length, planned.nodes.length);
  assert.ok(m.pending.every((p) => p.fact && Array.isArray(p.candidates)), "each pending row carries the P8 fact + candidates the fulfiller judges");
});

// ---- cache HIT: a resolved node binds a contract + raises ONE ARCH_REVIEW + a fit_to_standard row ----

test("arch: a cached node → binds a contract + raises ONE ARCH_REVIEW + a fit_to_standard row + options", () => {
  const { stateDir, runsDir, run } = mk();
  const planned = run("plan", FIXTURE);
  const target = loadPlan(planned.run_id, stateDir).nodes[0];
  seedCache(stateDir, target, consOf());
  const out = run("arch", planned.run_id, FIXTURE, "--model", "opus", "--prompt-hash", "ph1");
  assert.equal(out.resolved, 1);
  assert.equal(out.pending, planned.nodes.length - 1);
  assert.equal(out.rows[0].sig, target.id);
  assert.equal(out.rows[0].target_shape, "rap_bo_headless");

  const arch = archEscs(run, planned.run_id);
  assert.equal(arch.length, 1, "exactly one ARCH_REVIEW, for the resolved node");
  assert.deepEqual(arch[0].node_ids, [target.id]);

  assert.ok(existsSync(join(runsDir, planned.run_id, `arch-contract-${target.id}.json`)), "the contract file is written");
  const st = stateOf(stateDir, planned.run_id);
  assert.ok(st.arch_contracts[target.id].hash, "the contract is bound into run state");
  assert.equal(st.arch_contracts[target.id].ratified_by, null, "bound but not yet ratified");

  const row = manifestOf(runsDir, planned.run_id).rows.find((r) => r.sig === target.id);
  assert.ok(["verify_live", "build"].includes(row.fit_to_standard.action), "a fit_to_standard advisory is carried");
  assert.equal(row.options[0].target_shape, "rap_bo_headless");
  assert.equal(row.options[0].recommended, true);
  assert.ok(row.options.some((o) => o.freeform && o.target_shape === "other"), "a single-candidate node still carries the 'other' refine escape");
});

test("arch is idempotent — a re-run rebinds the same contract hash + raises no duplicate ARCH_REVIEW", () => {
  const { stateDir, run } = mk();
  const planned = run("plan", FIXTURE);
  const target = loadPlan(planned.run_id, stateDir).nodes[0];
  seedCache(stateDir, target, consOf());
  const a = run("arch", planned.run_id, FIXTURE, "--model", "opus", "--prompt-hash", "ph1");
  const b = run("arch", planned.run_id, FIXTURE, "--model", "opus", "--prompt-hash", "ph1");
  assert.equal(a.rows[0].contract_hash, b.rows[0].contract_hash);
  assert.equal(archEscs(run, planned.run_id).length, 1, "no duplicate review on re-run");
});

// ---- the ratification-preservation invariant (cli-arch.js: "a re-run never silently un-ratifies") ----

test("arch re-run PRESERVES an existing ratification when the contract hash is unchanged", () => {
  const { stateDir, run } = mk();
  const planned = run("plan", FIXTURE);
  const target = loadPlan(planned.run_id, stateDir).nodes[0];
  seedCache(stateDir, target, consOf());
  run("arch", planned.run_id, FIXTURE, "--model", "opus", "--prompt-hash", "ph1");
  const id = archEscs(run, planned.run_id)[0].id;
  run("decide", planned.run_id, id, "approve", "--by", "eng");
  assert.equal(stateOf(stateDir, planned.run_id).arch_contracts[target.id].ratified_by, "eng", "precondition: ratified");

  run("arch", planned.run_id, FIXTURE, "--model", "opus", "--prompt-hash", "ph1"); // identical facts → identical hash
  const after = stateOf(stateDir, planned.run_id).arch_contracts[target.id];
  assert.equal(after.ratified_by, "eng", "a re-run must NEVER silently un-ratify (it would re-block the driver)");
});

test("arch re-run CLEARS the ratification when the contract hash changes (re-ratification is required)", () => {
  const { stateDir, run } = mk();
  const planned = run("plan", FIXTURE);
  const target = loadPlan(planned.run_id, stateDir).nodes[0];
  seedCache(stateDir, target, consOf());
  run("arch", planned.run_id, FIXTURE, "--model", "opus", "--prompt-hash", "ph1");
  const id = archEscs(run, planned.run_id)[0].id;
  run("decide", planned.run_id, id, "approve", "--by", "eng");

  // a DIFFERENT judged shape → a different contract → the old ratification must not carry over
  seedCache(stateDir, target, consOf(), { shape: "rap_bo_odata" });
  run("arch", planned.run_id, FIXTURE, "--model", "opus", "--prompt-hash", "ph1");
  const after = stateOf(stateDir, planned.run_id).arch_contracts[target.id];
  assert.equal(after.ratified_by, null, "a changed contract voids the ratification — the human must re-ratify what changed");
});

test("decide reject/refine on a re-raised ARCH_REVIEW CLEARS a prior ratification (approve→reject must not stay dispatchable)", () => {
  const { stateDir, run } = mk();
  const planned = run("plan", FIXTURE);
  const target = loadPlan(planned.run_id, stateDir).nodes[0];
  seedCache(stateDir, target, consOf());
  run("arch", planned.run_id, FIXTURE, "--model", "opus", "--prompt-hash", "ph1");
  run("decide", planned.run_id, archEscs(run, planned.run_id)[0].id, "approve", "--by", "eng");
  assert.equal(stateOf(stateDir, planned.run_id).arch_contracts[target.id].ratified_by, "eng", "precondition: ratified");

  // the re-run raises a FRESH ARCH_REVIEW over the (preserved) ratified contract; the operator now rejects
  run("arch", planned.run_id, FIXTURE, "--model", "opus", "--prompt-hash", "ph1");
  const reopened = archEscs(run, planned.run_id);
  assert.equal(reopened.length, 1, "a fresh OPEN ARCH_REVIEW is raised after the prior one resolved");
  run("decide", planned.run_id, reopened[0].id, "reject", "--by", "eng");
  assert.equal(
    stateOf(stateDir, planned.run_id).arch_contracts[target.id].ratified_by, null,
    "a reject must VOID the prior ratification — otherwise the driver keeps dispatching rejected architecture",
  );
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

test("arch requires a findings doc (positional or --findings)", () => {
  const { run } = mk();
  const planned = run("plan", FIXTURE);
  assert.throws(() => run("arch", planned.run_id));
});

// ---- decide: the ARCH_REVIEW ratification branch ----

test("decide approve ratifies an ARCH_REVIEW: contract_hash on the row + ratified_by in state", () => {
  const { stateDir, run } = mk();
  const planned = run("plan", FIXTURE);
  const target = loadPlan(planned.run_id, stateDir).nodes[0];
  seedCache(stateDir, target, consOf());
  run("arch", planned.run_id, FIXTURE, "--model", "opus", "--prompt-hash", "ph1");
  const id = archEscs(run, planned.run_id)[0].id;
  const row = run("decide", planned.run_id, id, "approve", "--by", "eng");
  assert.equal(row.status, "RESOLVED");
  assert.equal(row.decision.verb, "approve");
  assert.ok(row.decision.contract_hash, "the ratified contract hash is bound onto the decision");
  const st = stateOf(stateDir, planned.run_id);
  assert.equal(st.arch_contracts[target.id].ratified_by, "eng");
  assert.equal(st.arch_contracts[target.id].hash, row.decision.contract_hash);
});

test("decide refine on an ARCH_REVIEW captures notes and ratifies NO contract", () => {
  const { stateDir, run } = mk();
  const planned = run("plan", FIXTURE);
  const target = loadPlan(planned.run_id, stateDir).nodes[0];
  seedCache(stateDir, target, consOf());
  run("arch", planned.run_id, FIXTURE, "--model", "opus", "--prompt-hash", "ph1");
  const id = archEscs(run, planned.run_id)[0].id;
  const row = run("decide", planned.run_id, id, "refine:use analytical_cds", "--by", "eng");
  assert.equal(row.decision.verb, "refine");
  assert.equal(row.decision.notes, "use analytical_cds");
  assert.equal(stateOf(stateDir, planned.run_id).arch_contracts[target.id].ratified_by, null, "a refine ratifies nothing");
});
