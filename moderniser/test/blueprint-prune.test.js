import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { loadPlan } from "../src/sched/plan.js";
import { consumptionFacts } from "../src/plan/consumption-facts.js";
import { persistenceFacts } from "../src/plan/persistence-facts.js";
import { factHash } from "../src/plan/arch-facts.js";
import { putEntry } from "../src/state/arch-verdict-cache.js";
import { pruneUnrenderable } from "../src/plan/app-blueprint.js";
import { loadPatternCorpus } from "../src/plan/patterns/match.js";

// F-8.4 — reader-side isolation at the app-blueprint tier.
//
// `checkBlueprint` tier 5 refuses a Fiori app that enrols a member whose shape cannot render (no
// `metadata_ext` component). That refusal is right; what was wrong is WHERE it landed. cmdArch threw the
// ENTIRE arch verb on it, before the manifest was written — so `arch-verdict` had no pending request to
// serve and the run could not be recovered by any command. Exactly the unrecoverable state V1/V1b closed
// for cached groupings, reached through a different door.
//
// The door is real and needs no contrived input: `shared` rides EACH recommendation and is unioned across
// all of them, so object B's verdict can say "A and B are one Fiori app" while object A's own verdict says
// A is headless. Both are individually valid and pass `validateShared` (members are arch-gated plan nodes)
// and `sharedFitsPlan` (members are resolved). Only the joint reading violates tier 5 — which is precisely
// what TALV's APP_TABLE_MAINTENANCE shipped (blueprint-conformance.js:65).
//
// The isolation is narrow on purpose: drop the member that cannot render, drop the group if that empties it,
// and report it. Everything else still throws — tiers 1/2/4 are structurally unreachable from cmdArch, so
// reaching one means the harness is broken and failing loudly is correct.

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "cli.js");
const GROUPING_FIXTURE = join(HERE, "fixtures", "analyser-findings-grouping.json");

const UI = "fiori_list_report"; //     what ZORD_ORDER / ZORD_ITEM resolve to (has metadata_ext)
const HEADLESS = "rap_bo_headless"; // what ZFICO_BTC_CSV_GL resolves to (no UI at all)
const APP = "APP_ORDER_MGMT";

function mk() {
  const base = mkdtempSync(join(tmpdir(), "prune-cli-"));
  const stateDir = join(base, "state");
  const runsDir = join(base, "runs");
  const run = (...a) => JSON.parse(execFileSync(process.execPath, [CLI, ...a, "--state-dir", stateDir, "--runs-dir", runsDir], { encoding: "utf8" }));
  return { base, stateDir, runsDir, run };
}

const rec = (node, shape, shared) => ({
  sig: node.id, target_shape: shape, components: [], invariants: [],
  candidates: [{ id: shape, score: 1 }], source: "judge", ...(shared ? { shared } : {}),
});

/** Seed one cached judge verdict per node — the real fulfiller flow (judge writes the cache, `arch` reads it). */
function seed(stateDir, entries, cons, pers) {
  let cache = { entries: {} };
  for (const { node, shape, shared } of entries) {
    cache = putEntry(cache, factHash(node, cons, pers), "opus", "ph1", rec(node, shape, shared));
  }
  writeFileSync(join(stateDir, "arch-verdict-cache.json"), JSON.stringify(cache, null, 2));
}

// ---- the pure pruner ----

const corpus = loadPatternCorpus();
const assignments = [{ sig: "a", target_shape: UI }, { sig: "b", target_shape: HEADLESS }, { sig: "c", target_shape: UI }];

test("pruneUnrenderable drops the member that cannot render, keeps the app for the ones that can", () => {
  const { shared, pruned } = pruneUnrenderable(
    { services: [], projections: [], fiori_apps: [{ id: APP, members: ["a", "b", "c"] }] },
    assignments, corpus,
  );
  assert.deepEqual(shared.fiori_apps, [{ id: APP, members: ["a", "c"] }], "the renderable members keep their app");
  assert.deepEqual(pruned, [{ kind: "fiori_apps", group: APP, member: "b", shape: HEADLESS }]);
});

test("a Fiori app left with no renderable member is dropped whole — an app with no screens is not an app", () => {
  const { shared, pruned } = pruneUnrenderable(
    { services: [], projections: [], fiori_apps: [{ id: APP, members: ["b"] }] },
    assignments, corpus,
  );
  assert.deepEqual(shared.fiori_apps, []);
  assert.deepEqual(pruned, [{ kind: "fiori_apps", group: APP, member: "b", shape: HEADLESS }]);
});

