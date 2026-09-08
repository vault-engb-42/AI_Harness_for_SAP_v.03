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

// cli-arch, split by concern: the independent reviewer gate, ratification and the manifest rows.
// Bodies moved VERBATIM from the former single 998-line suite; the shared harness lives in
// ./helpers/arch-cli.js so it is defined once rather than copied. See that file for why the split exists.

// ---- D: the independent reviewer's verdict must be RECORDABLE and REQUIRED (GAN separation) ----

test("D arch-review records the reviewer verdict against the CURRENT contract hash", () => {
  const { base, stateDir, run } = mk();
  const planned = run("plan", FIXTURE);
  const target = archNode(loadPlan(planned.run_id, stateDir));
  seedCache(stateDir, target, consOf(), persOf());
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
  const target = archNode(loadPlan(planned.run_id, stateDir));
  seedCache(stateDir, target, consOf(), persOf());
  run("arch", planned.run_id, FIXTURE, "--model", "opus", "--prompt-hash", "ph1");
  const id = archEscs(run, planned.run_id)[0].id;
  assert.throws(() => run("decide", planned.run_id, id, "approve", "--by", "eng"), "the judge's work must be independently reviewed before a human ratifies it");
  // refine / reject need no reviewer — they ratify nothing
  assert.equal(run("decide", planned.run_id, id, "reject", "--by", "eng").decision.verb, "reject");
});

test("D a verdict bound to a DIFFERENT contract hash does not satisfy the gate (no inheriting a review)", () => {
  const { base, stateDir, run } = mk();
  const planned = run("plan", FIXTURE);
  const target = archNode(loadPlan(planned.run_id, stateDir));
  seedCache(stateDir, target, consOf(), persOf());
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
  const target = archNode(loadPlan(planned.run_id, stateDir));
  seedCache(stateDir, target, consOf(), persOf());
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
  const target = archNode(loadPlan(planned.run_id, stateDir));
  seedCache(stateDir, target, consOf(), persOf());
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
  const target = archNode(loadPlan(planned.run_id, stateDir));
  seedCache(stateDir, target, consOf(), persOf());
  run("arch", planned.run_id, FIXTURE, "--model", "opus", "--prompt-hash", "ph1");
  const id = archEscs(run, planned.run_id)[0].id;
  const row = run("decide", planned.run_id, id, "refine:use analytical_cds", "--by", "eng");
  assert.equal(row.decision.verb, "refine");
  assert.equal(row.decision.notes, "use analytical_cds");
  assert.equal(stateOf(stateDir, planned.run_id).arch_contracts[target.id].ratified_by, null, "a refine ratifies nothing");
});

// F-2 (ARCH_REVIEW independent reviewer, equalize-idoc demo 2026-08-09): the manifest reported
// `rationale: "judge"` for every resolved row, because freezeJudgeSelection stamps source:"judge" on ANY
// recorded verdict. The `--by` identity — WHO actually selected the shape — reached the run log and the
// verdict cache, but never the manifest a human reads at the ratification gate. A row a judge reasoned
// about and a row recorded by a matcher default were therefore indistinguishable to the person being asked
// to ratify them. On the equalize-idoc run that mattered: 7 of 9 rows were recorded as
// `deterministic-single-candidate` and every one of them presented as "judge".
test("a resolved arch row names WHO selected its shape, not merely that it came through the judge seam", () => {
  const { stateDir, runsDir, run } = mk();
  const planned = run("plan", GROUPING_FIXTURE);
  const cons = consOf(GROUPING_FIXTURE);
  const pers = persOf(GROUPING_FIXTURE);
  const target = archNode(loadPlan(planned.run_id, stateDir));
  seedCache(stateDir, target, cons, pers, { model: "opus", promptHash: "ph1", shape: "rap_bo_headless", judgedBy: "test-judge" });
  run("arch", planned.run_id, GROUPING_FIXTURE, "--model", "opus", "--prompt-hash", "ph1");

  const row = manifestOf(runsDir, planned.run_id).rows.find((r) => r.sig === target.id);
  assert.ok(row, "the node resolves from the seeded cache");
  assert.equal(row.judged_by, "test-judge", `the manifest must name the selector: ${JSON.stringify(row).slice(0, 240)}`);
});

