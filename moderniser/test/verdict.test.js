import { test } from "node:test";
import assert from "node:assert/strict";
import { nodeVerdict } from "../src/node/verdict.js";
import { NO_RELEASED_SUCCESSOR } from "../src/state/node-status.js";

// §3.2 verdict logic, re-tokenised to §6.1's parity enum. A fixed conjunction — no
// author-settable soft path for the hard gates (P4 / ATC-P1). Fail-CLOSED on every hard
// conjunct (missing evidence = fail, never fall-through-pass, §3.2 5.3); fail-OPEN on auth
// (BLOCK only on PROVEN coverage loss, L7). PARK is the deterministic no-released-successor
// class only — never a P4/defect BLOCK (L7).

const green = () => ({
  activated: true,
  reconciled: true,
  atc_p1: 0,
  atc_p2: 0,
  unit: { green: true },
  invariants: { intact: true },
  auth_coverage: { lost: false },
  parity: { verdict: "equivalent" },
});
const ratchet = () => ({ atc_warn_delta: 0 });
const verdict = (cpOver = {}, rOver = {}) => nodeVerdict({ ...green(), ...cpOver }, { ...ratchet(), ...rOver });

test("a fully-passing checkpoint is GREEN with no reasons", () => {
  assert.deepEqual(nodeVerdict(green(), ratchet()), { verdict: "GREEN", reasons: [] });
});

test("PASS_STRUCTURAL parity is also GREEN", () => {
  assert.equal(verdict({ parity: { verdict: "PASS_STRUCTURAL" } }).verdict, "GREEN");
});

test("each hard conjunct failing yields BLOCK", () => {
  assert.equal(verdict({ activated: false }).verdict, "BLOCK");
  assert.equal(verdict({ reconciled: false }).verdict, "BLOCK");
  assert.equal(verdict({ atc_p1: 1 }).verdict, "BLOCK");
  assert.equal(verdict({ unit: { green: false } }).verdict, "BLOCK");
  assert.equal(verdict({ invariants: { intact: false } }).verdict, "BLOCK");
  assert.equal(verdict({ auth_coverage: { lost: true } }).verdict, "BLOCK");
  assert.equal(verdict({ parity: { verdict: "needs_review" } }).verdict, "BLOCK");
  assert.equal(verdict({ parity: { verdict: "scope_reduced" } }).verdict, "BLOCK");
  assert.equal(verdict({ parity: { verdict: "auth_vanished" } }).verdict, "BLOCK", "a parity veto");
  assert.equal(verdict({}, { atc_warn_delta: 1 }).verdict, "BLOCK");
});

test("BLOCK reasons name exactly the failed conjuncts", () => {
  const r = verdict({ atc_p1: 2, unit: { green: false } });
  assert.equal(r.verdict, "BLOCK");
  assert.deepEqual(r.reasons.sort(), ["atc-p1-nonzero", "unit-not-green"]);
});

test("hard conjuncts fail CLOSED when their evidence is missing", () => {
  assert.equal(nodeVerdict({}, {}).verdict, "BLOCK", "empty checkpoint → BLOCK, never pass");
  assert.equal(verdict({ atc_p1: undefined }).verdict, "BLOCK");
  assert.equal(verdict({ unit: undefined }).verdict, "BLOCK");
  assert.equal(verdict({ parity: undefined }).verdict, "BLOCK");
  assert.equal(nodeVerdict(green(), {}).verdict, "BLOCK", "missing warn-delta → fail-closed");
});

test("auth fails OPEN — a missing auth_coverage does not block (L7: block only on proven loss)", () => {
  assert.equal(verdict({ auth_coverage: undefined }).verdict, "GREEN");
});

test("the WARN delta passes at exactly 0 and when negative, fails when positive", () => {
  assert.equal(verdict({}, { atc_warn_delta: 0 }).verdict, "GREEN");
  assert.equal(verdict({}, { atc_warn_delta: -3 }).verdict, "GREEN");
  assert.equal(verdict({}, { atc_warn_delta: 1 }).verdict, "BLOCK");
});

