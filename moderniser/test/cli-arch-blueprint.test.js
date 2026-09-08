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

// cli-arch, split by concern: the app-blueprint tier and cross-object grouping.
// Bodies moved VERBATIM from the former single 998-line suite; the shared harness lives in
// ./helpers/arch-cli.js so it is defined once rather than copied. See that file for why the split exists.

// ---- M4: the app-blueprint tier must be able to CATCH a cross-object inconsistency ----


test("M4 the blueprint tier REFUSES a shared group naming a plan node that is not in the app", () => {
  const { base, runsDir, run } = mk();
  const planned = run("plan", GROUPING_FIXTURE);
  run("arch", planned.run_id, GROUPING_FIXTURE);
  const pending = manifestOf(runsDir, planned.run_id).pending;
  // The judge groups this BO behind a shared OData service and names a SECOND member which is a real plan
  // node — so the write seam accepts it (F) — but which is never judged, so it is absent from the blueprint.
  // That is the live path for checkBlueprint's cross-object checks: a group referencing an object the app
  // does not contain must block BEFORE any contract freezes.
  const shared = writeShared(base, "shared-bad.json", { services: [{ id: "SRV_X", members: [pending[0].sig, pending[1].sig] }] });
  run("arch-verdict", planned.run_id, GROUPING_FIXTURE, pending[0].sig, "--shape", pending[0].candidates[0].id, "--by", "j", "--rationale", "batch_report only, no interactive or remote surface", "--confidence", "medium", "--shared-json", shared);

  // The grouping must NOT freeze — that is M4's property, and it still holds. But it must not take the verb
  // down with it either (V1b): throwing here wrote no manifest, which left no pending request, which meant
  // `arch-verdict` refused every correction and the run could never recover. Both properties together: the
  // contract does not freeze, and the node returns to the judge with its request on the manifest.
  const out = run("arch", planned.run_id, GROUPING_FIXTURE);
  assert.ok(!out.rows.some((r) => r.sig === pending[0].sig), "the group referencing an unjudged node does NOT freeze a contract");
  assert.ok(manifestOf(runsDir, planned.run_id).pending.some((p) => p.sig === pending[0].sig), "and it is re-offered to the judge, so the run stays recoverable");
});

// The write seam refuses what the reader is guaranteed to refuse: checkBlueprint grades a group against the
// app's blueprint objects — the ARCH-GATED nodes — so a member with any other disposition can never become
// one. Accepting it would freeze into the CROSS-RUN cache a grouping no run can ever satisfy.
test("M4b the judge's grouping may not name a member that can never be a blueprint object", () => {
  const { base, stateDir, runsDir, run } = mk();
  const planned = run("plan", GROUPING_FIXTURE);
  run("arch", planned.run_id, GROUPING_FIXTURE);
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
    () => run("arch-verdict", planned.run_id, GROUPING_FIXTURE, pending[0].sig, "--shape", pending[0].candidates[0].id, "--by", "j", "--rationale", "batch_report only, no interactive or remote surface", "--confidence", "medium", "--shared-json", shared),
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
    return () => run("arch-verdict", planned.run_id, FIXTURE, sig, "--shape", "rap_bo_headless", "--by", "j", "--rationale", "batch_report only, no interactive or remote surface", "--confidence", "medium", "--shared-json", p);
  };
  assert.throws(bad("s1.json", { services: 5 }), /shared/i, "a non-array group kind");
  assert.throws(bad("s2.json", { services: [{ members: ["x"] }] }), /shared/i, "a group with no id");
  assert.throws(bad("s3.json", { services: [{ id: "S", members: "not-an-array" }] }), /shared/i, "members must be an array");
  assert.throws(bad("s4.json", { bogus_kind: [{ id: "S", members: [] }] }), /shared/i, "an unknown group kind");
  assert.throws(bad("s5.json", [1, 2, 3]), /shared/i, "the grouping must be an object");
  // and nothing was frozen: the gate still works for a well-formed verdict afterwards
  const ok = run("arch-verdict", planned.run_id, FIXTURE, sig, "--shape", "rap_bo_headless", "--by", "j", "--rationale", "batch_report only, no interactive or remote surface", "--confidence", "medium");
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
    () => run("arch-verdict", planned.run_id, FIXTURE, sig, "--shape", "rap_bo_headless", "--by", "j", "--rationale", "batch_report only, no interactive or remote surface", "--confidence", "medium", "--shared-json", p),
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
  const planned = run("plan", GROUPING_FIXTURE);
  run("arch", planned.run_id, GROUPING_FIXTURE);
  const pending = manifestOf(runsDir, planned.run_id).pending;

  // the judge put both objects under the same service label; the fulfiller passes each node's OWN sig only
  for (const p of pending.slice(0, 2)) {
    const f = writeShared(base, `grp-${p.sig.slice(0, 8)}.json`, { services: [{ id: "SRV_ORDER_MGMT", members: [p.sig] }] });
    run("arch-verdict", planned.run_id, GROUPING_FIXTURE, p.sig, "--shape", p.candidates[0].id, "--by", "j", "--rationale", "batch_report only, no interactive or remote surface", "--confidence", "medium", "--shared-json", f);
  }
  const out = run("arch", planned.run_id, GROUPING_FIXTURE);
  assert.ok(out.resolved >= 2, `both judged nodes resolve: ${out.resolved}`);
  const { services } = manifestOf(runsDir, planned.run_id).shared;
  assert.equal(services.length, 1, "one label → ONE group, not two");
  assert.equal(services[0].id, "SRV_ORDER_MGMT");
  for (const p of pending.slice(0, 2)) assert.ok(services[0].members.includes(p.sig), "each judged object is a member of the single unioned group");
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
  run("arch-verdict", planned.run_id, FIXTURE, pending[0].sig, "--shape", "rap_bo_headless", "--by", "j", "--rationale", "batch_report only, no interactive or remote surface", "--confidence", "medium", "--shared-json", shared);
  const out = run("arch", planned.run_id, FIXTURE);
  assert.equal(out.resolved, 1, "a consistent grouping freezes normally");
  assert.deepEqual(manifestOf(runsDir, planned.run_id).shared.services, [{ id: "SRV_OK", members: [pending[0].sig] }], "the app-level grouping is carried into the manifest");
});

