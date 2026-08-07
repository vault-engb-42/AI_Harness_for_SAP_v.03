import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { loadPlan, planHash } from "../src/sched/plan.js";
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
function seedCache(stateDir, node, cons, { model = "opus", promptHash = "ph1", shape = "rap_bo_headless", candidates } = {}) {
  const rec = { sig: node.id, target_shape: shape, components: [], invariants: [], candidates: candidates ?? [{ id: shape, score: 1 }], source: "judge" };
  const cache = putEntry({ entries: {} }, factHash(node, cons), model, promptHash, rec);
  writeFileSync(join(stateDir, "arch-verdict-cache.json"), JSON.stringify(cache, null, 2));
  return rec;
}

/** Seed the cache with a judge verdict whose `shared` grouping names a sig from ANOTHER run. */
function seedCacheWithForeignShared(stateDir, node, cons, foreignSig, opts = {}) {
  const { model = "opus", promptHash = "ph1", shape = "rap_bo_headless" } = opts;
  const rec = {
    sig: node.id, target_shape: shape, components: [], invariants: [],
    candidates: [{ id: shape, score: 1 }], source: "judge",
    shared: { services: [{ id: "SRV_ORDER_MGMT", members: [foreignSig] }], projections: [], fiori_apps: [] },
  };
  writeFileSync(join(stateDir, "arch-verdict-cache.json"), JSON.stringify(putEntry({ entries: {} }, factHash(node, cons), model, promptHash, rec), null, 2));
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
  reviewOk(run, planned.run_id, target.id);
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
  reviewOk(run, planned.run_id, target.id);
  run("decide", planned.run_id, archEscs(run, planned.run_id)[0].id, "approve", "--by", "eng");

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
  const target = loadPlan(planned.run_id, stateDir).nodes[0];
  seedCache(stateDir, target, consOf());
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
  const target = loadPlan(planned.run_id, stateDir).nodes[0];
  seedCache(stateDir, target, consOf());
  run("arch", planned.run_id, FIXTURE, "--model", "opus", "--prompt-hash", "ph1");
  reviewOk(run, planned.run_id, target.id);
  run("decide", planned.run_id, archEscs(run, planned.run_id)[0].id, "approve", "--by", "eng");

  run("arch", planned.run_id, FIXTURE, "--model", "opus", "--prompt-hash", "ph1");
  assert.equal(archEscs(run, planned.run_id).length, 0, "nothing to ask: the human already approved this exact contract");
  assert.equal(stateOf(stateDir, planned.run_id).arch_contracts[target.id].ratified_by, "eng", "and the ratification survives");
});

test("G a CHANGED contract DOES raise a fresh ARCH_REVIEW (re-ratify exactly what changed)", () => {
  const { stateDir, run } = mk();
  const planned = run("plan", FIXTURE);
  const target = loadPlan(planned.run_id, stateDir).nodes[0];
  seedCache(stateDir, target, consOf());
  run("arch", planned.run_id, FIXTURE, "--model", "opus", "--prompt-hash", "ph1");
  reviewOk(run, planned.run_id, target.id);
  run("decide", planned.run_id, archEscs(run, planned.run_id)[0].id, "approve", "--by", "eng");

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
  assert.throws(() => run("arch-verdict", planned.run_id, p, "0".repeat(64), "--shape", "rap_bo_headless", "--by", "j"));
});

test("arch requires a findings doc (positional or --findings)", () => {
  const { run } = mk();
  const planned = run("plan", FIXTURE);
  assert.throws(() => run("arch", planned.run_id));
});

// ---- H3+M3: the judge-verdict ingestion verb (closes the await_arch loop) ----

