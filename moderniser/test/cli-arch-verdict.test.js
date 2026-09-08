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
  reviewOk, reviewAndApprove,
} from "./helpers/arch-cli.js";

// cli-arch, split by concern: the judge-verdict ingestion verb and cached-grouping resolution.
// Bodies moved VERBATIM from the former single 998-line suite; the shared harness lives in
// ./helpers/arch-cli.js so it is defined once rather than copied. See that file for why the split exists.

// ---- H3+M3: the judge-verdict ingestion verb (closes the await_arch loop) ----

test("H3 arch-verdict ingests a judge selection, and a following `arch` RESOLVES the node from cache", () => {
  const { stateDir, runsDir, run } = mk();
  const planned = run("plan", FIXTURE);
  const first = run("arch", planned.run_id, FIXTURE);
  assert.equal(first.resolved, 0, "precondition: every node awaits the judge");
  const pending = manifestOf(runsDir, planned.run_id).pending;

  // the fulfiller judged the FIRST pending request (P8: it only ever saw request.fact) and records it
  const ing = run("arch-verdict", planned.run_id, FIXTURE, pending[0].sig, "--shape", "rap_bo_headless", "--by", "judge-agent", "--rationale", "batch_report only, no interactive or remote surface", "--confidence", "medium");
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
  const target = archNode(loadPlan(planned.run_id, stateDir));
  seedCacheWithForeignShared(stateDir, target, consOf(), persOf(), "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");

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
  const planned = run("plan", GROUPING_FIXTURE);
  const nodes = archNodes(loadPlan(planned.run_id, stateDir));
  const [a, b] = nodes;
  seedCacheWithForeignShared(stateDir, a, consOf(GROUPING_FIXTURE), persOf(GROUPING_FIXTURE), b.id); // b is a real plan node — just not judged yet

  const out = run("arch", planned.run_id, GROUPING_FIXTURE, "--model", "opus", "--prompt-hash", "ph1");
  assert.ok(!out.rows.some((r) => r.sig === a.id), "a group naming an unresolved sibling is a miss, not a fatal error");
  assert.equal(out.pending, PLACEABLE_GROUPING, "so every PLACEABLE node is awaiting the judge, and the verb survived");
  const m = manifestOf(runsDir, planned.run_id);
  assert.ok(m.pending.some((p) => p.sig === a.id), "and the manifest carries the request, so arch-verdict can serve it");
});

// INV (Arc B closeout): the property C1 actually violated, stated once instead of case by case.
// reasonArchNodes must never hand the blueprint tier a grouping the tier will reject — whatever shape the
// cached grouping has. V1 checked members against ALL plan nodes while the tier checks the RESOLVED subset,
// so the two disagreed and `arch` threw before writing the manifest, leaving no recovery. Enumerating the
// shapes means the NEXT grouping shape someone adds is covered without anyone remembering to test it.
test("INV `arch` never throws a blueprint violation for a cached grouping, whatever it names", () => {
  const FOREIGN = "deadbeef".repeat(8);
  const shapes = (n) => [
    ["its own sig", [n[0].id]],
    ["an unresolved sibling", [n[1].id]],
    ["both siblings", [n[1].id, n[2].id]],
    ["a foreign run's sig", [FOREIGN]],
    ["own + foreign", [n[0].id, FOREIGN]],
    ["an empty member list", []],
  ];

  const probe = mk();
  const nodes = loadPlan(probe.run("plan", FIXTURE).run_id, probe.stateDir).nodes;
  for (const [label, members] of shapes(nodes)) {
    const ctx = mk(); // a fresh state dir per shape — the verdict cache is CROSS-RUN by design
    const p = ctx.run("plan", FIXTURE);
    const target = loadPlan(p.run_id, ctx.stateDir).nodes[0];
    const rec = {
      sig: target.id, target_shape: "rap_bo_headless", components: [], invariants: [],
      candidates: [{ id: "rap_bo_headless", score: 1 }], source: "judge",
      shared: { services: [{ id: "SRV", members }], projections: [], fiori_apps: [] },
    };
    writeFileSync(join(ctx.stateDir, "arch-verdict-cache.json"), JSON.stringify(putEntry({ entries: {} }, factHash(target, consOf(), persOf()), "opus", "ph1", rec), null, 2));

    ctx.run("arch", p.run_id, FIXTURE, "--model", "opus", "--prompt-hash", "ph1"); // must not throw
    assert.ok(
      existsSync(join(ctx.runsDir, p.run_id, "architecture-manifest.json")),
      `'${label}': the manifest is written, so the run is always recoverable in-band`,
    );
  }
});

