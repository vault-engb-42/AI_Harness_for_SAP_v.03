import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ALL_RULES } from "../rules/index.js";

// Data-integrity guards for the data-driven packs: every row must carry a
// validated example it actually fires on, no row may silently fail to
// compile (the engine's fail-open drop otherwise hides it), and the rule
// registry wiring is pinned so deleting a pack cannot stay green.

const RULES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "rules");
const regexRows = JSON.parse(readFileSync(join(RULES_DIR, "data", "regex-rules.json"), "utf8"));
const metadataRows = JSON.parse(readFileSync(join(RULES_DIR, "data", "metadata-rules.json"), "utf8"));

test("every regex row compiles (no silent fail-open drops)", () => {
  // The engine drops a row ONLY on compile failure, so asserting every
  // declared row compiles is exactly the count-parity guard.
  for (const r of regexRows) {
    assert.doesNotThrow(() => new RegExp(r.pattern, (r.flags ?? "i").replace(/g/g, "")), `${r.id} pattern`);
    if (r.when) assert.doesNotThrow(() => new RegExp(r.when, "i"), `${r.id} when`);
  }
});

test("every regex row fires on its own example and not on its counter-example", () => {
  for (const r of regexRows) {
    assert.ok(typeof r.example === "string" && r.example.length > 0, `${r.id} carries an example`);
    const re = new RegExp(r.pattern, (r.flags ?? "i").replace(/g/g, ""));
    assert.ok(re.test(r.example), `${r.id} fires on its example: ${r.example}`);
    if (r.counter_example) {
      assert.ok(!re.test(r.counter_example), `${r.id} must NOT fire on: ${r.counter_example}`);
    }
  }
});

test("every metadata row compiles and declares valid mode + severity", () => {
  const SEV = new Set(["priority-1", "priority-2", "priority-3", "info"]);
  for (const r of metadataRows) {
    assert.ok(SEV.has(r.severity), `${r.id} severity`);
    assert.ok(r.require || r.forbid, `${r.id} has a mode`);
    if (r.forbid) assert.doesNotThrow(() => new RegExp(r.forbid, "i"), `${r.id} forbid`);
    if (r.when) assert.doesNotThrow(() => new RegExp(r.when, "i"), `${r.id} when`);
    if (r.unless) assert.doesNotThrow(() => new RegExp(r.unless, "i"), `${r.id} unless`);
  }
});

test("ALL_RULES wiring is pinned — removing any pack breaks this test", () => {
  const ids = ALL_RULES.map((r) => r.id).sort();
  assert.deepEqual(ids, [
    "bf-pack",
    "cds-structure-pack",
    "clone-pack",
    "ddic-pack",
    "flow-pack",
    "graph-pack",
    "intf-pack",
    "invariant-authority-check-subrc",
    "metadata-pack",
    "rap-context-pack",
    "regex-pack",
    "released-api",
    "srvb-pack",
    "statement-pack",
    "talos-missing-test-class",
    "test-quality-pack",
  ]);
});

// judgement-4 — a `disposition_hint` is EVIDENCE the moderniser acts on directly: `ui_rearch` routes an
// object to re_architect at 0.85 without further corroboration. A rule that bundles UI and non-UI
// constructs under one ui_rearch tag therefore re-architects objects that merely format data. Guarding the
// whole pack rather than the one rule, so the next bundled rule cannot reintroduce it.
const NON_UI_CONSTRUCTS = [
  "  CALL FUNCTION 'CONVERSION_EXIT_ALPHA_INPUT'.",
  "  CALL FUNCTION 'NUMBER_GET_NEXT'.",
  "  CALL FUNCTION 'BAPI_MATERIAL_SAVEDATA'.",
];

test("no ui_rearch-tagged rule fires on a construct that is not a user interface", () => {
  for (const r of regexRows) {
    if (r.disposition_hint !== "ui_rearch" || !r.pattern) continue;
    const re = new RegExp(r.pattern, r.flags || "");
    for (const snippet of NON_UI_CONSTRUCTS) {
      assert.equal(re.test(snippet), false,
        `${r.id} is tagged ui_rearch but matches a non-UI construct: ${snippet.trim()}`);
    }
  }
});