test("H3 arch-verdict ingests a judge selection, and a following `arch` RESOLVES the node from cache", () => {
  const { stateDir, runsDir, run } = mk();
  const planned = run("plan", FIXTURE);
  const first = run("arch", planned.run_id, FIXTURE);
  assert.equal(first.resolved, 0, "precondition: every node awaits the judge");
  const pending = manifestOf(runsDir, planned.run_id).pending;

  // the fulfiller judged the FIRST pending request (P8: it only ever saw request.fact) and records it
  const ing = run("arch-verdict", planned.run_id, FIXTURE, pending[0].sig, "--shape", "rap_bo_headless", "--by", "judge-agent");
  assert.equal(ing.target_shape, "rap_bo_headless");
  assert.ok(ing.fact_hash, "the verdict is keyed on the P8 fact hash");

  const second = run("arch", planned.run_id, FIXTURE);
  assert.equal(second.resolved, 1, "the ingested verdict resolves the node — the loop closes");
  assert.equal(second.pending, pending.length - 1);
  assert.equal(archEscs(run, planned.run_id).length, 1, "an ARCH_REVIEW is now raised for the resolved node");
  assert.ok(stateOf(stateDir, planned.run_id).arch_contracts[pending[0].sig].hash, "a contract is bound");
});

// V1 (adversarial pass #3, CONFIRMED by end-to-end reproduction): the verdict cache is CROSS-RUN by design,
// and `factStream` is deliberately sig-free for P8 — so two structurally identical objects in different
// packages produce the SAME fact hash with DISJOINT sigs. That is exactly what makes the cache reusable, and
// exactly what makes its PAYLOAD dangerous: a judge verdict frozen in run X carries run X's sigs inside
// `shared`. M3 re-validates the cached target_shape and nothing else, so those foreign sigs reached
// checkBlueprint, which threw out of the whole `arch` verb BEFORE the manifest was written — leaving no
// pending request, so `arch-verdict` refused every correction and the run could never recover in-band.
//
// A cached entry whose grouping names sigs this plan does not contain was frozen for a different run. That
// is a cache MISS, not a fatal error: re-escalate the node to the judge.
test("V1 a cached grouping naming a FOREIGN run's sig is a cache miss, not a dead run", () => {
  const { stateDir, runsDir, run } = mk();
  const planned = run("plan", FIXTURE);
  const target = loadPlan(planned.run_id, stateDir).nodes[0];
  seedCacheWithForeignShared(stateDir, target, consOf(), "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");

  const out = run("arch", planned.run_id, FIXTURE, "--model", "opus", "--prompt-hash", "ph1");
  assert.ok(out.pending >= 1, "the poisoned node re-escalates to the judge");
  assert.ok(!out.rows.some((r) => r.sig === target.id), "it is NOT resolved from the foreign entry");
  const m = manifestOf(runsDir, planned.run_id);
  assert.ok(m.pending.some((p) => p.sig === target.id), "and the manifest records the outstanding request, so arch-verdict can serve it");
});

// V1b (closeout pass, CONFIRMED): the first V1 guard checked members against ALL plan nodes, but
// checkBlueprint grades `shared` against the RESOLVED subset (blueprint-conformance.js builds objectSigs
// from cli-arch.js's `assignments: resolved.map(...)`). A member that IS a plan node but is NOT resolved
// this run therefore passed the guard and still threw the whole verb — the same unrecoverable state V1
// claimed to close. This is the ORDINARY incremental-judging shape: one node judged, its siblings still
// pending.
test("V1b a cached grouping naming a plan node that is NOT RESOLVED this run is also a miss", () => {
  const { stateDir, runsDir, run } = mk();
  const planned = run("plan", FIXTURE);
  const nodes = loadPlan(planned.run_id, stateDir).nodes;
  const [a, b] = nodes;
  seedCacheWithForeignShared(stateDir, a, consOf(), b.id); // b is a real plan node — just not judged yet

  const out = run("arch", planned.run_id, FIXTURE, "--model", "opus", "--prompt-hash", "ph1");
  assert.ok(!out.rows.some((r) => r.sig === a.id), "a group naming an unresolved sibling is a miss, not a fatal error");
  assert.equal(out.pending, nodes.length, "so every arch-gated node is awaiting the judge, and the verb survived");
  const m = manifestOf(runsDir, planned.run_id);
  assert.ok(m.pending.some((p) => p.sig === a.id), "and the manifest carries the request, so arch-verdict can serve it");
});