test("V1 a cached grouping naming THIS plan's sigs still resolves from cache (no false miss)", () => {
  const { stateDir, run } = mk();
  const planned = run("plan", FIXTURE);
  const target = archNode(loadPlan(planned.run_id, stateDir));
  seedCacheWithForeignShared(stateDir, target, consOf(), persOf(), target.id); // its OWN sig — the documented lane shape
  const out = run("arch", planned.run_id, FIXTURE, "--model", "opus", "--prompt-hash", "ph1");
  assert.ok(out.rows.some((r) => r.sig === target.id), "a legitimate cached grouping is still reused");
});

test("H3/M3 arch-verdict REFUSES a shape outside the offered candidates (validateSelection, fail-closed)", () => {
  const { runsDir, run } = mk();
  const planned = run("plan", FIXTURE);
  run("arch", planned.run_id, FIXTURE);
  const sig = manifestOf(runsDir, planned.run_id).pending[0].sig;
  // rap_bo_fiori is a real corpus shape but is NOT among this node's structural candidates
  assert.throws(() => run("arch-verdict", planned.run_id, FIXTURE, sig, "--shape", "rap_bo_fiori", "--by", "j", "--rationale", "batch_report only, no interactive or remote surface", "--confidence", "medium"));
  // a shape outside the corpus entirely is refused too (a hallucinated/injected shape can never widen the vocabulary)
  assert.throws(() => run("arch-verdict", planned.run_id, FIXTURE, sig, "--shape", "cap_side_by_side", "--by", "j", "--rationale", "batch_report only, no interactive or remote surface", "--confidence", "medium"));
});

test("H3 arch-verdict refuses the 'other' sentinel (a bespoke shape needs a corpus entry first) and an unknown sig", () => {
  const { runsDir, run } = mk();
  const planned = run("plan", FIXTURE);
  run("arch", planned.run_id, FIXTURE);
  const sig = manifestOf(runsDir, planned.run_id).pending[0].sig;
  assert.throws(() => run("arch-verdict", planned.run_id, FIXTURE, sig, "--shape", "other", "--by", "j", "--rationale", "batch_report only, no interactive or remote surface", "--confidence", "medium"), /corpus/i);
  assert.throws(() => run("arch-verdict", planned.run_id, FIXTURE, "0".repeat(64), "--shape", "rap_bo_headless", "--by", "j", "--rationale", "batch_report only, no interactive or remote surface", "--confidence", "medium"));
  assert.throws(() => run("arch-verdict", planned.run_id, FIXTURE, sig, "--by", "j", "--rationale", "batch_report only, no interactive or remote surface", "--confidence", "medium"), /shape/i);
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
    () => run("arch-verdict", planned.run_id, FIXTURE, sig, "--shape", "rap_bo_headless", "--by", "j", "--rationale", "batch_report only, no interactive or remote surface", "--confidence", "medium", "--model", "some-other-model"),
    "a verdict judged under a different model than the request must not be silently frozen",
  );
  assert.throws(
    () => run("arch-verdict", planned.run_id, FIXTURE, sig, "--shape", "rap_bo_headless", "--by", "j", "--rationale", "batch_report only, no interactive or remote surface", "--confidence", "medium", "--prompt-hash", "not-the-committed-prompt"),
    "a verdict judged under a different prompt must not be silently frozen",
  );
});