test("PARK is granted for a no-released-successor block that breaks no invariant", () => {
  const r = nodeVerdict({ block_reason: NO_RELEASED_SUCCESSOR, activated: false }, {});
  assert.deepEqual(r, { verdict: "PARK", reasons: [NO_RELEASED_SUCCESSOR] });
});

// --- PARITY_REVIEW attestation consumption (operator-ratified 2026-07-12) ---

test("an ATTESTED needs_review satisfies the parity conjunct — all other conjuncts still required", () => {
  const attested = { parity: { verdict: "needs_review" }, attestations: { parity_equivalence: "j.doe" } };
  assert.equal(verdict(attested).verdict, "GREEN", "gray band + audited attestation + machine conjuncts green");
  assert.equal(verdict({ ...attested, unit: { green: false } }).verdict, "BLOCK", "attestation neutralises ONLY parity");
  assert.equal(verdict({ ...attested, atc_p1: 2 }).verdict, "BLOCK");
});

test("an UNattested needs_review still blocks; a null attestation is not an attestation", () => {
  assert.equal(verdict({ parity: { verdict: "needs_review" } }).verdict, "BLOCK");
  assert.equal(verdict({ parity: { verdict: "needs_review" }, attestations: { parity_equivalence: null } }).verdict, "BLOCK");
  assert.equal(verdict({ parity: { verdict: "needs_review" }, attestations: { parity_equivalence: "" } }).verdict, "BLOCK");
});

test("vetoes and scope_reduced can NEVER be attested past (7.5 asymmetry)", () => {
  for (const v of ["scope_reduced", "auth_vanished", "reassembly_broken"]) {
    const r = verdict({ parity: { verdict: v }, attestations: { parity_equivalence: "j.doe" } });
    assert.equal(r.verdict, "BLOCK", v);
  }
});

test("PARK is REFUSED when a P4 invariant or auth is also broken (P4 wins → BLOCK)", () => {
  assert.equal(nodeVerdict({ block_reason: NO_RELEASED_SUCCESSOR, invariants: { intact: false } }, {}).verdict, "BLOCK");
  assert.equal(nodeVerdict({ block_reason: NO_RELEASED_SUCCESSOR, auth_coverage: { lost: true } }, {}).verdict, "BLOCK");
});

test("PARK is REFUSED for a DEFECTIVE-output no-successor block — never a defect BLOCK (§3.2, L7)", () => {
  assert.equal(nodeVerdict({ block_reason: NO_RELEASED_SUCCESSOR, atc_p1: 5 }, {}).verdict, "BLOCK", "ATC P1>0 is a defect");
  assert.equal(nodeVerdict({ block_reason: NO_RELEASED_SUCCESSOR, unit: { green: false } }, {}).verdict, "BLOCK", "unit red");
  assert.equal(nodeVerdict({ block_reason: NO_RELEASED_SUCCESSOR, parity: { verdict: "auth_vanished" } }, {}).verdict, "BLOCK", "parity veto");
  assert.equal(nodeVerdict({ block_reason: NO_RELEASED_SUCCESSOR, parity: { verdict: "scope_reduced" } }, {}).verdict, "BLOCK", "parity BLOCK band");
  assert.equal(nodeVerdict({ block_reason: NO_RELEASED_SUCCESSOR }, { atc_warn_delta: 3 }).verdict, "BLOCK", "WARN regressed");
});

// --- AUTH_EQUIVALENCE attestation consumption (operator-ratified 2026-07-13, D1 — mirrors parity) ---

test("D1: a non-empty auth delta BLOCKs without an audited auth-equivalence attestation (L7 'owed before PASS')", () => {
  const delta = { invariants: { intact: true, auth_delta: true } };
  const r = verdict(delta);
  assert.equal(r.verdict, "BLOCK");
  assert.ok(r.reasons.includes("auth-delta-unattested"));
  // attested → the conjunct is satisfied; every other conjunct still required
  const attested = { invariants: { intact: true, auth_delta: true }, attestations: { auth_equivalence: "s.reviewer" } };
  assert.equal(verdict(attested).verdict, "GREEN");
  assert.equal(verdict({ ...attested, unit: { green: false } }).verdict, "BLOCK", "attestation neutralises ONLY auth");
  // null/empty is not an attestation
  assert.equal(verdict({ ...delta, attestations: { auth_equivalence: null } }).verdict, "BLOCK");
  assert.equal(verdict({ ...delta, attestations: { auth_equivalence: "" } }).verdict, "BLOCK");
  // no footprint change → nothing owed
  assert.equal(verdict({ invariants: { intact: true, auth_delta: false } }).verdict, "GREEN");
});