test("V1 a cached grouping naming THIS plan's sigs still resolves from cache (no false miss)", () => {
  const { stateDir, run } = mk();
  const planned = run("plan", FIXTURE);
  const target = loadPlan(planned.run_id, stateDir).nodes[0];
  seedCacheWithForeignShared(stateDir, target, consOf(), target.id); // its OWN sig — the documented lane shape
  const out = run("arch", planned.run_id, FIXTURE, "--model", "opus", "--prompt-hash", "ph1");
  assert.ok(out.rows.some((r) => r.sig === target.id), "a legitimate cached grouping is still reused");
});

test("H3/M3 arch-verdict REFUSES a shape outside the offered candidates (validateSelection, fail-closed)", () => {
  const { runsDir, run } = mk();
  const planned = run("plan", FIXTURE);
  run("arch", planned.run_id, FIXTURE);
  const sig = manifestOf(runsDir, planned.run_id).pending[0].sig;
  // rap_bo_fiori is a real corpus shape but is NOT among this node's structural candidates
  assert.throws(() => run("arch-verdict", planned.run_id, FIXTURE, sig, "--shape", "rap_bo_fiori", "--by", "j"));
  // a shape outside the corpus entirely is refused too (a hallucinated/injected shape can never widen the vocabulary)
  assert.throws(() => run("arch-verdict", planned.run_id, FIXTURE, sig, "--shape", "cap_side_by_side", "--by", "j"));
});

test("H3 arch-verdict refuses the 'other' sentinel (a bespoke shape needs a corpus entry first) and an unknown sig", () => {
  const { runsDir, run } = mk();
  const planned = run("plan", FIXTURE);
  run("arch", planned.run_id, FIXTURE);
  const sig = manifestOf(runsDir, planned.run_id).pending[0].sig;
  assert.throws(() => run("arch-verdict", planned.run_id, FIXTURE, sig, "--shape", "other", "--by", "j"), /corpus/i);
  assert.throws(() => run("arch-verdict", planned.run_id, FIXTURE, "0".repeat(64), "--shape", "rap_bo_headless", "--by", "j"));
  assert.throws(() => run("arch-verdict", planned.run_id, FIXTURE, sig, "--by", "j"), /shape/i);
});

// B (adversarial pass #2, CONFIRMED by probe): the verdict cache is keyed on (fact_hash, model_id,
// prompt_hash). If the fulfiller judges under a different model/prompt than the request was ISSUED under,
// the verdict is frozen under a key `arch` will never read — every step returns success JSON and the run
// silently deadlocks again, which is exactly the failure H3 existed to close. The write seam must therefore
// serve an OUTSTANDING request and prove the key matches it.

test("B arch-verdict REFUSES a key that diverges from the outstanding request (silent deadlock)", () => {
  const { runsDir, run } = mk();
  const planned = run("plan", FIXTURE);
  run("arch", planned.run_id, FIXTURE); // requests issued with model_id null + the committed prompt hash
  const sig = manifestOf(runsDir, planned.run_id).pending[0].sig;
  assert.throws(
    () => run("arch-verdict", planned.run_id, FIXTURE, sig, "--shape", "rap_bo_headless", "--by", "j", "--model", "some-other-model"),
    "a verdict judged under a different model than the request must not be silently frozen",
  );
  assert.throws(
    () => run("arch-verdict", planned.run_id, FIXTURE, sig, "--shape", "rap_bo_headless", "--by", "j", "--prompt-hash", "not-the-committed-prompt"),
    "a verdict judged under a different prompt must not be silently frozen",
  );
});

test("B arch-verdict REFUSES a sig with no outstanding request (nothing asked for this judgment)", () => {
  const { stateDir, run } = mk();
  const planned = run("plan", FIXTURE);
  const sig = loadPlan(planned.run_id, stateDir).nodes[0].id;
  // `arch` has never run, so no request exists for this node
  assert.throws(() => run("arch-verdict", planned.run_id, FIXTURE, sig, "--shape", "rap_bo_headless", "--by", "j"), /outstanding|request|arch/i);
});