// APP-LEVEL GROUPING AT THE GATE. "These 14 programs become ONE Fiori app" is the largest architectural
// call a run makes, and it used to ride onto the manifest unreviewed: `checkBlueprint` proves the blueprint
// is internally CONSISTENT, never that a human agreed to it. The human ratified each object's shape and was
// never shown what it was being grouped WITH.
//
// The grouping now appears on the row the human is already ratifying, in the same recommended + alternatives
// + freeform shape the target-shape decision uses — so it can be validated or overridden, not merely
// observed. An object in no group has no grouping decision to make and carries none.
test("a grouped object shows its grouping as a decidable option, not as a fait accompli", () => {
  const blueprint = { shared: { fiori_apps: [{ id: "APP_MAINT", members: ["sigA", "sigB", "sigC"] }] } };
  const decisions = groupingDecision("sigA", blueprint);
  assert.equal(decisions.length, 1, "a grouped object carries its grouping decision");
  const d = decisions[0];
  assert.equal(d.kind, "fiori_apps");
  assert.equal(d.id, "APP_MAINT");
  const rec = d.options.find((o) => o.recommended);
  assert.ok(rec && /APP_MAINT/.test(rec.group), `the judge's grouping is the recommendation: ${JSON.stringify(rec)}`);
  assert.match(rec.rationale, /2 other/, "it says how many objects it is being joined to");
  assert.ok(d.options.some((o) => /standalone/i.test(o.group)), "standing alone must be offerable");
  assert.ok(d.options.some((o) => o.freeform), "and an operator-specified escape");
});

test("an ungrouped object carries no grouping decision — nothing to validate", () => {
  const blueprint = { shared: { fiori_apps: [{ id: "APP_MAINT", members: ["sigB"] }], services: [], projections: [] } };
  assert.deepEqual(groupingDecision("sigA", blueprint), [], "do not manufacture a question for an object that joins nothing");
  assert.deepEqual(groupingDecision("sigA", { shared: {} }), []);
  assert.deepEqual(groupingDecision("sigA", {}), [], "an absent blueprint is not a decision either");
});

// H-2 — the decision the grouping work exists to surface was the one it hid. `groupingDecision` returned on
// the FIRST group it matched, and `mergeShared`/`normalizeShared` order `services` before `fiori_apps`, so an
// object fronted by an OData service AND enrolled in a Fiori app showed only the service. On TALV every
// APP_TABLE_MAINTENANCE member is also a service member, so "these objects become ONE Fiori app" — the
// largest architectural call the run makes, and the entire point of the row — appeared on zero rows.
//
// Memberships are independent claims: being in a service says nothing about being in an app, and each is
// separately ratifiable. So every group the object belongs to is a decision, and the object carries all of
// them.
test("an object in two groups shows BOTH decisions — a service must not swallow the Fiori app", () => {
  const blueprint = { shared: {
    services: [{ id: "SRV_X", members: ["sigA", "sigB"] }],
    fiori_apps: [{ id: "APP_MAINT", members: ["sigA", "sigC"] }],
  } };
  const decisions = groupingDecision("sigA", blueprint);
  assert.deepEqual(
    decisions.map((d) => `${d.kind}:${d.id}`).sort(),
    ["fiori_apps:APP_MAINT", "services:SRV_X"],
    `every membership is separately ratifiable: ${JSON.stringify(decisions)}`,
  );
  for (const d of decisions) {
    assert.ok(d.options.some((o) => o.recommended), `${d.id} owes a recommendation`);
    assert.ok(d.options.some((o) => /standalone/i.test(o.group)), `${d.id} owes a standalone alternative`);
  }
});

test("the manifest row carries every grouping the object joins", () => {
  const ctx = mk();
  const planned = ctx.run("plan", FIXTURE, "--package", "ZFICO");
  const cons = consumptionFacts(JSON.parse(readFileSync(FIXTURE, "utf8")));
  const pers = persistenceFacts(JSON.parse(readFileSync(FIXTURE, "utf8")));
  const target = archNode(loadPlan(planned.run_id, ctx.stateDir));
  // A headless BO fronted by a shared service AND reusing a shared projection — two coherent memberships.
  // (Not a fiori_app: conformance tier 5 correctly refuses to enrol a shape with no UI in one.)
  seedCache(ctx.stateDir, target, cons, pers, {
    model: "opus", promptHash: "ph1",
    shared: { services: [{ id: "SRV_X", members: [target.id] }], projections: [{ id: "PRJ_X", members: [target.id] }] },
  });
  ctx.run("arch", planned.run_id, FIXTURE, "--model", "opus", "--prompt-hash", "ph1");

  const row = manifestOf(ctx.runsDir, planned.run_id).rows.find((r) => r.sig === target.id);
  assert.deepEqual(
    (row.groupings ?? []).map((g) => `${g.kind}:${g.id}`).sort(),
    ["projections:PRJ_X", "services:SRV_X"],
    `both memberships reach the row the human ratifies: ${JSON.stringify(row.groupings)}`,
  );
});

