import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Step E contract guard (MODERNISER_DRIVER_AND_GAP2_DESIGN Phase 2). The /modernise SKILL is
// prose, but it is now a thin drive-driven FULFILLER over the deterministic CLI — so the seam
// that CAN drift silently is: a CLI verb the SKILL invokes gets renamed, or the drive-loop
// action/outcome vocabulary the fulfiller branches on stops matching what the code emits. This
// test IS that contract check — every CLI invocation in the SKILL must name a registered verb,
// and the drive loop the SKILL documents must match drive.js. Real files, no mocks.

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const SKILL = readFileSync(join(ROOT, ".claude", "skills", "modernise", "SKILL.md"), "utf8");
const CLI = readFileSync(join(ROOT, "moderniser", "src", "cli.js"), "utf8");
const DRIVE = readFileSync(join(ROOT, "moderniser", "src", "sched", "drive.js"), "utf8");

/** The registered verb set — parsed from the `const COMMANDS = { … }` map in cli.js (source of truth). */
function cliCommands() {
  const block = CLI.match(/const COMMANDS = \{([\s\S]*?)\};/);
  assert.ok(block, "cli.js must declare a COMMANDS map");
  const verbs = new Set();
  for (const line of block[1].split("\n")) {
    const m = line.match(/^\s*"?([a-z][a-z-]*)"?\s*:/);
    if (m) verbs.add(m[1]);
  }
  return verbs;
}

/** Every CLI verb the SKILL invokes — the full `cli.js <verb>` form OR the SKILL's own `...` abbreviation for it. */
function skillInvokedVerbs() {
  const verbs = new Set();
  // SKILL.md declares `...` abbreviates `node moderniser/src/cli.js`; the escalation/park/cycle gates
  // invoke verbs ONLY through that abbreviation, so the contract must resolve BOTH forms (review F5).
  // Safe against prose ellipsis: the SKILL uses the unicode `…` for prose, ASCII `...` only for the CLI.
  for (const m of SKILL.matchAll(/(?:cli\.js|\.\.\.)\s+([a-z][a-z-]*)/g)) verbs.add(m[1]);
  return verbs;
}

test("the CLI registers the drive verb (the fulfiller's spine)", () => {
  assert.ok(cliCommands().has("drive"), "COMMANDS must register 'drive'");
});

test("every CLI verb the /modernise SKILL invokes is a registered command (no dangling/renamed verb)", () => {
  const commands = cliCommands();
  const invoked = skillInvokedVerbs();
  assert.ok(invoked.size >= 5, `the verb extractor should find the SKILL's CLI calls (found ${invoked.size})`);
  const dangling = [...invoked].filter((v) => !commands.has(v));
  assert.deepEqual(dangling, [], `SKILL invokes verbs that do not exist in cli.js COMMANDS: ${dangling.join(", ")}`);
  // the `...`-abbreviated escalation/park/cycle verbs must be COVERED, not just non-dangling — a rename
  // of any of them must trip this test rather than ship a broken SKILL green (review F5).
  for (const v of ["decide", "escalate", "seams", "resolve-cycle", "reprobe"]) {
    assert.ok(invoked.has(v), `the contract must validate the '...'-invoked verb '${v}' (F5 regression guard)`);
  }
});

test("the SKILL drives the loop with `drive` and owns retry-vs-ceiling via `--report`", () => {
  assert.ok(skillInvokedVerbs().has("drive"), "the SKILL must invoke the `drive` verb as its loop spine");
  assert.match(SKILL, /--report/, "the SKILL must use `drive --report` (increment 2: the driver owns retry-vs-ceiling)");
});

test("the SKILL documents every drive-loop action branch — and each matches an action drive.js emits", () => {
  // A fulfiller that does not branch on all five actions can silently stall on an unhandled one.
  const ACTIONS = ["generate", "await_human", "provisional_complete", "complete", "blocked"];
  for (const a of ACTIONS) {
    // Anchor to the SKILL's **`action`** branch-bullet form. An un-anchored /generate/ or /complete/
    // matches 'regenerate' / 'provisional_complete' and would NOT catch a deleted branch (review F6).
    assert.match(SKILL, new RegExp("\\*\\*`" + a + "`\\*\\*"), `the SKILL must document the '${a}' drive-action branch (as a **\`${a}\`** bullet)`);
    assert.match(DRIVE, new RegExp(`"${a}"`), `drive.js must actually emit the '${a}' action the SKILL documents`);
  }
});

test("the SKILL reports every syntax outcome the driver accepts — and each matches drive.js/cli-drive.js", () => {
  const OUTCOMES = ["syntax_ok", "syntax_fail", "generator_error"];
  const CLI_DRIVE = readFileSync(join(ROOT, "moderniser", "src", "cli-drive.js"), "utf8");
  for (const o of OUTCOMES) {
    assert.match(SKILL, new RegExp(o), `the SKILL must document reporting the '${o}' outcome`);
    assert.match(CLI_DRIVE, new RegExp(`"${o}"`), `cli-drive.js must accept the '${o}' outcome the SKILL reports`);
  }
});

test("the granular reducer verbs remain documented (manual/debug/resume path is preserved)", () => {
  // Step E thins the loop to drive-driven, but the granular verbs must survive for manual
  // control, the online checkpoint/verdict arc the driver does not yet own, and resume.
  for (const verb of ["verdict", "resume", "status"]) {
    assert.match(SKILL, new RegExp(`\\b${verb}\\b`), `the SKILL must still document the granular '${verb}' verb`);
  }
});