test("B the matching key still records, and the recorded key equals the request's (the loop provably closes)", () => {
  const { runsDir, run } = mk();
  const planned = run("plan", FIXTURE);
  run("arch", planned.run_id, FIXTURE, "--model", "opus-x", "--prompt-hash", "ph-x");
  const pending = manifestOf(runsDir, planned.run_id).pending[0];
  const ing = run("arch-verdict", planned.run_id, FIXTURE, pending.sig, "--shape", "rap_bo_headless", "--by", "j", "--model", "opus-x", "--prompt-hash", "ph-x");
  assert.equal(ing.model_id, pending.model_id, "the verdict is recorded under the request's model");
  assert.equal(ing.prompt_hash, pending.prompt_hash, "…and the request's prompt hash");
  assert.equal(ing.fact_hash, pending.fact_hash, "…and the request's fact hash");
  assert.equal(run("arch", planned.run_id, FIXTURE, "--model", "opus-x", "--prompt-hash", "ph-x").resolved, 1, "so the next `arch` resolves it");
});

test("H3 arch-verdict requires a named judge and verifies the findings doc like `arch` does", () => {
  const { base, runsDir, run } = mk();
  const planned = run("plan", FIXTURE);
  run("arch", planned.run_id, FIXTURE);
  const sig = manifestOf(runsDir, planned.run_id).pending[0].sig;
  assert.throws(() => run("arch-verdict", planned.run_id, FIXTURE, sig, "--shape", "rap_bo_headless"), /--by/i);
  const drifted = JSON.parse(readFileSync(FIXTURE, "utf8"));
  drifted.source_hash = "0".repeat(64);
  const p = join(base, "drift.json");
  writeFileSync(p, JSON.stringify(drifted));
  assert.throws(() => run("arch-verdict", planned.run_id, p, sig, "--shape", "rap_bo_headless", "--by", "j"));
});

test("H3 END-TO-END: plan → arch → arch-verdict ×N → arch → decide approve → drive DISPATCHES (no deadlock)", () => {
  const { runsDir, run } = mk();
  const planned = run("plan", FIXTURE);
  assert.equal(run("drive", planned.run_id).action, "await_human", "precondition: the driver is arch-blocked");

  run("arch", planned.run_id, FIXTURE);
  for (const p of manifestOf(runsDir, planned.run_id).pending) {
    run("arch-verdict", planned.run_id, FIXTURE, p.sig, "--shape", "rap_bo_headless", "--by", "judge-agent");
  }
  const resolved = run("arch", planned.run_id, FIXTURE);
  assert.equal(resolved.pending, 0, "every node is judged");
  assert.equal(resolved.resolved, planned.nodes.length);
  reviewAndApprove(run, planned.run_id);

  const d = run("drive", planned.run_id);
  assert.equal(d.action, "generate", "the ratified run now dispatches — the arch gate is operable end to end");
  assert.ok(d.packets.length > 0);
});

// ---- LOW: the MULTI-candidate options branch (buildPromptOptions) was never executed by any test ----

test("LOW a multi-candidate node renders the full prompt contract (>= 3 options, one recommended, an 'other' escape)", () => {
  const { stateDir, runsDir, run } = mk();
  const planned = run("plan", FIXTURE);
  const target = loadPlan(planned.run_id, stateDir).nodes[0];
  // The judge weighed a competing shape — the recommendation carries BOTH candidates, so archOptions takes
  // the buildPromptOptions arm rather than the single-candidate arm the fixture normally exercises.
  seedCache(stateDir, target, consOf(), { candidates: [{ id: "rap_bo_headless", score: 2 }, { id: "rap_bo_odata", score: 1 }] });
  const out = run("arch", planned.run_id, FIXTURE, "--model", "opus", "--prompt-hash", "ph1");
  assert.equal(out.resolved, 1);
  const { options } = manifestOf(runsDir, planned.run_id).rows.find((r) => r.sig === target.id);
  assert.ok(options.length >= 3, `the prompt contract needs >= 3 options, got ${options.length}`);
  assert.equal(options.filter((o) => o.recommended).length, 1, "EXACTLY one recommended option");
  assert.equal(options[0].target_shape, "rap_bo_headless", "the recommendation is listed first");
  assert.ok(options.some((o) => o.target_shape === "rap_bo_odata" && !o.recommended), "the competing shape is offered as an alternative");
  assert.ok(options.some((o) => o.freeform && o.target_shape === "other"), "always an 'other' escape");
});

