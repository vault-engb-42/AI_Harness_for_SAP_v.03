import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { filesFromBundle } from "../../../analyser/src/modes.js";
import { analyzePackage } from "../../../analyser/src/orchestrator.js";
import { assemblePlan } from "../../src/sched/assemble.js";

/**
 * TALV GENERALISATION ACCEPTANCE — the CLASSIC ALV / dynpro REPORTING archetype, on REAL code.
 *
 * B2-generalisation step 3 (operator directive 2026-07-29): prove the disposition classifier generalises
 * beyond the two example fixtures. This corpus is a classic SAP-GUI ALV/dynpro table-maintenance framework
 * (AES0P/TALV, MIT) — the ALV report → Fiori Elements List Report re-architecture path that abap_fico
 * (batch→RAP BO) and zapcommander (GUI/OS/RFC file manager→classes) do NOT exercise. It runs the whole offline
 * path on genuine third-party ABAP: filesFromBundle → analyzePackage → assemblePlan.
 *
 * It asserts the GENERALISATION GUARANTEE on real code — no object degrades to seal, no premature rebuild
 * (§935), ALV objects re-architect — and that the ui_rearch routing fires and routes correctly on real findings.
 *
 * NOT part of `npm test` (MIT source fetched locally + git-ignored — see demos/talv-2026-07-29/FETCH.md);
 * FAILS LOUDLY when the source is absent; never skipped.
 *
 *   npm run test:corpus
 *   TALV_CORPUS=<dir> npm run test:corpus
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = process.env.TALV_CORPUS || join(HERE, "..", "..", "..", "demos", "talv-2026-07-29", "before", "source");

function corpusOrFail() {
  if (!existsSync(CORPUS)) {
    throw new Error(
      `TALV corpus not found at ${CORPUS}. The MIT source is fetched locally and git-ignored — ` +
        `fetch it per demos/talv-2026-07-29/FETCH.md (into before/source/), or set TALV_CORPUS=<dir>.`,
    );
  }
  return CORPUS;
}

const files = filesFromBundle(corpusOrFail());
const doc = analyzePackage(files, { package: "talv", source_system: "corpus:talv" });
const { plan } = assemblePlan(doc);
const tally = plan.nodes.reduce((a, n) => ((a[n.disposition] = (a[n.disposition] ?? 0) + 1), a), {});
const hintNodes = (h) => plan.nodes.filter((n) => (n.disposition_hints ?? []).includes(h));
const DISPOSITIONS = ["refactor", "re_architect", "rebuild", "replace", "retire", "seal"];

test("the real corpus loads and assembles a disposition plan (scale + shape)", () => {
  assert.ok(files.length > 40, `too few source files: ${files.length}`);
  assert.ok(plan.nodes.length > 30, `too few plan nodes: ${plan.nodes.length}`);
  for (const n of plan.nodes) assert.ok(DISPOSITIONS.includes(n.disposition), `${n.object}: valid disposition`);
});

test("GENERALISATION GUARANTEE: no object degrades to seal, and B2 emits no rebuild (§935)", () => {
  assert.equal(tally.seal ?? 0, 0, `every object must get a true-modernisation disposition — none seals; tally=${JSON.stringify(tally)}`);
  assert.equal(tally.rebuild ?? 0, 0, `rebuild is a B3.5 app-level promotion, never a per-object B2 output; tally=${JSON.stringify(tally)}`);
});

test("a classic-ALV app RE-ARCHITECTS: re_architect is the dominant disposition", () => {
  assert.ok((tally.re_architect ?? 0) >= (tally.refactor ?? 0), `expected re_architect-dominant; tally=${JSON.stringify(tally)}`);
});

test("ROUTING PROOF (real code): the ui_rearch hint fires and every such node → re_architect", () => {
  const ui = hintNodes("ui_rearch");
  assert.ok(ui.length >= 1, "at least one object's real finding message must derive the classic-UI ui_rearch hint");
  for (const n of ui) assert.equal(n.disposition, "re_architect", `${n.object}: ui_rearch → re_architect`);
});

test("retain-kinds (interfaces + CX_ exception classes) → refactor", () => {
  const retain = plan.nodes.filter((n) => n.object_kind === "interface" || (n.object_kind === "class" && /(^|\/)[YZ]?CX_/i.test(n.object)));
  for (const n of retain) assert.equal(n.disposition, "refactor", `${n.object} (retain-kind) → refactor`);
});

// HONEST FINDING (documented, not a failure): the ui_rearch hint UNDER-FIRES on real code — the analyser's rule
// MESSAGES rarely name the ALV/dynpro construct (most findings are `style`), so the re_architect verdict is
// predominantly TARGET-driven. Analyser-coverage gap ([[analyser-rap-awareness-backlog]]), not a classifier
// defect; the target fallback keeps generalisation robust. This test PINS that robustness.
test("target-fallback carries generalisation when hints are sparse (analyser-coverage reality)", () => {
  const targetDriven = plan.nodes.filter((n) => n.disposition === "re_architect" && (n.disposition_hints ?? []).every((h) => h === "style"));
  assert.ok(targetDriven.length >= 1, "some re_architect verdicts come via the analyser TARGET, not a hint — the fallback that keeps generalisation robust to analyser under-description");
});
