import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { filesFromBundle } from "../../../analyser/src/modes.js";
import { analyzePackage } from "../../../analyser/src/orchestrator.js";
import { assembleBundle, invariantInput } from "../../src/extract/bundle.js";
import { diffBundles } from "../../src/extract/bundle-diff.js";
import { extractBdefDcl } from "../../src/extract/bdef-dcl.js";
import { invariantDiff } from "../../src/node/invariants.js";
import { renderOfflineNodeVerdict } from "../../src/node/offline-checkpoint.js";
import { driveOfflineVerdict } from "../../src/sched/drive.js";
import { initRun, dispatch, applyProgress } from "../../src/sched/loop.js";

/**
 * gap-2b B7 — the abap_fico OFFLINE E2E ACCEPTANCE, against the REAL corpus.
 *
 * This suite is NOT part of `npm test`, for the same reason `test:live` is not: its input cannot
 * be shipped. The corpus is third-party (`PON-HANNES/abap_fico`) and carries NO licence, so this
 * repository does not redistribute it. You fetch it yourself — see `demos/FETCH.md`.
 *
 * It FAILS LOUDLY when the corpus is absent. It is never skipped and never faked: a suite that
 * quietly skips is indistinguishable from one that passes, which is worse than having no suite at
 * all. The assertions below are the same ones that ran when the corpus was vendored — the block,
 * the four reasons, the self-correction, the determinism. Nothing was weakened to make the corpus
 * removable; it simply moved to where its real input lives.
 *
 *   ABAP_FICO_CORPUS=~/abap_fico-corpus-local npm run test:corpus
 */

const CORPUS = process.env.ABAP_FICO_CORPUS;

function corpusOrFail() {
  if (!CORPUS) {
    throw new Error(
      "test:corpus requires ABAP_FICO_CORPUS — the real abap_fico corpus is NOT vendored in this " +
        "repository (third-party, unlicensed). See demos/FETCH.md to fetch it, then re-run:\n" +
        "  ABAP_FICO_CORPUS=<path> npm run test:corpus",
    );
  }
  for (const p of ["before/source", "after/modernised-source"]) {
    if (!existsSync(join(CORPUS, p))) {
      throw new Error(`ABAP_FICO_CORPUS=${CORPUS} is missing ${p}/ — see demos/FETCH.md for the expected layout`);
    }
  }
  return CORPUS;
}

/** The after-side ATC evidence: read the findings doc if the corpus carries one, else REGENERATE it
 *  by running the analyser over the fetched source. Regeneration is what keeps this reproducible
 *  from nothing but an upstream clone. */
function afterFindings(root, afterFiles) {
  const shipped = join(root, "after", "analyser-findings.json");
  if (existsSync(shipped)) return JSON.parse(readFileSync(shipped, "utf8"));
  return analyzePackage(afterFiles, { package: "abap_fico", source_system: "corpus:abap_fico" });
}

const root = corpusOrFail();
const beforeFiles = filesFromBundle(join(root, "before", "source"));
const afterFiles = filesFromBundle(join(root, "after", "modernised-source"));
const before = assembleBundle(beforeFiles);
const after = assembleBundle(afterFiles);
const findings = afterFindings(root, afterFiles);
const inputs = {
  before,
  after,
  beforeFiles,
  afterFiles,
  findings,
  baselines: { atcBaseline: {}, covBaseline: {} },
  touched_files: afterFiles.map((f) => f.filename),
};

test("the real corpus loads and BOTH engines extract from it", () => {
  assert.ok(beforeFiles.length > 20, `before corpus too small: ${beforeFiles.length}`);
  assert.ok(afterFiles.length > 30, `after corpus too small: ${afterFiles.length}`);
  assert.ok(after.auth_bdef.length > 0, "no BDEF authorization clause extracted from the modernised RAP");
  assert.ok(after.commit_work > 0, "no save boundary found — the RAP framework saves count (F9)");
});