test("B arch-verdict REFUSES a sig with no outstanding request (nothing asked for this judgment)", () => {
  const { stateDir, run } = mk();
  const planned = run("plan", FIXTURE);
  const sig = archNode(loadPlan(planned.run_id, stateDir)).id;
  // `arch` has never run, so no request exists for this node
  assert.throws(() => run("arch-verdict", planned.run_id, FIXTURE, sig, "--shape", "rap_bo_headless", "--by", "j", "--rationale", "batch_report only, no interactive or remote surface", "--confidence", "medium"), /outstanding|request|arch/i);
});

test("B the matching key still records, and the recorded key equals the request's (the loop provably closes)", () => {
  const { runsDir, run } = mk();
  const planned = run("plan", FIXTURE);
  run("arch", planned.run_id, FIXTURE, "--model", "opus-x", "--prompt-hash", "ph-x");
  const pending = manifestOf(runsDir, planned.run_id).pending[0];
  const ing = run("arch-verdict", planned.run_id, FIXTURE, pending.sig, "--shape", "rap_bo_headless", "--by", "j", "--rationale", "batch_report only, no interactive or remote surface", "--confidence", "medium", "--model", "opus-x", "--prompt-hash", "ph-x");
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
  assert.throws(() => run("arch-verdict", planned.run_id, p, sig, "--shape", "rap_bo_headless", "--by", "j", "--rationale", "batch_report only, no interactive or remote surface", "--confidence", "medium"));
});

test("H3 END-TO-END: plan → arch → arch-verdict ×N → arch → decide approve → drive DISPATCHES (no deadlock)", () => {
  const { runsDir, run } = mk();
  const planned = run("plan", GROUPING_FIXTURE);
  assert.equal(run("drive", planned.run_id).action, "await_human", "precondition: the driver is arch-blocked");

  run("arch", planned.run_id, GROUPING_FIXTURE);
  for (const p of manifestOf(runsDir, planned.run_id).pending) {
    run("arch-verdict", planned.run_id, GROUPING_FIXTURE, p.sig, "--shape", p.candidates[0].id, "--by", "judge-agent", "--rationale", "batch_report only, no interactive or remote surface", "--confidence", "medium");
  }
  const resolved = run("arch", planned.run_id, GROUPING_FIXTURE);
  assert.equal(resolved.pending, 0, "every node is judged");
  assert.equal(resolved.resolved, PLACEABLE_GROUPING);
  reviewAndApprove(run, planned.run_id);

  const d = run("drive", planned.run_id);
  assert.equal(d.action, "generate", "the ratified run now dispatches — the arch gate is operable end to end");
  assert.ok(d.packets.length > 0);
});

// ---- LOW: the MULTI-candidate options branch (buildPromptOptions) was never executed by any test ----

test("LOW a multi-candidate node renders the full prompt contract (>= 3 options, one recommended, an 'other' escape)", () => {
  const { stateDir, runsDir, run } = mk();
  const planned = run("plan", FIXTURE);
  const target = archNode(loadPlan(planned.run_id, stateDir));
  // The judge weighed a competing shape — the recommendation carries BOTH candidates, so archOptions takes
  // the buildPromptOptions arm rather than the single-candidate arm the fixture normally exercises.
  seedCache(stateDir, target, consOf(), persOf(), { candidates: [{ id: "rap_bo_headless", score: 2 }, { id: "rap_bo_odata", score: 1 }] });
  const out = run("arch", planned.run_id, FIXTURE, "--model", "opus", "--prompt-hash", "ph1");
  assert.equal(out.resolved, 1);
  const { options } = manifestOf(runsDir, planned.run_id).rows.find((r) => r.sig === target.id);
  assert.ok(options.length >= 3, `the prompt contract needs >= 3 options, got ${options.length}`);
  assert.equal(options.filter((o) => o.recommended).length, 1, "EXACTLY one recommended option");
  assert.equal(options[0].target_shape, "rap_bo_headless", "the recommendation is listed first");
  assert.ok(options.some((o) => o.target_shape === "rap_bo_odata" && !o.recommended), "the competing shape is offered as an alternative");
  assert.ok(options.some((o) => o.freeform && o.target_shape === "other"), "always an 'other' escape");
});