// ---- M4: the app-blueprint tier must be able to CATCH a cross-object inconsistency ----

const writeShared = (base, name, shared) => {
  const p = join(base, name);
  writeFileSync(p, JSON.stringify(shared));
  return p;
};

test("M4 the blueprint tier REFUSES a shared group naming a plan node that is not in the app", () => {
  const { base, runsDir, run } = mk();
  const planned = run("plan", FIXTURE);
  run("arch", planned.run_id, FIXTURE);
  const pending = manifestOf(runsDir, planned.run_id).pending;
  // The judge groups this BO behind a shared OData service and names a SECOND member which is a real plan
  // node — so the write seam accepts it (F) — but which is never judged, so it is absent from the blueprint.
  // That is the live path for checkBlueprint's cross-object checks: a group referencing an object the app
  // does not contain must block BEFORE any contract freezes.
  const shared = writeShared(base, "shared-bad.json", { services: [{ id: "SRV_X", members: [pending[0].sig, pending[1].sig] }] });
  run("arch-verdict", planned.run_id, FIXTURE, pending[0].sig, "--shape", "rap_bo_headless", "--by", "j", "--shared-json", shared);

  // The grouping must NOT freeze — that is M4's property, and it still holds. But it must not take the verb
  // down with it either (V1b): throwing here wrote no manifest, which left no pending request, which meant
  // `arch-verdict` refused every correction and the run could never recover. Both properties together: the
  // contract does not freeze, and the node returns to the judge with its request on the manifest.
  const out = run("arch", planned.run_id, FIXTURE);
  assert.ok(!out.rows.some((r) => r.sig === pending[0].sig), "the group referencing an unjudged node does NOT freeze a contract");
  assert.ok(manifestOf(runsDir, planned.run_id).pending.some((p) => p.sig === pending[0].sig), "and it is re-offered to the judge, so the run stays recoverable");
});

// The write seam refuses what the reader is guaranteed to refuse: checkBlueprint grades a group against the
// app's blueprint objects — the ARCH-GATED nodes — so a member with any other disposition can never become
// one. Accepting it would freeze into the CROSS-RUN cache a grouping no run can ever satisfy.
test("M4b the judge's grouping may not name a member that can never be a blueprint object", () => {
  const { base, stateDir, runsDir, run } = mk();
  const planned = run("plan", FIXTURE);
  run("arch", planned.run_id, FIXTURE);
  const pending = manifestOf(runsDir, planned.run_id).pending;
  // Rewrite one node's frozen disposition to a non-arch-gated one, then re-point state at the edited plan:
  // the fixture is all-re_architect, so this is the only way to obtain the shape under test.
  const planPath = join(stateDir, "plan", `${planned.run_id}.plan.json`);
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  const victim = plan.nodes.find((n) => n.id === pending[1].sig);
  victim.disposition = "refactor";
  // Re-hash: the plan is content-addressed and loadPlan re-derives it, so an edited node must carry a
  // matching plan_hash or the tamper check fires before the code under test is reached.
  plan.plan_hash = planHash(plan.nodes);
  writeFileSync(planPath, JSON.stringify(plan, null, 2));
  const statePath = join(stateDir, "runs", `${planned.run_id}.state.json`);
  writeFileSync(statePath, JSON.stringify({ ...JSON.parse(readFileSync(statePath, "utf8")), plan_hash: plan.plan_hash }, null, 2));

  const shared = writeShared(base, "shared-nongated.json", { services: [{ id: "SRV_Y", members: [pending[0].sig, victim.id] }] });
  assert.throws(
    () => run("arch-verdict", planned.run_id, FIXTURE, pending[0].sig, "--shape", "rap_bo_headless", "--by", "j", "--shared-json", shared),
    /not an arch-gated plan node/,
    "refused at the writer, before it can reach the cross-run cache",
  );
});