test("the pruner is NARROW: services and projections are untouched, so their violations still fail closed", () => {
  const input = {
    services: [{ id: "SRV", members: ["a", "b"] }],
    projections: [{ id: "PRJ", members: ["b"] }],
    fiori_apps: [],
  };
  const { shared, pruned } = pruneUnrenderable(input, assignments, corpus);
  assert.deepEqual(shared.services, input.services, "a headless BO behind an OData service is normal — nothing to prune");
  assert.deepEqual(shared.projections, input.projections);
  assert.deepEqual(pruned, []);
});

test("a member with no assignment is NOT pruned — it is a dangling ref, which tier 3 must still refuse", () => {
  const { shared, pruned } = pruneUnrenderable(
    { services: [], projections: [], fiori_apps: [{ id: APP, members: ["a", "ghost"] }] },
    assignments, corpus,
  );
  assert.deepEqual(shared.fiori_apps, [{ id: APP, members: ["a", "ghost"] }], "silently swallowing it would hide a real inconsistency");
  assert.deepEqual(pruned, []);
});

// ---- end-to-end: the verb survives, and says what it changed ----

test("E2E a judge app enrolling a headless BO no longer kills the whole arch verb", () => {
  const ctx = mk();
  const planned = ctx.run("plan", GROUPING_FIXTURE);
  const doc = JSON.parse(readFileSync(GROUPING_FIXTURE, "utf8"));
  const [cons, pers] = [consumptionFacts(doc), persistenceFacts(doc)];
  const plan = loadPlan(planned.run_id, ctx.stateDir);
  const nodeOf = (object) => plan.nodes.find((n) => n.object === object);
  const [order, item, gl] = [nodeOf("ZORD_ORDER"), nodeOf("ZORD_ITEM"), nodeOf("ZFICO_BTC_CSV_GL")];

  // The judge groups all three into one Fiori app, in the same verdict that calls ZFICO_BTC_CSV_GL headless.
  //
  // The grouping rides GL's entry deliberately. `factStream` is sig-free (P8), so ZORD_ORDER and ZORD_ITEM —
  // structurally identical objects — share ONE fact hash and therefore ONE cache entry; seeding a grouping
  // onto the first of them is silently overwritten by the second, and the test passes while exercising
  // nothing. That vacuum is not hypothetical: it is how the first run of this probe "refuted" the defect.
  seed(ctx.stateDir, [
    { node: order, shape: UI },
    { node: item, shape: UI },
    { node: gl, shape: HEADLESS, shared: { services: [], projections: [], fiori_apps: [{ id: APP, members: [order.id, item.id, gl.id] }] } },
  ], cons, pers);
  const seeded = JSON.parse(readFileSync(join(ctx.stateDir, "arch-verdict-cache.json"), "utf8"));
  assert.ok(JSON.stringify(seeded).includes(APP), "the grouping must survive seeding, or this test proves nothing");

  const out = ctx.run("arch", planned.run_id, GROUPING_FIXTURE, "--model", "opus", "--prompt-hash", "ph1");
  assert.equal(out.resolved, 3, "every node still freezes a contract — one bad grouping must not cost the others");

  const manifestPath = join(ctx.runsDir, planned.run_id, "architecture-manifest.json");
  assert.ok(existsSync(manifestPath), "the manifest must exist — without it `arch-verdict` has nothing to serve and the run is unrecoverable");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  assert.deepEqual(
    manifest.pruned_groupings,
    [{ kind: "fiori_apps", group: APP, member: gl.id, shape: HEADLESS }],
    "the discarded architecture decision must be named, not silently dropped",
  );
  assert.deepEqual(manifest.shared.fiori_apps, [{ id: APP, members: [item.id, order.id].sort() }], "the app survives for the members that can render it");

  // What the human ratifies is the CORRECTED grouping — the row's groupings come from the pruned blueprint.
  const glRow = manifest.rows.find((r) => r.sig === gl.id);
  assert.ok(glRow, "the headless node still gets its own contract row");
  assert.equal(JSON.stringify(glRow.groupings ?? {}).includes(APP), false, "it must not be offered membership of an app it cannot be in");
});
