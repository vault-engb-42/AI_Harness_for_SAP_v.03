import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { defaultPromptHash } from "../src/cli-arch.js";

// F-8.1 — the verdict cache is keyed on (fact_hash, model_id, prompt_hash) and freezes a judge's answer
// across runs. The judge does not choose freely: it picks from the ranked CANDIDATE LIST the patterns
// corpus produced for those facts. So the corpus is an input to the question, and hashing only the prompt
// template left it outside the key — tighten a guard or add a shape, and every frozen verdict stayed
// addressable and was served, carrying a candidate list the corpus can no longer produce. The human then
// ratifies alternatives that do not exist.
//
// Asserted as a COMPOSITION rather than by editing the corpus and observing a change: a test that mutates
// a file two hundred other tests read is a shared-state hazard (testing.md), and the composition is the
// actual contract.

const PROMPT = new URL("../src/plan/patterns/arch-reason-prompt.md", import.meta.url);
const CORPUS = new URL("../src/plan/patterns/target-patterns.json", import.meta.url);

test("the hash is exactly sha256(template + NUL + corpus) — reconstructable, not opaque", () => {
  const expected = createHash("sha256")
    .update(readFileSync(PROMPT, "utf8"))
    .update(String.fromCharCode(0))
    .update(readFileSync(CORPUS, "utf8"))
    .digest("hex");
  assert.equal(defaultPromptHash(), expected);
});

test("the template alone is NOT the hash — the regression this closes would pass that", () => {
  const templateOnly = createHash("sha256").update(readFileSync(PROMPT, "utf8")).digest("hex");
  assert.notEqual(defaultPromptHash(), templateOnly,
    "a corpus edit must change the key, or stale verdicts survive it");
});

test("it is deterministic — the cache key cannot drift between reads", () => {
  assert.equal(defaultPromptHash(), defaultPromptHash());
});