// F (adversarial pass #2, CONFIRMED — both failure modes reproduced): --shared-json is untrusted fulfiller
// input that gets FROZEN into the CROSS-RUN verdict cache. Unvalidated, a malformed grouping either corrupts
// the manifest or throws a raw TypeError out of mergeShared on EVERY subsequent `arch` — permanently, for
// every run sharing that cache. Validate at the boundary where it enters, before anything is frozen.

test("F arch-verdict REFUSES a malformed shared grouping at the boundary (never freezes it into the cache)", () => {
  const { base, runsDir, run } = mk();
  const planned = run("plan", FIXTURE);
  run("arch", planned.run_id, FIXTURE);
  const sig = manifestOf(runsDir, planned.run_id).pending[0].sig;
  const bad = (name, doc) => {
    const p = join(base, name);
    writeFileSync(p, JSON.stringify(doc));
    return () => run("arch-verdict", planned.run_id, FIXTURE, sig, "--shape", "rap_bo_headless", "--by", "j", "--shared-json", p);
  };
  assert.throws(bad("s1.json", { services: 5 }), /shared/i, "a non-array group kind");
  assert.throws(bad("s2.json", { services: [{ members: ["x"] }] }), /shared/i, "a group with no id");
  assert.throws(bad("s3.json", { services: [{ id: "S", members: "not-an-array" }] }), /shared/i, "members must be an array");
  assert.throws(bad("s4.json", { bogus_kind: [{ id: "S", members: [] }] }), /shared/i, "an unknown group kind");
  assert.throws(bad("s5.json", [1, 2, 3]), /shared/i, "the grouping must be an object");
  // and nothing was frozen: the gate still works for a well-formed verdict afterwards
  const ok = run("arch-verdict", planned.run_id, FIXTURE, sig, "--shape", "rap_bo_headless", "--by", "j");
  assert.equal(ok.target_shape, "rap_bo_headless", "the cache is uncorrupted — a valid verdict still records");
  assert.equal(run("arch", planned.run_id, FIXTURE).resolved, 1, "and `arch` is not wedged");
});

test("F a shared group naming a member that is not a PLAN node is refused at the write seam", () => {
  const { base, runsDir, run } = mk();
  const planned = run("plan", FIXTURE);
  run("arch", planned.run_id, FIXTURE);
  const sig = manifestOf(runsDir, planned.run_id).pending[0].sig;
  const p = join(base, "ghost.json");
  writeFileSync(p, JSON.stringify({ services: [{ id: "SRV", members: [sig, "f".repeat(64)] }] }));
  assert.throws(
    () => run("arch-verdict", planned.run_id, FIXTURE, sig, "--shape", "rap_bo_headless", "--by", "j", "--shared-json", p),
    /not a plan node|member/i,
    "caught at the boundary against the PLAN, not later against the resolved subset",
  );
});

// E (adversarial pass #2, CONFIRMED): M4's tier was inert on the real lane because --shared-json had no
// producer — the judge is P8-blocked from naming sigs and the prompt emitted free text. The prompt now
// returns `shared_groups: [{kind, id}]` (this object's membership under a LABEL the judge chose), the
// fulfiller maps label+its own sig into --shared-json, and `arch` UNIONS by label across nodes. This test
// walks that exact lane shape for two objects the judge put under one label.

