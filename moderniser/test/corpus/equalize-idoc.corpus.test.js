import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { filesFromBundle } from "../../../analyser/src/modes.js";
import { analyzePackage } from "../../../analyser/src/orchestrator.js";
import { assemblePlan } from "../../src/sched/assemble.js";

/**
 * equalize-idoc GENERALISATION ACCEPTANCE — the CROSS-SYSTEM INTEGRATION archetype, on REAL code.
 *
 * B2-generalisation step 3 (operator directive 2026-07-29): prove the disposition classifier generalises
 * beyond the two example fixtures. This corpus is a UI-less IDoc/ALE/tRFC integration framework
 * (engswee/equalize-idoc-framework, MIT) — an archetype abap_fico (batch→RAP BO) and zapcommander (GUI/OS/RFC
 * file manager→classes) do NOT exercise. It runs the WHOLE offline path on genuine third-party ABAP:
 *   filesFromBundle → analyzePackage (the analyser) → assemblePlan (the moderniser classifier).
 *
 * It asserts the load-bearing GENERALISATION GUARANTEE holds on real code — every object gets a true-
 * modernisation disposition (no degradation to seal), no premature rebuild (§935), integration re-architects —
 * and that the rfc_rebuild routing built in commit 32ba222 actually fires and routes correctly on real findings.
 *
 * Like the other corpus suites it is NOT part of `npm test` (its MIT source is fetched locally + git-ignored —
 * see demos/equalize-idoc-2026-07-29/FETCH.md) and FAILS LOUDLY when the source is absent; never skipped.
 *
 *   npm run test:corpus            # reads the ingested demos source by default
 *   EQUALIZE_IDOC_CORPUS=<dir> npm run test:corpus
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = process.env.EQUALIZE_IDOC_CORPUS || join(HERE, "..", "..", "..", "demos", "equalize-idoc-2026-07-29", "before", "source");

function corpusOrFail() {
  if (!existsSync(CORPUS)) {
    throw new Error(
      `equalize-idoc corpus not found at ${CORPUS}. The MIT source is fetched locally and git-ignored — ` +
        `fetch it per demos/equalize-idoc-2026-07-29/FETCH.md (into before/source/), or set EQUALIZE_IDOC_CORPUS=<dir>.`,
    );
  }
  return CORPUS;
}

const files = filesFromBundle(corpusOrFail());
const doc = analyzePackage(files, { package: "equalize_idoc", source_system: "corpus:equalize-idoc" });
const { plan } = assemblePlan(doc);
const tally = plan.nodes.reduce((a, n) => ((a[n.disposition] = (a[n.disposition] ?? 0) + 1), a), {});
const hintNodes = (h) => plan.nodes.filter((n) => (n.disposition_hints ?? []).includes(h));
const DISPOSITIONS = ["refactor", "re_architect", "rebuild", "replace", "retire", "seal"];

test("the real corpus loads and assembles a disposition plan (scale + shape)", () => {
  assert.ok(files.length > 20, `too few source files: ${files.length}`);
  assert.ok(plan.nodes.length > 10, `too few plan nodes: ${plan.nodes.length}`);
  for (const n of plan.nodes) assert.ok(DISPOSITIONS.includes(n.disposition), `${n.object}: valid disposition`);
});

test("GENERALISATION GUARANTEE: no object degrades to seal, and B2 emits no rebuild (§935)", () => {
  assert.equal(tally.seal ?? 0, 0, `every object must get a true-modernisation disposition — none seals; tally=${JSON.stringify(tally)}`);
  assert.equal(tally.rebuild ?? 0, 0, `rebuild is a B3.5 app-level promotion, never a per-object B2 output; tally=${JSON.stringify(tally)}`);
});

test("an integration framework RE-ARCHITECTS: re_architect is the dominant disposition", () => {
  assert.ok((tally.re_architect ?? 0) >= (tally.refactor ?? 0), `expected re_architect-dominant; tally=${JSON.stringify(tally)}`);
});

test("ROUTING PROOF (real code): the rfc_rebuild hint fires and every such node → re_architect", () => {
  const rfc = hintNodes("rfc_rebuild");
  assert.ok(rfc.length >= 1, "at least one object's real finding message must derive the cross-system rfc_rebuild hint");
  for (const n of rfc) assert.equal(n.disposition, "re_architect", `${n.object}: rfc_rebuild → re_architect (not rebuild, not seal)`);
});

test("retain-kinds (interfaces + CX_ exception classes) → refactor", () => {
  const retain = plan.nodes.filter((n) => n.object_kind === "interface" || (n.object_kind === "class" && /(^|\/)[YZ]?CX_/i.test(n.object)));
  for (const n of retain) assert.equal(n.disposition, "refactor", `${n.object} (retain-kind) → refactor`);
});

// HONEST FINDING (documented, not a failure): the archetype-specific rfc_rebuild hint UNDER-FIRES on real code
// — the analyser's rule MESSAGES rarely describe the IDoc/RFC/ALE construct (most findings are `style`), so the
// re_architect verdict is predominantly TARGET-driven (the empty-signal-FM fallback). This is an analyser-
// coverage gap ([[analyser-rap-awareness-backlog]]), NOT a classifier defect; the target fallback is exactly
// why generalisation still holds when the hint is sparse. This test PINS that robustness.
test("target-fallback carries generalisation when hints are sparse (analyser-coverage reality)", () => {
  const targetDriven = plan.nodes.filter((n) => n.disposition === "re_architect" && (n.disposition_hints ?? []).every((h) => h === "style"));
  assert.ok(targetDriven.length >= 1, "some re_architect verdicts come via the analyser TARGET, not a hint — the fallback that keeps generalisation robust to analyser under-description");
});
