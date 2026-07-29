import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPromptOptions } from "../src/plan/prompt-options.js";

// B3 / Arc D — the prompt contract (MODERNISER_DESIGN §6.11, BUILD_PLAN S2). Every prompted node presents a
// CHOICE, not a verdict: >=3 options, EXACTLY one recommended:true (first), grounded alternatives, and ALWAYS
// an `other` (operator-specified freeform) escape. A bare recommendation, or alternatives with no
// recommendation, both violate the contract.

test("builds recommended-first + alternatives + a freeform `other` escape", () => {
  const opts = buildPromptOptions(
    { disposition: "re_architect", rationale: "classic UI → RAP+Fiori" },
    [{ disposition: "refactor", rationale: "clean in place" }, { disposition: "retire", rationale: "drop if obsolete" }],
  );
  assert.equal(opts.length, 4);
  assert.equal(opts[0].disposition, "re_architect");
  assert.equal(opts[0].recommended, true);
  assert.equal(opts.filter((o) => o.recommended).length, 1, "exactly one recommended");
  const other = opts.at(-1);
  assert.equal(other.disposition, "other");
  assert.equal(other.freeform, true);
  assert.equal(other.recommended, false);
});

test("dedupes an alternative that equals the recommended disposition", () => {
  const opts = buildPromptOptions(
    { disposition: "refactor", rationale: "clean" },
    [{ disposition: "refactor", rationale: "dup" }, { disposition: "re_architect", rationale: "champion" }],
  );
  assert.deepEqual(opts.map((o) => o.disposition), ["refactor", "re_architect", "other"]);
});

test("refuses fewer than 3 options (recommended + other with no alternative)", () => {
  assert.throws(() => buildPromptOptions({ disposition: "seal", rationale: "manual" }, []), />=?3|at least 3|three/i);
});

test("refuses an invalid recommended or alternative disposition (enum allowlist)", () => {
  assert.throws(() => buildPromptOptions({ disposition: "port", rationale: "x" }, [{ disposition: "refactor", rationale: "y" }]), /disposition/i);
  assert.throws(() => buildPromptOptions({ disposition: "refactor", rationale: "x" }, [{ disposition: "nope", rationale: "y" }]), /disposition/i);
});