test("E per-node memberships UNION by label into one app-level group (the lane's real grouping path)", () => {
  const { base, runsDir, run } = mk();
  const planned = run("plan", FIXTURE);
  run("arch", planned.run_id, FIXTURE);
  const pending = manifestOf(runsDir, planned.run_id).pending;

  // the judge put both objects under the same service label; the fulfiller passes each node's OWN sig only
  for (const p of pending.slice(0, 2)) {
    const f = writeShared(base, `grp-${p.sig.slice(0, 8)}.json`, { services: [{ id: "SRV_ORDER_MGMT", members: [p.sig] }] });
    run("arch-verdict", planned.run_id, FIXTURE, p.sig, "--shape", "rap_bo_headless", "--by", "j", "--shared-json", f);
  }
  const out = run("arch", planned.run_id, FIXTURE);
  assert.equal(out.resolved, 2);
  const { services } = manifestOf(runsDir, planned.run_id).shared;
  assert.equal(services.length, 1, "one label → ONE group, not two");
  assert.equal(services[0].id, "SRV_ORDER_MGMT");
  assert.deepEqual(services[0].members.slice().sort(), [pending[0].sig, pending[1].sig].sort(), "both judged objects are members");
});

test("E the committed judge prompt emits the sig-free grouping contract the lane consumes", () => {
  const prompt = readFileSync(new URL("../src/plan/patterns/arch-reason-prompt.md", import.meta.url), "utf8");
  assert.match(prompt, /shared_groups/, "the prompt must ask for the structured grouping");
  assert.match(prompt, /services \| projections \| fiori_apps/, "…keyed on the kinds the blueprint understands");
  assert.ok(!/shared_hint/.test(prompt), "the free-text field the lane could not consume is gone");
});

test("M4 a CONSISTENT shared group passes the tier and reaches the blueprint", () => {
  const { base, runsDir, run } = mk();
  const planned = run("plan", FIXTURE);
  run("arch", planned.run_id, FIXTURE);
  const pending = manifestOf(runsDir, planned.run_id).pending;
  const shared = writeShared(base, "shared-ok.json", { services: [{ id: "SRV_OK", members: [pending[0].sig] }] });
  run("arch-verdict", planned.run_id, FIXTURE, pending[0].sig, "--shape", "rap_bo_headless", "--by", "j", "--shared-json", shared);
  const out = run("arch", planned.run_id, FIXTURE);
  assert.equal(out.resolved, 1, "a consistent grouping freezes normally");
  assert.deepEqual(manifestOf(runsDir, planned.run_id).shared.services, [{ id: "SRV_OK", members: [pending[0].sig] }], "the app-level grouping is carried into the manifest");
});

// ---- D: the independent reviewer's verdict must be RECORDABLE and REQUIRED (GAN separation) ----

/** Record a passing abap-arch-reviewer verdict for a sig — the fresh-context counter-party to the judge. */
function reviewOk(run, runId, sig, payload = { verdict: "pass", flags: [] }) {
  const p = join(mkdtempSync(join(tmpdir(), "arch-rev-")), "verdict.json");
  writeFileSync(p, JSON.stringify(payload));
  return run("arch-review", runId, sig, "--verdict", p, "--by", "abap-arch-reviewer");
}

/** Ratify every OPEN ARCH_REVIEW the way the lane does: independent review first, then the human. */
const reviewAndApprove = (run, runId) => {
  for (const e of archEscs(run, runId)) {
    reviewOk(run, runId, e.node_ids[0]);
    run("decide", runId, e.id, "approve", "--by", "eng");
  }
};

test("D arch-review records the reviewer verdict against the CURRENT contract hash", () => {
  const { base, stateDir, run } = mk();
  const planned = run("plan", FIXTURE);
  const target = loadPlan(planned.run_id, stateDir).nodes[0];
  seedCache(stateDir, target, consOf());
  run("arch", planned.run_id, FIXTURE, "--model", "opus", "--prompt-hash", "ph1");

  const out = reviewOk(run, planned.run_id, target.id, { verdict: "concerns", flags: ["over_built"], notes: "a headless BO would do" });
  assert.equal(out.sig, target.id);
  const bound = stateOf(stateDir, planned.run_id).arch_contracts[target.id].reviewer_verdict;
  assert.equal(bound.verdict, "concerns");
  assert.deepEqual(bound.flags, ["over_built"]);
  assert.equal(bound.reviewed_by, "abap-arch-reviewer");
  assert.equal(bound.contract_hash, stateOf(stateDir, planned.run_id).arch_contracts[target.id].hash, "bound to what was reviewed");
});

