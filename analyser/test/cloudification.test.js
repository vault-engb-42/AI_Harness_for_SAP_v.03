import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, isReleased, getSuccessor, effortTier, indexSize, _resetCache } from "../src/cloudification.js";

// Real I/O against the bundled dataset — no mocks (per tdd.md). Assertions use
// stable, specific dataset entries + structural invariants robust to refresh.

test("index loads and merges both bundled files", () => {
  _resetCache();
  // > release-file alone (34675) proves the classifications file merged in too.
  assert.ok(indexSize() > 35000, `expected >35000 merged objects, got ${indexSize()}`);
});

test("a deprecated object with a successor classifies correctly", () => {
  const c = classify("ABAP_CLOUD_DEVELOPMENT_3TIER");
  assert.equal(c.raw_state, "deprecated");
  assert.equal(c.release_state, "deprecated");
  assert.ok(c.successors.some((s) => s.name === "ABAP_CLEAN_CORE_DEVELOPMENT"), "successor present");
  assert.ok(c.successors[0].type, "successor carries its TADIR type");
  assert.equal(getSuccessor("ABAP_CLOUD_DEVELOPMENT_3TIER"), "ABAP_CLEAN_CORE_DEVELOPMENT");
  assert.equal(effortTier("ABAP_CLOUD_DEVELOPMENT_3TIER"), "re-platform");
});

test("a classicAPI object (from classifications file) is not released and re-platform", () => {
  const c = classify("/AIF/CL_BGRFC_CLEANUP_UTIL");
  assert.equal(c.raw_state, "classicAPI");
  assert.equal(isReleased("/AIF/CL_BGRFC_CLEANUP_UTIL"), false);
  assert.equal(effortTier("/AIF/CL_BGRFC_CLEANUP_UTIL"), "re-platform");
});

test("lookup is case-insensitive", () => {
  assert.equal(classify("abap_cloud_development_3tier").raw_state, "deprecated");
});

test("unknown objects degrade to unknown, not throw", () => {
  const c = classify("ZZ_NOT_A_REAL_OBJECT_9999");
  assert.equal(c.release_state, "unknown");
  assert.deepEqual(c.successors, []);
  assert.equal(isReleased("ZZ_NOT_A_REAL_OBJECT_9999"), false);
  assert.equal(getSuccessor("ZZ_NOT_A_REAL_OBJECT_9999"), undefined);
  assert.equal(effortTier("ZZ_NOT_A_REAL_OBJECT_9999"), "unknown");
});

test("nullish input is handled", () => {
  assert.equal(classify(undefined).release_state, "unknown");
  assert.equal(classify(null).release_state, "unknown");
});
