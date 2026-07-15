import { test } from "node:test";
import assert from "node:assert/strict";
import { offlineVerdict } from "../src/node/verdict.js";

// offlineVerdict is nodeVerdict's sibling for the offline pass. It EXCLUDES the three DEV-only
// conjuncts (activated, reconciled, unit) — which can never be true offline — and enforces the
// 6 offline-computable ones (atc_p1, invariants.intact, auth_coverage.lost, auth_delta
// attestation, parity, warn_delta). A full pass is PROVISIONAL, never GREEN (offline never
// GREENs, P6). Same checkpoint shape as nodeVerdict; only the conjunct set differs.

const clean = { atc_p1: 0, invariants: { intact: true }, auth_coverage: { lost: false }, parity: { verdict: "equivalent" } };
const ratchet = { atc_warn_delta: 0 };

test("a checkpoint passing the offline conjuncts is PROVISIONAL, even with NO activated/reconciled/unit", () => {
  const r = offlineVerdict(clean, ratchet);
  assert.equal(r.verdict, "PROVISIONAL");
  assert.deepEqual(r.reasons, []);
});

test("the DEV-only conjuncts are EXCLUDED — activated/reconciled absent and unit failing do NOT block", () => {
  // nodeVerdict would BLOCK on not-activated-or-reconciled and unit-not-green; offlineVerdict must not.
  const r = offlineVerdict({ ...clean, activated: undefined, reconciled: undefined, unit: { green: false } }, ratchet);
  assert.equal(r.verdict, "PROVISIONAL");
  assert.ok(!r.reasons.includes("not-activated-or-reconciled"));
  assert.ok(!r.reasons.includes("unit-not-green"));
});

test("atc_p1 nonzero blocks (the gap-2a gate asserts it 0; offlineVerdict re-asserts fail-closed)", () => {
  const r = offlineVerdict({ ...clean, atc_p1: 2 }, ratchet);
  assert.equal(r.verdict, "BLOCK");
  assert.ok(r.reasons.includes("atc-p1-nonzero"));
});

test("P4 invariant broken blocks (fail-closed: must PROVE intact)", () => {
  assert.equal(offlineVerdict({ ...clean, invariants: { intact: false } }, ratchet).verdict, "BLOCK");
  assert.ok(offlineVerdict({ ...clean, invariants: {} }, ratchet).reasons.includes("p4-invariant-broken"));
});

test("proven auth-coverage loss blocks; an unattested auth-delta blocks; an attested one passes", () => {
  assert.ok(offlineVerdict({ ...clean, auth_coverage: { lost: true } }, ratchet).reasons.includes("auth-coverage-lost"));
  assert.ok(offlineVerdict({ ...clean, invariants: { intact: true, auth_delta: true } }, ratchet).reasons.includes("auth-delta-unattested"));
  assert.equal(
    offlineVerdict({ ...clean, invariants: { intact: true, auth_delta: true }, attestations: { auth_equivalence: "alice" } }, ratchet).verdict,
    "PROVISIONAL",
  );
});

test("parity not equivalent blocks; a warn-delta regression blocks; missing warn fails closed", () => {
  assert.equal(offlineVerdict({ ...clean, parity: { verdict: "needs_review" } }, ratchet).verdict, "BLOCK");
  assert.ok(offlineVerdict(clean, { atc_warn_delta: 1 }).reasons.includes("warn-delta-regressed"));
  assert.ok(offlineVerdict(clean, {}).reasons.includes("warn-delta-regressed"));
});

test("a no-released-successor node with no defect PARKs (same class as nodeVerdict)", () => {
  assert.equal(offlineVerdict({ block_reason: "NO_RELEASED_SUCCESSOR" }, {}).verdict, "PARK");
});
