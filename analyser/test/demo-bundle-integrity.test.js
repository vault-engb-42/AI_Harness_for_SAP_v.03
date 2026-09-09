import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { compareReports } from "../src/compare.js";

// The demo bundles ship DERIVED artifacts beside the inputs they are derived from, and until now nothing
// recomputed any of them. `comparison.json` is a pure function of the two `analyser-findings.json` docs
// committed alongside it (compare.js `compareReports`) — so when commit 5ef68e7 regenerated the findings and
// not the comparison, the bundle started contradicting itself in its own headline number, and stayed that
// way through every subsequent green test run.
//
// That is this repo's signature defect class: a fact nothing recomputes becomes an unchallengeable claim.
// `moderniser/test/target-patterns-vocabulary.test.js` closes it for the patterns corpus; this closes it for
// the demo material, which is worse-placed because it is what a reader is shown FIRST.
//
// Scope, stated so nobody over-reads a green: this proves ONE derived artifact of several. `offline-verdict.json`
// and `proof/*` are still hand-assembled with no code writer, so a pass here does NOT mean "the demo bundles
// are verified". It means the before→after comparison agrees with the evidence beside it.
//
// It runs on a CLEAN CHECKOUT: every file it reads is tracked. The bundles' ABAP source is deliberately not
// (`.gitignore:31-32`, demos/FETCH.md), and this test never needs it.

const HERE = dirname(fileURLToPath(import.meta.url));
const DEMOS = join(HERE, "..", "..", "demos");

/** Bundles shipping all three files — the ones whose comparison CAN be recomputed from committed evidence. */
function comparableBundles() {
  const out = [];
  for (const name of readdirSync(DEMOS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
    const paths = {
      before: join(DEMOS, name, "before", "analyser-findings.json"),
      after: join(DEMOS, name, "after", "analyser-findings.json"),
      comparison: join(DEMOS, name, "comparison.json"),
    };
    if (Object.values(paths).every((p) => existsSync(p))) out.push({ name, paths });
  }
  return out;
}

const read = (p) => JSON.parse(readFileSync(p, "utf8"));

// A count, not just a loop. A guard that silently iterates zero bundles reports success while proving
// nothing — the same "signals nothing, matches nothing" failure it exists to catch. If a bundle is
// restructured so its files move, this fails loudly instead of quietly passing.
test("at least two demo bundles are comparison-complete, so the guard below cannot pass vacuously", () => {
  const found = comparableBundles().map((b) => b.name);
  assert.ok(found.length >= 2, `expected >= 2 bundles with before+after findings and a comparison.json, found ${found.length}: ${found}`);
});

test("every shipped comparison.json is what its OWN committed findings docs recompute to", () => {
  for (const { name, paths } of comparableBundles()) {
    const recomputed = compareReports(read(paths.before), read(paths.after));
    assert.deepEqual(
      read(paths.comparison),
      recomputed,
      `demos/${name}/comparison.json disagrees with the findings committed beside it — regenerate it with `
      + `\`node analyser/cli.js compare demos/${name}/before/analyser-findings.json demos/${name}/after/analyser-findings.json\` `
      + `(and re-check the numbers quoted in that bundle's README and HTML, which are NOT covered by this test)`,
    );
  }
});

// The headline the bundle README and the root README quote. Pinned separately from the deepEqual above so a
// failure names the number a reader would actually see, rather than burying it in a whole-object diff.
test("the 'Total findings' headline equals the length of the after-findings array it summarises", () => {
  for (const { name, paths } of comparableBundles()) {
    const after = read(paths.after);
    const row = (read(paths.comparison).quality ?? []).find((q) => q.label === "Total findings");
    assert.ok(row, `demos/${name}/comparison.json has no 'Total findings' row`);
    assert.equal(row.after, (after.findings ?? []).length, `demos/${name}: shipped headline vs actual after-findings count`);
  }
});

// ---- the proof set: cross-artifact agreement, which needs no corpus source ----
//
// `offline-verdict.json` and `proof/*` are hand-assembled — no code writer produces them — so unlike
// comparison.json there is nothing to RECOMPUTE them against on a clean checkout. That was left as a stated
// scope limit and it is closed here as far as it honestly can be: several of these artifacts quote the SAME
// figure, and two committed artifacts disagreeing is drift regardless of which one is right.
//
// What is deliberately NOT asserted, and why: the proof set's `atc_p2` does NOT agree with the priority-2
// count in the after-findings doc beside it (659 vs 643, the same 16 that produced the comparison.json
// drift). That is real, and it is NOT a fixable-by-editing defect. `git log` shows proof/checkpoint.json
// last written 2026-07-28 by the original demo run, and after/analyser-findings.json regenerated 2026-08-11
// by 5ef68e7 — so the proof set faithfully records a run made under the THEN-current analyser, and the
// findings were later re-derived under a changed one. Hand-editing 659 to 643 would manufacture a number
// for a run that never produced it, which is the exact failure this whole file exists to catch. Making them
// agree requires re-running the pipeline — a real run, not a regeneration — so it is documented in the
// bundle README instead of papered over here.

const proofBundles = () => comparableBundles().filter(({ name }) => existsSync(join(DEMOS, name, "proof")));

test("a bundle shipping a proof set is checked — the guard below cannot pass vacuously", () => {
  assert.ok(proofBundles().length >= 1, `expected >= 1 bundle with a proof/ directory, found ${proofBundles().length}`);
});

test("the proof set agrees with ITSELF: two artifacts quoting one figure must not disagree", () => {
  for (const { name } of proofBundles()) {
    const p = (f) => join(DEMOS, name, "proof", f);
    if (existsSync(p("checkpoint.json")) && existsSync(p("evidence.json"))) {
      const [cp, ev] = [read(p("checkpoint.json")), read(p("evidence.json"))];
      for (const key of ["atc_p1", "atc_p2"]) {
        assert.equal(cp[key], ev[key], `demos/${name}: checkpoint.json and evidence.json disagree on ${key} — one is stale`);
      }
    }
    if (existsSync(p("selfcheck-gates.json")) && existsSync(p("frozen-plan.json"))) {
      assert.equal(
        read(p("selfcheck-gates.json")).plan_hash, read(p("frozen-plan.json")).plan_hash,
        `demos/${name}: the gate record and the frozen plan name different plan hashes — the proof describes a different run than the plan it ships`,
      );
    }
  }
});

test("a shipped offline verdict declares the fields a reader is being asked to trust", () => {
  for (const { name } of proofBundles()) {
    const vPath = join(DEMOS, name, "offline-verdict.json");
    if (!existsSync(vPath)) continue;
    const v = read(vPath);
    for (const field of ["demo", "mode", "corpus", "before", "after", "verdict", "honesty"]) {
      assert.ok(v[field] !== undefined, `demos/${name}/offline-verdict.json is missing '${field}'`);
    }
    // `honesty` is the field that says what the run did NOT prove. A proof bundle that drops it is a proof
    // bundle claiming more than it earned — offline never reaches GREEN (P6), and the artifact must say so.
    assert.ok(String(v.honesty).length > 0, `demos/${name}: the offline verdict must state its own limits, not just its result`);
  }
});