// H-5 (independent ARCH_REVIEW, TALV 2026-08-10). The judge prompt has always REQUIRED a rationale
// ("1-3 sentences grounded in the FACTS") and the write seam dropped it on the floor. The manifest recorded
// `judged_by` and nothing else, so the human ratifying by exception saw WHO decided and never WHY — and the
// row's own `options[].rationale` read literally "judge", which is the source, not a reason.
//
// The rationale and a confidence grade are what make ratify-by-exception possible: they are the triage
// signal that says which of two dozen rows deserves the hard look. Both are now required at the seam, for
// the same reason `--by` is: a verdict nobody will justify is not an audit trail.
test("arch-verdict REFUSES a selection with no stated reason", () => {
  const { runsDir, run } = mk();
  const planned = run("plan", FIXTURE);
  run("arch", planned.run_id, FIXTURE);
  const sig = manifestOf(runsDir, planned.run_id).pending[0].sig;
  assert.throws(
    () => run("arch-verdict", planned.run_id, FIXTURE, sig, "--shape", "rap_bo_headless", "--by", "j"),
    /rationale/i,
    "a verdict with no reason is not an audit trail",
  );
});

test("arch-verdict REFUSES a confidence outside the closed grade set", () => {
  const { runsDir, run } = mk();
  const planned = run("plan", FIXTURE);
  run("arch", planned.run_id, FIXTURE);
  const sig = manifestOf(runsDir, planned.run_id).pending[0].sig;
  assert.throws(
    () => run("arch-verdict", planned.run_id, FIXTURE, sig, "--shape", "rap_bo_headless", "--by", "j", "--rationale", "no surface", "--confidence", "pretty-sure"),
    /confidence/i,
  );
});

test("the judge's reason and confidence reach the row the human ratifies", () => {
  const { runsDir, run } = mk();
  const planned = run("plan", FIXTURE);
  run("arch", planned.run_id, FIXTURE);
  const sig = manifestOf(runsDir, planned.run_id).pending[0].sig;
  const why = "the consumption facts are batch_report only, with no interactive or remote surface";
  run("arch-verdict", planned.run_id, FIXTURE, sig, "--shape", "rap_bo_headless", "--by", "judge-agent", "--rationale", "batch_report only, no interactive or remote surface", "--confidence", "medium",
      "--rationale", why, "--confidence", "high");
  run("arch", planned.run_id, FIXTURE);

  const row = manifestOf(runsDir, planned.run_id).rows.find((r) => r.sig === sig);
  assert.equal(row.judged_by, "judge-agent");
  assert.equal(row.judged_rationale, why, "the human must see WHY, not only who");
  assert.equal(row.judged_confidence, "high");
  const rec = row.options.find((o) => o.recommended);
  assert.equal(rec.rationale, why, `the prompt option carries the reason, not the word 'judge': ${JSON.stringify(rec)}`);
});

test("a matcher-resolved row says so plainly — no rationale is invented for a decision no judge made", () => {
  const { stateDir, runsDir, run } = mk();
  const planned = run("plan", FIXTURE, "--package", "ZFICO");
  const cons = consumptionFacts(JSON.parse(readFileSync(FIXTURE, "utf8")));
  const pers = persistenceFacts(JSON.parse(readFileSync(FIXTURE, "utf8")));
  const target = archNode(loadPlan(planned.run_id, stateDir));
  seedCache(stateDir, target, cons, pers, { model: "opus", promptHash: "ph1" });
  run("arch", planned.run_id, FIXTURE, "--model", "opus", "--prompt-hash", "ph1");
  const row = manifestOf(runsDir, planned.run_id).rows.find((r) => r.sig === target.id);
  assert.equal(row.judged_rationale, null, "a cached entry with no recorded reason must not fabricate one");
  assert.equal(row.judged_confidence, null);
});