test("B7 ACCEPTANCE: the offline verdict BLOCKS on the modernised artifacts' residuals", () => {
  const out = renderOfflineNodeVerdict({ canonical_sig: "abap_fico" }, inputs);
  assert.equal(out.provisional, false, "the residuals must block, not rest provisionally");
  // At least one ATC-priority residual must block — NOT hardcoded to atc-p1. A gap-2a-ENFORCED
  // generation legitimately leaves ZERO priority-1 (the four RAP/N+1 structural rules are gated at
  // SELF_CHECK), so the drafts block on priority-2 residuals instead. Pinning atc-p1 made a CLEANER
  // generation FAIL the acceptance — backwards; what matters is the judge blocking on ATC residuals.
  assert.ok(
    out.reasons.includes("atc-p1-nonzero") || out.reasons.includes("atc-p2-nonzero"),
    `expected at least one ATC-priority residual reason; got: ${out.reasons}`,
  );
  assert.ok(out.reasons.includes("auth-delta-unattested"), `reasons: ${out.reasons}`);
  assert.ok(out.reasons.includes("parity-not-equivalent:needs_review"), `reasons: ${out.reasons}`);
});

test("B7 ACCEPTANCE: the driver SELF-CORRECTS — a defect regenerates with the findings", () => {
  const PLAN = { plan_hash: "fico", nodes: [{ id: "N1", object: "ZFICO", wave: 0, dependencies: [] }] };
  let s = initRun(PLAN);
  s = dispatch(PLAN, s, ["N1"]);
  s = applyProgress(PLAN, s, "N1", "GENERATED");
  s = applyProgress(PLAN, s, "N1", "SYNTAX_OK");

  const result = renderOfflineNodeVerdict({ canonical_sig: "N1" }, inputs);
  const { state, action } = driveOfflineVerdict(PLAN, s, "N1", result);
  assert.equal(action.action, "generate", "an ATC defect is regenerable — it must not stall on a human");
  assert.equal(action.packets[0].retry, true);
  assert.ok(
    action.packets[0].findings.some((r) => r === "atc-p1-nonzero" || r === "atc-p2-nonzero"),
    `the ATC residual findings are threaded into the regeneration; got: ${action.packets[0].findings}`,
  );
  assert.equal(state.cycle.N1, 1, "the retry is cycle-gated, so self-correction is bounded");
});

test("B7: the diff is real — the paradigm shift and the auth relocation are both detected", () => {
  const d = diffBundles(before, after, { touched_files: inputs.touched_files });
  assert.equal(d.paradigm_shift, true, "classic ABAP → RAP is an imperative→declarative rewrite");
  assert.equal(d.auth_vanished, false, "auth moved into RAP/DCL artifacts — it did not vanish");
  assert.equal(d.reassembly_broken, false, "every changed file is inside the declared touched set");
});

test("B7: the run is deterministic — a second pass over the same corpus is byte-identical", () => {
  const a = renderOfflineNodeVerdict({ canonical_sig: "abap_fico" }, inputs);
  const b = renderOfflineNodeVerdict({ canonical_sig: "abap_fico" }, inputs);
  assert.deepEqual(a, b);
  assert.equal(assembleBundle(filesFromBundle(join(root, "after", "modernised-source"))).source_hash, after.source_hash);
});

// Moved here from extract-bdef-dcl-auth.test.js: it asserted against an actual corpus file, which
// is exactly the kind of evidence that cannot live in the shipped suite. The synthetic half of
// that test (all three naming shapes per artifact type) stays in `npm test`.
test("engine 2 routing survives the corpus's real bare-`.asbdef` names", () => {
  const bare = filesFromBundle(join(root, "after", "modernised-source")).filter((f) => /\.asbdef$/i.test(f.filename) && !/\.bdef\.asbdef$/i.test(f.filename));
  assert.ok(bare.length > 0, "the corpus should contain at least one bare-named .asbdef");
  const out = extractBdefDcl(bare);
  assert.ok(out.save_boundaries > 0, "bare-named BDEFs returned ZERO features before the routing fix");
});

test("the real corpus's authorization footprint reaches the judge", () => {
  const d = invariantDiff(invariantInput(before), invariantInput(after));
  assert.equal(d.auth_delta, true, "classic → RAP moved the authorization footprint");
  assert.ok(!d.violations.includes("P4b:commit-suppressed"), "the RAP framework save counts (F9)");
});
