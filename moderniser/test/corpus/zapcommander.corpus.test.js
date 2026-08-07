import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { filesFromBundle } from "../../../analyser/src/modes.js";
import { analyzePackage } from "../../../analyser/src/orchestrator.js";
import { assembleBundle, invariantInput } from "../../src/extract/bundle.js";
import { diffBundles } from "../../src/extract/bundle-diff.js";
import { invariantDiff } from "../../src/node/invariants.js";
import { renderOfflineNodeVerdict } from "../../src/node/offline-checkpoint.js";
import { driveOfflineVerdict } from "../../src/sched/drive.js";
import { initRun, dispatch, applyProgress } from "../../src/sched/loop.js";

/**
 * zapcommander OFFLINE E2E ACCEPTANCE — the SCALE / HONEST-SEALING case, against the REAL corpus.
 *
 * This is NOT abap_fico. abap_fico is a FICO business app: it modernises to full managed RAP BOs, so
 * its acceptance asserts an authorization RELOCATION and an imperative→declarative PARADIGM SHIFT.
 * zapcommander is a classic SAP-GUI / OS / RFC dual-pane FILE MANAGER: almost all of it is boundary
 * code (dynpro screens, shell exec, server/frontend file I/O, RFC-to-DESTINATION). It modernises to
 * ABAP Cloud CLASSES, not RAP BOs — there is no CDS/BDEF/DCL, no save boundary, no paradigm shift, and
 * (the classic source has no AUTHORITY-CHECK) no auth footprint to relocate.
 *
 * So this suite asserts the OPPOSITE shape to abap_fico on purpose: it pins that the harness reports
 * that honest reality — it does NOT fabricate a RAP story, an auth relocation, or a paradigm shift it
 * cannot support — while STILL blocking on the real ATC + parity residuals, self-correcting, sealing
 * the un-portable operations behind named NEEDS_MANUAL_SEAM methods, and running deterministically.
 *
 * Like the abap_fico suite it is NOT part of `npm test` (its GPLv3 input is not vendored — see
 * demos/FETCH.md) and it FAILS LOUDLY when the corpus is absent; it is never skipped, never faked.
 *
 *   ZAPCOMMANDER_CORPUS=~/zapcommander-corpus-local npm run test:corpus
 */

// Defaults to the acceptance demo's own bundle, where the fetched corpus already lives (git-ignored).
// See the note in abap-fico.corpus.test.js: requiring an env var to reach a corpus already on disk made the
// suite look unrunnable, so it never ran. The env var still wins, for a corpus fetched elsewhere.
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CORPUS = join(HERE, "..", "..", "..", "demos", "zapcommander-acceptance-2026-07-28");
const CORPUS = process.env.ZAPCOMMANDER_CORPUS || DEFAULT_CORPUS;

function corpusOrFail() {
  for (const p of ["before/source", "after/modernised-source"]) {
    if (!existsSync(join(CORPUS, p))) {
      throw new Error(
        `zapcommander corpus not found: ${join(CORPUS, p)} is missing. The corpus is NOT vendored in this ` +
          "repository (third-party, GPLv3 copyleft). Fetch it per demos/FETCH.md into " +
          "demos/zapcommander-acceptance-2026-07-28/, or set ZAPCOMMANDER_CORPUS=<path> to a bundle with " +
          "before/source/ and after/modernised-source/.",
      );
    }
  }
  return CORPUS;
}

/** The after-side ATC evidence: read the shipped findings doc if present, else REGENERATE by running
 *  the analyser over the fetched modernised source — reproducible from nothing but the clone. */
function afterFindings(root, afterFiles) {
  const shipped = join(root, "after", "analyser-findings.json");
  if (existsSync(shipped)) return JSON.parse(readFileSync(shipped, "utf8"));
  return analyzePackage(afterFiles, { package: "zapcommander", source_system: "corpus:zapcommander" });
}

