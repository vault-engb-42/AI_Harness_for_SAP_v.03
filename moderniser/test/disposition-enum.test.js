import { test } from "node:test";
import assert from "node:assert/strict";
import { DISPOSITIONS, isDisposition } from "../src/plan/disposition-enum.js";

// B1 — the disposition taxonomy (the Gartner "R"s → SAP), MODERNISER_DESIGN §6.11 / BUILD_PLAN B1.
// A closed, frozen enum shared by the classifier (B2), the manifest/gate (B3), and the decide vocab (S2).

test("the disposition taxonomy is the six ratified Rs, frozen and closed", () => {
  assert.deepEqual(
    [...DISPOSITIONS].sort(),
    ["re_architect", "rebuild", "refactor", "replace", "retire", "seal"], // '_' (0x5F) < 'b' (0x62)
  );
  assert.ok(Object.isFrozen(DISPOSITIONS), "the taxonomy is frozen (closed set)");
});

test("isDisposition validates membership against the closed set", () => {
  for (const d of DISPOSITIONS) assert.ok(isDisposition(d), d);
  assert.ok(!isDisposition("port"), "port is not a disposition");
  assert.ok(!isDisposition("Refactor"), "case-sensitive");
  assert.ok(!isDisposition(""), "empty string");
  assert.ok(!isDisposition(null), "null");
  assert.ok(!isDisposition(undefined), "undefined");
});
