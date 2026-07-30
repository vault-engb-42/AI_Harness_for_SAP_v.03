// Unit tests for the model-tier preset logic (pure functions).
import { test } from "node:test";
import assert from "node:assert/strict";
import { PRESETS, modelForRole, rewriteModelLine } from "../model-tier.js";

const OPUS = "claude-opus-4-8";
const SONNET = "claude-sonnet-4-6";

test("presets exist for cost, balanced, max-quality and cover all 11 roles", () => {
  for (const p of ["cost", "balanced", "max-quality"]) {
    assert.equal(Object.keys(PRESETS[p]).length, 11, `${p} should pin 11 roles`);
  }
});

test("the reasoned-architecture roles run judgment on Opus in every preset", () => {
  // abap-arch-reviewer is a fresh-context judgment reviewer (agent file); arch-judge is the fileless
  // logical role whose pinned model_id keys the verdict cache (a swap is a MISS, surfaced — S14).
  for (const preset of ["cost", "balanced", "max-quality"]) {
    assert.equal(modelForRole(preset, "abap-arch-reviewer"), OPUS, `${preset} abap-arch-reviewer`);
    assert.equal(modelForRole(preset, "arch-judge"), OPUS, `${preset} arch-judge`);
  }
});

test("balanced runs generation on Sonnet and judgment on Opus", () => {
  assert.equal(modelForRole("balanced", "abap-generator"), SONNET);
  assert.equal(modelForRole("balanced", "abap-explorer"), SONNET);
  assert.equal(modelForRole("balanced", "transport-manager"), SONNET);
  assert.equal(modelForRole("balanced", "planner"), OPUS);
  assert.equal(modelForRole("balanced", "abap-evaluator"), OPUS);
  assert.equal(modelForRole("balanced", "abap-security-reviewer"), OPUS);
});

test("max-quality promotes generation to Opus but keeps explorer on Sonnet", () => {
  assert.equal(modelForRole("max-quality", "abap-generator"), OPUS);
  assert.equal(modelForRole("max-quality", "transport-manager"), OPUS);
  assert.equal(modelForRole("max-quality", "abap-explorer"), SONNET);
});

test("cost equals balanced (kept distinct for per-project re-tuning)", () => {
  assert.deepEqual(PRESETS.cost, PRESETS.balanced);
});

test("modelForRole returns null for an unknown preset or role", () => {
  assert.equal(modelForRole("bogus", "planner"), null);
  assert.equal(modelForRole("balanced", "nonexistent"), null);
});

test("rewriteModelLine replaces the frontmatter model line only", () => {
  const before = "---\nname: planner\ntools: Read\nmodel: claude-sonnet-4-6\n---\n\n# Body model: keep\n";
  const after = rewriteModelLine(before, OPUS);
  assert.match(after, /^model: claude-opus-4-8$/m);
  assert.doesNotMatch(after, /^model: claude-sonnet-4-6$/m);
  assert.match(after, /# Body model: keep/); // body untouched
  // idempotent
  assert.equal(rewriteModelLine(after, OPUS), after);
});
