import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeS4Status, effortTierForStatus } from "../src/s4-status.js";

test("normalizeS4Status folds released variants to 'released'", () => {
  assert.equal(normalizeS4Status("released"), "released");
  assert.equal(normalizeS4Status("RELEASED"), "released");
  assert.equal(normalizeS4Status("released_with_restrictions"), "released");
});

test("normalizeS4Status folds deprecated/not-released variants to 'deprecated'", () => {
  assert.equal(normalizeS4Status("not_released"), "deprecated");
  assert.equal(normalizeS4Status("deprecated"), "deprecated");
  assert.equal(normalizeS4Status("obsolete"), "deprecated");
});

test("normalizeS4Status folds removed/deleted variants to 'removed'", () => {
  assert.equal(normalizeS4Status("removed"), "removed");
  assert.equal(normalizeS4Status("deleted"), "removed");
  assert.equal(normalizeS4Status("not_available"), "removed");
});

test("normalizeS4Status folds anything unknown/blank to 'unknown'", () => {
  assert.equal(normalizeS4Status("not_classified"), "unknown");
  assert.equal(normalizeS4Status(""), "unknown");
  assert.equal(normalizeS4Status(undefined), "unknown");
  assert.equal(normalizeS4Status("something weird"), "unknown");
});

test("effortTierForStatus maps normalized status to the schema effort_tier", () => {
  assert.equal(effortTierForStatus("released"), "keep-and-clean");
  assert.equal(effortTierForStatus("deprecated"), "re-platform");
  assert.equal(effortTierForStatus("removed"), "retire");
  assert.equal(effortTierForStatus("unknown"), "unknown");
});

test("effortTierForStatus normalizes raw input before mapping", () => {
  assert.equal(effortTierForStatus("NOT_RELEASED"), "re-platform");
  assert.equal(effortTierForStatus("deleted"), "retire");
});

test("bundled dataset states map correctly", () => {
  // objectReleaseInfo states
  assert.equal(normalizeS4Status("notToBeReleased"), "deprecated");
  assert.equal(effortTierForStatus("notToBeReleased"), "re-platform");
  // objectClassifications states
  assert.equal(normalizeS4Status("classicAPI"), "deprecated");
  assert.equal(effortTierForStatus("classicAPI"), "re-platform");
  assert.equal(normalizeS4Status("noAPI"), "removed");
  assert.equal(effortTierForStatus("noAPI"), "retire");
});