// The blueprint-membership findings (independent ARCH_REVIEW, TALV 2026-08-10): APP_TABLE_MAINTENANCE
// enrolled ZAESOP_LOG_DEMO, a logging demo with zero edges to any other member. Nothing on the row said so,
// so the human ratified "these eight objects are one app" with no way to see that one of them touches none
// of the others. The cohesion evidence now rides the decision it qualifies.
test("a grouping decision carries the structural evidence it rests on", () => {
  const ctx = mk();
  const planned = ctx.run("plan", GROUPING_FIXTURE);
  const cons = consumptionFacts(JSON.parse(readFileSync(GROUPING_FIXTURE, "utf8")));
  const pers = persistenceFacts(JSON.parse(readFileSync(GROUPING_FIXTURE, "utf8")));
  const all = loadPlan(planned.run_id, ctx.stateDir).nodes;
  const nodes = archNodes(loadPlan(planned.run_id, ctx.stateDir));
  const gl = nodes.find((n) => (n.dependencies ?? []).length > 0);   // ZFICO_BTC_CSV_GL depends on two others
  const linked = all.find((n) => (gl.dependencies ?? []).includes(n.id));

  const members = nodes.map((n) => n.id);
  const shared = { services: [{ id: "SRV_X", members }] };
  let cache = { entries: {} };
  for (const n of nodes) {
    const shape = topShape(n, cons, pers);
    const rec = { sig: n.id, target_shape: shape, components: [], invariants: [], candidates: [{ id: shape, score: 1 }], source: "judge", shared };
    cache = putEntry(cache, factHash(n, cons, pers), "opus", "ph1", rec);
  }
  writeFileSync(join(ctx.stateDir, "arch-verdict-cache.json"), JSON.stringify(cache, null, 2));
  ctx.run("arch", planned.run_id, GROUPING_FIXTURE, "--model", "opus", "--prompt-hash", "ph1");

  const rows = manifestOf(ctx.runsDir, planned.run_id).rows;
  const bySig = (sig) => rows.find((r) => r.sig === sig).groupings[0];
  const order = nodes.find((n) => n.object === "ZORD_ORDER");

  // The connected case: ZORD_ORDER calls ZORD_ITEM, so its membership rests on a real structural edge.
  const memberSigs = new Set(members);
  const expected = (n) => (n.dependencies ?? []).filter((d) => memberSigs.has(d)).length
    + nodes.filter((o) => o.id !== n.id && (o.dependencies ?? []).includes(n.id)).length;
  for (const n of nodes) {
    assert.equal(bySig(n.id).evidence.linked_members, expected(n),
      `${n.object}: the row must report the plan's own adjacency, not a guess`);
  }

  // The isolated case — the one the review caught in the wild (APP_TABLE_MAINTENANCE enrolled a logging demo
  // with zero edges to any member). The row must SAY the grouping rests on nothing structural.
  const isolated = nodes.filter((n) => expected(n) === 0);
  assert.ok(isolated.length > 0, "this fixture must contain the case the review caught in the wild");
  for (const n of isolated) {
    const d = bySig(n.id);
    assert.equal(d.evidence.isolated, true, `${n.object} shares no edge with any member`);
    assert.match(d.options.find((o) => o.recommended).rationale, /shares NO structural edge/,
      "the row must SAY the grouping rests on nothing structural — the APP_TABLE_MAINTENANCE failure");
  }
});

// Measured against 15 real arch-judge answers over the equalize-idoc + TALV corpora (2026-08-11): the
// rationale lengths were 514, 515, 537, 544, 577, 578, 604, 606, 620, 667, 682, 691, 757, 777, 806 chars.
// The first cap was 600, which would have REFUSED nine of the fifteen — every one of them conforming to the
// prompt's "1-3 sentences grounded in the FACTS". A cap that rejects the answer the prompt asks for is a
// wrong cap, and the alternative (truncating) would break the skill's "pass the judge's words through
// verbatim". The bound exists to keep a wall of text out of a gate row, not to force paraphrase.
test("a real judge rationale is accepted at its natural length", () => {
  const { runsDir, run } = mk();
  const planned = run("plan", FIXTURE);
  run("arch", planned.run_id, FIXTURE);
  const sig = manifestOf(runsDir, planned.run_id).pending[0].sig;
  const why = "The consumption surface carries both ui_dynpro and ui_salv, i.e. an interactive classic screen "
    + "plus an ALV grid, alongside a classic_api_surface - an interactive UI that must survive the "
    + "re-architecture, so the shape needs an OData service binding plus Fiori Elements metadata rather than "
    + "a headless BO. The re_architect disposition and ui_rearch hint agree with the coarse RAP Business "
    + "Object target, and the single offered candidate matches the facts, so no other justification arises. "
    + "Confidence is tempered by a thin member_summary (1 member, unknown grade, zero recorded "
    + "complexity/blast) with 5 dependencies, which leaves the true breadth of the screen logic unquantified.";
  assert.ok(why.length > 600 && why.length < 900, `this is the real observed shape: ${why.length} chars`);
  const out = run("arch-verdict", planned.run_id, FIXTURE, sig, "--shape", "rap_bo_headless", "--by", "j",
                  "--rationale", why, "--confidence", "low");
  assert.equal(out.sig, sig);
});

test("a wall of text is still refused — the bound exists, it is just not 600", () => {
  const { runsDir, run } = mk();
  const planned = run("plan", FIXTURE);
  run("arch", planned.run_id, FIXTURE);
  const sig = manifestOf(runsDir, planned.run_id).pending[0].sig;
  assert.throws(
    () => run("arch-verdict", planned.run_id, FIXTURE, sig, "--shape", "rap_bo_headless", "--by", "j",
              "--rationale", "x".repeat(4000), "--confidence", "low"),
    /rationale/i,
  );
});