test("D approve is REFUSED without an independent reviewer verdict (GAN separation enforced, not prose)", () => {
  const { stateDir, run } = mk();
  const planned = run("plan", FIXTURE);
  const target = loadPlan(planned.run_id, stateDir).nodes[0];
  seedCache(stateDir, target, consOf());
  run("arch", planned.run_id, FIXTURE, "--model", "opus", "--prompt-hash", "ph1");
  const id = archEscs(run, planned.run_id)[0].id;
  assert.throws(() => run("decide", planned.run_id, id, "approve", "--by", "eng"), "the judge's work must be independently reviewed before a human ratifies it");
  // refine / reject need no reviewer — they ratify nothing
  assert.equal(run("decide", planned.run_id, id, "reject", "--by", "eng").decision.verb, "reject");
});

test("D a verdict bound to a DIFFERENT contract hash does not satisfy the gate (no inheriting a review)", () => {
  const { base, stateDir, run } = mk();
  const planned = run("plan", FIXTURE);
  const target = loadPlan(planned.run_id, stateDir).nodes[0];
  seedCache(stateDir, target, consOf());
  run("arch", planned.run_id, FIXTURE, "--model", "opus", "--prompt-hash", "ph1");
  reviewOk(run, planned.run_id, target.id);

  const statePath = join(stateDir, "runs", `${planned.run_id}.state.json`);
  const st = JSON.parse(readFileSync(statePath, "utf8"));
  st.arch_contracts[target.id].hash = "a-different-contract-hash"; // the contract moved on after the review
  writeFileSync(statePath, JSON.stringify(st, null, 2));
  assert.throws(() => run("decide", planned.run_id, archEscs(run, planned.run_id)[0].id, "approve", "--by", "eng"), /review/i);
});

test("D the reviewer payload is validated, and an unknown sig / unbound contract is refused", () => {
  const { base, stateDir, run } = mk();
  const planned = run("plan", FIXTURE);
  const target = loadPlan(planned.run_id, stateDir).nodes[0];
  seedCache(stateDir, target, consOf());
  run("arch", planned.run_id, FIXTURE, "--model", "opus", "--prompt-hash", "ph1");
  const bad = (doc) => {
    const p = join(base, `bad-${Math.abs(JSON.stringify(doc).length)}.json`);
    writeFileSync(p, JSON.stringify(doc));
    return () => run("arch-review", planned.run_id, target.id, "--verdict", p, "--by", "r");
  };
  assert.throws(bad({ flags: [] }), /verdict/i, "a missing verdict");
  assert.throws(bad({ verdict: "maybe", flags: [] }), /verdict/i, "a verdict outside the closed set");
  assert.throws(bad({ verdict: "pass", flags: "nope" }), /flags/i, "flags must be an array");
  assert.throws(() => reviewOk(run, planned.run_id, "0".repeat(64)), /unknown|contract/i, "a sig with no bound contract");
});

// ---- decide: the ARCH_REVIEW ratification branch ----

test("decide approve ratifies an ARCH_REVIEW: contract_hash on the row + ratified_by in state", () => {
  const { stateDir, run } = mk();
  const planned = run("plan", FIXTURE);
  const target = loadPlan(planned.run_id, stateDir).nodes[0];
  seedCache(stateDir, target, consOf());
  run("arch", planned.run_id, FIXTURE, "--model", "opus", "--prompt-hash", "ph1");
  const id = archEscs(run, planned.run_id)[0].id;
  reviewOk(run, planned.run_id, target.id);
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
