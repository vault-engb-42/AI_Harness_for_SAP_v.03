import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { filesFromBundle } from "../../analyser/src/modes.js";
import { assembleBundle } from "../src/extract/bundle.js";
import { diffBundles } from "../src/extract/bundle-diff.js";
import { renderOfflineNodeVerdict } from "../src/node/offline-checkpoint.js";
import { driveOfflineVerdict } from "../src/sched/drive.js";
import { initRun, dispatch, applyProgress } from "../src/sched/loop.js";

// gap-2b B7 — the abap_fico OFFLINE E2E ACCEPTANCE. The build contract's closing requirement:
// "re-run the abap_fico offline E2E to confirm the RAP/parity residuals now block-and-self-correct."
//
// Real corpus on disk, real loader, real analyser findings, real judges — no mocks, no synthetic
// fixtures. Before gap-2b nothing produced an offline checkpoint at all, so this arc could not
// render a verdict on real data; the point of this test is that it now does, and that it BLOCKS
// rather than resting provisionally on artifacts that still carry residuals.

const HERE = dirname(fileURLToPath(import.meta.url));
const DEMO = join(HERE, "..", "..", "demos", "abap_fico-e2e-2026-07-14");
const BEFORE_DIR = join(DEMO, "before", "source");
const AFTER_DIR = join(DEMO, "after", "modernised-source");
const FINDINGS = JSON.parse(readFileSync(join(DEMO, "after", "analyser-findings.json"), "utf8"));

const beforeFiles = filesFromBundle(BEFORE_DIR);
const afterFiles = filesFromBundle(AFTER_DIR);
const before = assembleBundle(beforeFiles);
const after = assembleBundle(afterFiles);

const inputs = {
  before,
  after,
  beforeFiles,
  afterFiles,
  findings: FINDINGS,
  baselines: { atcBaseline: {}, covBaseline: {} },
  touched_files: afterFiles.map((f) => f.filename),
};

test("the corpus loads and both engines extract from it", () => {
  assert.ok(beforeFiles.length > 20, `before corpus too small: ${beforeFiles.length}`);
  assert.ok(afterFiles.length > 30, `after corpus too small: ${afterFiles.length}`);
  // Engine 2 must see the RAP artifacts. The corpus uses BOTH naming conventions
  // (`x.bdef.asbdef` and bare `X.asbdef`) — requiring the infix silently returned zero here.
  assert.ok(after.auth_bdef.length > 0, "no BDEF authorization clause extracted from the modernised RAP");
  assert.ok(after.commit_work > 0, "no save boundary found — the RAP framework saves count (F9)");
});

test("B7 ACCEPTANCE: the offline verdict BLOCKS on the modernised artifacts' residuals", () => {
  const out = renderOfflineNodeVerdict({ canonical_sig: "abap_fico" }, inputs);
  assert.equal(out.provisional, false, "the residuals must block, not rest provisionally");
  // The gap-2a gate's own residuals reach the verdict as asserted ATC counts (C3: P1 AND P2 block).
  assert.ok(out.reasons.includes("atc-p1-nonzero"), `reasons: ${out.reasons}`);
  assert.ok(out.reasons.includes("atc-p2-nonzero"), `reasons: ${out.reasons}`);
  // The authorization footprint changed (classic → RAP), so an attestation is owed (L7/D1).
  assert.ok(out.reasons.includes("auth-delta-unattested"), `reasons: ${out.reasons}`);
  // And the imperative→declarative rewrite cannot be scored structurally (F10).
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
  assert.ok(action.packets[0].findings.includes("atc-p1-nonzero"), "the findings are threaded into the regeneration");
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
  assert.equal(assembleBundle(filesFromBundle(AFTER_DIR)).source_hash, after.source_hash);
});