test("D1: an unattested auth delta is a DEFECT for the PARK guard too", () => {
  const r = nodeVerdict({ block_reason: NO_RELEASED_SUCCESSOR, invariants: { intact: true, auth_delta: true } }, {});
  assert.equal(r.verdict, "BLOCK", "a footprint change was attempted — never a clean PARK");
});

test("L9: malformed-but-PRESENT evidence is a defect for the PARK guard — 'absent' means the KEY is absent", () => {
  const park = (cp, ratchet = {}) => nodeVerdict({ block_reason: NO_RELEASED_SUCCESSOR, ...cp }, ratchet).verdict;
  assert.equal(park({}), "PARK", "genuinely absent conjuncts → the deterministic PARK class");
  assert.equal(park({ atc_p1: "5" }), "BLOCK", "string-typed atc_p1 is present-and-unusable, not absent");
  assert.equal(park({ unit: { green: "false" } }), "BLOCK");
  assert.equal(park({ unit: null }), "BLOCK", "present-but-null unit is malformed evidence (no TypeError)");
  assert.equal(park({ invariants: { intact: 0 } }), "BLOCK");
  assert.equal(park({ auth_coverage: { lost: "true" } }), "BLOCK", "loose-typed auth evidence cannot slip the guard");
  assert.equal(park({}, { atc_warn_delta: "3" }), "BLOCK", "string warn delta is present-and-unusable");
  assert.equal(park({ atc_p1: 0, unit: { green: true }, auth_coverage: { lost: false } }), "PARK", "well-typed PASSING evidence never forbids PARK");
});

test("PARK is still granted for a genuine no-successor node (checkpoint conjuncts absent, not failing)", () => {
  assert.equal(nodeVerdict({ block_reason: NO_RELEASED_SUCCESSOR }, {}).verdict, "PARK");
  assert.equal(nodeVerdict({ block_reason: NO_RELEASED_SUCCESSOR, activated: false }, {}).verdict, "PARK", "not-built ≠ defect");
});

test("a non-number WARN delta fails closed (no coercion past the ratchet guard)", () => {
  assert.equal(verdict({}, { atc_warn_delta: "0" }).verdict, "BLOCK");
  assert.equal(verdict({}, { atc_warn_delta: "-3" }).verdict, "BLOCK");
  assert.equal(verdict({}, { atc_warn_delta: NaN }).verdict, "BLOCK");
});

// --- C3: the P6 ATC gate blocks priority-2 as well as priority-1 ---
// SAP's recommended transport-blocking config blocks BOTH P1 and P2 (P3 = notify only).
// atc_p2 mirrors atc_p1: a hard, fail-closed conjunct.

test("C3: a priority-2 ATC finding BLOCKs — P6 requires priority-1 AND priority-2 zero", () => {
  assert.equal(verdict({ atc_p2: 1 }).verdict, "BLOCK");
  assert.deepEqual(verdict({ atc_p2: 3 }).reasons.filter((r) => r.startsWith("atc-p2")), ["atc-p2-nonzero"]);
});

test("C3: atc_p2 fails CLOSED when its evidence is missing", () => {
  assert.equal(verdict({ atc_p2: undefined }).verdict, "BLOCK");
});

test("C3: a PRESENT P2 finding is a defect for the PARK guard; an ABSENT atc_p2 does not forbid PARK", () => {
  assert.equal(nodeVerdict({ block_reason: NO_RELEASED_SUCCESSOR, atc_p2: 5 }, {}).verdict, "BLOCK", "P2>0 is a defect, never a clean PARK");
  assert.equal(
    nodeVerdict({ block_reason: NO_RELEASED_SUCCESSOR, atc_p1: 0, atc_p2: 0, unit: { green: true }, auth_coverage: { lost: false } }, {}).verdict,
    "PARK",
    "well-typed passing evidence never forbids PARK",
  );
});