/** Count distinct NEEDS_MANUAL_SEAM_* method names across the modernised source. */
function distinctSeams(afterFiles) {
  const seams = new Set();
  for (const f of afterFiles) {
    for (const m of String(f.source ?? "").match(/needs_manual_seam_[a-z0-9_]+/gi) || []) {
      seams.add(m.toLowerCase());
    }
  }
  return seams;
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

test("the real corpus loads and both engines run over it (the scale fixture)", () => {
  assert.ok(beforeFiles.length > 40, `before corpus too small: ${beforeFiles.length}`);
  assert.ok(afterFiles.length > 40, `after corpus too small: ${afterFiles.length}`);
  assert.equal(typeof before.source_hash, "string");
  assert.equal(typeof after.source_hash, "string");
});

test("HONEST class-shape: no fabricated RAP — zero BDEF auth, zero save boundary, no paradigm shift", () => {
  // The load-bearing assertion. zapcommander → ABAP Cloud CLASSES (no CDS/BDEF/DCL). A generator that
  // hallucinated a RAP rewrite would show auth_bdef>0 / commit_work>0 / paradigm_shift=true here.
  assert.equal(after.auth_bdef.length, 0, "no BDEF authorization clause should exist — this is not a RAP modernisation");
  assert.equal(after.commit_work, 0, "no RAP/COMMIT save boundary should be invented for a class-only port");
  const d = diffBundles(before, after, { touched_files: inputs.touched_files });
  assert.equal(d.paradigm_shift, false, "class→class is not an imperative→declarative RAP rewrite");
  assert.equal(d.reassembly_broken, false, "every changed file is inside the declared touched set");
});

test("no fabricated authorization story — the arc claims no auth relocation the corpus can't support", () => {
  // The classic file manager carries no AUTHORITY-CHECK, so there is nothing to relocate. The arc must
  // NOT invent an auth delta (that would be the abap_fico shape wrongly applied here).
  const d = invariantDiff(invariantInput(before), invariantInput(after));
  assert.equal(d.auth_delta, false, "no authorization footprint changed — none existed to move");
  assert.ok(!d.violations.includes("P4b:commit-suppressed"), "a class-only port has no RAP save to suppress");
});

test("ACCEPTANCE: the offline verdict still BLOCKS on the real residuals (P6 — offline never GREENs)", () => {
  const out = renderOfflineNodeVerdict({ canonical_sig: "zapcommander" }, inputs);
  assert.equal(out.provisional, false, "residuals must block, not rest provisionally");
  assert.ok(
    out.reasons.includes("atc-p1-nonzero") || out.reasons.includes("atc-p2-nonzero"),
    `expected at least one ATC-priority residual reason; got: ${out.reasons}`,
  );
  assert.ok(out.reasons.includes("parity-not-equivalent:needs_review"), `reasons: ${out.reasons}`);
  // And it must NOT block on an auth story it can't support:
  assert.ok(!out.reasons.includes("auth-coverage-lost"), `must not claim auth loss; got: ${out.reasons}`);
});

test("ACCEPTANCE: the driver SELF-CORRECTS — a blocking verdict regenerates, cycle-gated", () => {
  const PLAN = { plan_hash: "zap", nodes: [{ id: "N1", object: "ZAPCMD", wave: 0, dependencies: [] }] };
  let s = initRun(PLAN);
  s = dispatch(PLAN, s, ["N1"]);
  s = applyProgress(PLAN, s, "N1", "GENERATED");
  s = applyProgress(PLAN, s, "N1", "SYNTAX_OK");
  const result = renderOfflineNodeVerdict({ canonical_sig: "N1" }, inputs);
  const { state, action } = driveOfflineVerdict(PLAN, s, "N1", result);
  assert.equal(action.action, "generate", "a residual is regenerable — it must not stall on a human offline");
  assert.equal(action.packets[0].retry, true);
  assert.equal(state.cycle.N1, 1, "the retry is cycle-gated, so self-correction is bounded");
});

test("HONEST SEALING at scale: the un-portable operations are isolated behind named seams, not faked", () => {
  // A GUI/OS/RFC/dynpro file manager has no ABAP Cloud form for most of its surface. The proof that the
  // generator sealed rather than fabricated: a large set of distinct NEEDS_MANUAL_SEAM_* methods, and
  // every one of them documented (a bare stub with no comment would be a silent fake).
  const seams = distinctSeams(afterFiles);
  assert.ok(seams.size >= 20, `expected many honest seams in a GUI/OS file manager; got ${seams.size}`);
  // A seam is honest only if its body EXPLAINS what it stubs and why — a bare empty stub would be a
  // silent fake. The convention varies across batches ("NEEDS_MANUAL_SEAM: …" vs "-- STUB: … Cloud-
  // forbidden …"), so assert the substance: every seam IMPLEMENTATION body carries an ABAP comment.
  // PRODUCTION source only: a .testclasses.abap REDEFINES the seams as test doubles (real subclasses
  // injecting canned data — the tdd.md fixture pattern, not mocks); those overrides need no rationale.
  const undocumented = [];
  for (const f of afterFiles.filter((x) => !/\.testclasses\.abap$/i.test(x.filename))) {
    const lines = String(f.source ?? "").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*METHOD\s+needs_manual_seam_/i.test(lines[i])) continue;
      let hasComment = false;
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j].trim();
        if (/^ENDMETHOD\./i.test(t)) break;
        if (t.startsWith('"') || t.startsWith("*")) { hasComment = true; break; }
      }
      if (!hasComment) undocumented.push(`${f.filename}:${i + 1}`);
    }
  }
  assert.deepEqual(undocumented, [], `every seam body must carry an explanatory comment; bare stubs at: ${undocumented}`);
});

test("the run is deterministic — a second pass over the same corpus is byte-identical", () => {
  const a = renderOfflineNodeVerdict({ canonical_sig: "zapcommander" }, inputs);
  const b = renderOfflineNodeVerdict({ canonical_sig: "zapcommander" }, inputs);
  assert.deepEqual(a, b);
  assert.equal(assembleBundle(filesFromBundle(join(root, "after", "modernised-source"))).source_hash, after.source_hash);
});

test("clean ports carry NO seam — the pure interfaces/exception/model classes modernised fully", () => {
  // The other half of honesty: where a Cloud form DOES exist, the generator ported it completely.
  const names = new Set(readdirSync(join(root, "after", "modernised-source")));
  assert.ok(names.size > 0, "modernised source should contain files");
  const seamFree = afterFiles.filter((f) => !/needs_manual_seam_/i.test(String(f.source ?? "")));
  assert.ok(seamFree.length > 0, "at least some objects (interfaces, exception, list model) port with zero seams");
});
