/**
 * Node verdict — the fixed GREEN / BLOCK / PARK conjunction (MODERNISER_DESIGN §3.2,
 * re-tokenised to §6.1's parity enum). There is NO author-settable soft path for the hard
 * gates (P4 invariants, ATC priority-1) [§3.2 7.1].
 *
 *   GREEN ⇔ activated ∧ reconciled ∧ atc_p1 == 0 ∧ atc_p2 == 0 ∧ unit.green ∧ P4.intact
 *            ∧ auth_coverage.not_lost
 *            ∧ (auth_delta ⇒ attested_auth)   — L7 attestation conjunct (wired 2026-07-13, D1)
 *            ∧ (parity ∈ {equivalent, PASS_STRUCTURAL} ∨ attested(needs_review))   — §6.1 attestation branch
 *            ∧ atc_warn_delta ≤ 0
 *   BLOCK ⇔ any conjunct false
 *   PARK  ⇔ BLOCK whose reason is the deterministic NO_RELEASED_SUCCESSOR — never a P4/defect BLOCK
 *
 * Every hard conjunct fails CLOSED: missing evidence counts as failure, never a
 * fall-through pass ("any tool that errors or returns no result ⇒ FAIL", §3.2 5.3). Auth is
 * the one fail-OPEN conjunct — L7 blocks only on PROVEN coverage loss, so a missing/empty
 * auth delta does not block (a managed RAP BO legitimately has no AUTHORITY-CHECK; auth
 * moves to DCL). The WARN-delta conjunct is delta-vs-own-baseline (seed ∞ established by the
 * ratchet gate, §6.4); node_verdict only checks the already-computed delta is ≤ 0.
 *
 * Pure. No I/O.
 *
 * @param {{activated?: boolean, reconciled?: boolean, atc_p1?: number, atc_p2?: number, unit?: {green?: boolean}, invariants?: {intact?: boolean}, auth_coverage?: {lost?: boolean}, parity?: {verdict?: string}, block_reason?: string}} checkpoint
 * @param {{atc_warn_delta?: number}} ratchet
 * @returns {{verdict: "GREEN"|"BLOCK"|"PARK", reasons: string[]}}
 */
import { NO_RELEASED_SUCCESSOR } from "../state/node-status.js";

const PASS_PARITY = new Set(["equivalent", "PASS_STRUCTURAL"]);

/**
 * The parity conjunct with the ATTESTATION branch (operator-ratified 2026-07-12, §6.1):
 * a `needs_review` gray band is satisfied by a named human attestation recorded through
 * the audited PARITY_REVIEW decision path (`attestations.parity_equivalence` — injected
 * by the CLI from the escalations register ONLY, never trusted from a checkpoint file).
 * Mirrors the AUTH pattern: attestation is EXTRA evidence on top of green machine
 * conjuncts, never a substitute — vetoes and `scope_reduced` are NEVER attestable (7.5).
 */
function passesParity(cp) {
  const v = cp.parity?.verdict;
  if (PASS_PARITY.has(v)) return true;
  if (v !== "needs_review") return false; // vetoes / scope_reduced / missing: no attestation applies
  const att = cp.attestations?.parity_equivalence;
  return typeof att === "string" && att.length > 0;
}

/**
 * The AUTH-attestation conjunct (operator-ratified 2026-07-13, D1 — L7: "on any non-empty
 * auth delta, an abap-security-reviewer must sign an auth-equivalence attestation before
 * PASS"). Mirrors parity: the attestation is joined from the audited AUTH_EQUIVALENCE
 * register row ONLY (the CLI overwrites checkpoint-supplied fields), extra evidence on top
 * of the green machine conjuncts, never a substitute. No footprint change → nothing owed.
 */
function passesAuth(cp) {
  if (cp.invariants?.auth_delta !== true) return true;
  const att = cp.attestations?.auth_equivalence;
  return typeof att === "string" && att.length > 0;
}

export function nodeVerdict(checkpoint = {}, ratchet = {}) {
  const cp = checkpoint;
  const warn = ratchet.atc_warn_delta;

  // PARK is the deterministic no-released-successor class ONLY. It NEVER applies to a
  // P4-invariant OR a defective-output BLOCK (§3.2, L7): PARK is for a node that could not
  // even be attempted (no released successor), so its checkpoint conjuncts are ABSENT, not
  // failing. "Absent" means the KEY is absent (L9 review): present-but-malformed evidence
  // (string atc_p1, loose-typed booleans, null objects) is a defect, never an absence —
  // otherwise a corrupt checkpoint file slips the guard the strict GREEN checks would block.
  const present = (x) => x !== undefined;
  const hasDefect =
    (present(cp.invariants) && cp.invariants?.intact !== true) ||
    (present(cp.auth_coverage) && cp.auth_coverage?.lost !== false) ||
    (present(cp.atc_p1) && cp.atc_p1 !== 0) ||
    (present(cp.atc_p2) && cp.atc_p2 !== 0) || // C3: priority-2 is a defect just like priority-1
    (present(cp.unit) && cp.unit?.green !== true) ||
    (present(cp.parity) && !passesParity(cp)) ||
    !passesAuth(cp) || // an unattested footprint change was ATTEMPTED — never a clean PARK (D1)
    (present(warn) && !(Number.isFinite(warn) && warn <= 0));
  if (cp.block_reason === NO_RELEASED_SUCCESSOR && !hasDefect) {
    return { verdict: "PARK", reasons: [NO_RELEASED_SUCCESSOR] };
  }

  const reasons = [];
  if (!(cp.activated === true && cp.reconciled === true)) reasons.push("not-activated-or-reconciled");
  if (cp.atc_p1 !== 0) reasons.push("atc-p1-nonzero");
  if (cp.atc_p2 !== 0) reasons.push("atc-p2-nonzero"); // C3 (P6): SAP blocks transport on P1 AND P2; fail-closed (missing → nonzero → block)
  if (cp.unit?.green !== true) reasons.push("unit-not-green");
  if (cp.invariants?.intact !== true) reasons.push("p4-invariant-broken"); // fail-closed: must PROVE intact
  if (cp.auth_coverage?.lost === true) reasons.push("auth-coverage-lost"); // fail-open: block only on proven loss
  if (!passesAuth(cp)) reasons.push("auth-delta-unattested"); // L7: attestation owed BEFORE PASS (D1)
  if (!passesParity(cp)) reasons.push(`parity-not-equivalent:${cp.parity?.verdict ?? "missing"}`);
  if (!(Number.isFinite(warn) && warn <= 0)) reasons.push("warn-delta-regressed"); // non-number/missing → fail-closed

  return reasons.length === 0 ? { verdict: "GREEN", reasons: [] } : { verdict: "BLOCK", reasons };
}

/**
 * The OFFLINE sibling of nodeVerdict (MODERNISER_DRIVER_AND_GAP2_DESIGN BUILD SPEC Phase 2).
 * Offline NEVER GREENs (P6): activation, reconciliation, and ABAP Unit need a live DEV tier, so
 * a byte-identical nodeVerdict would always BLOCK on `not-activated-or-reconciled`. offlineVerdict
 * therefore PARTITIONS the conjuncts — it EXCLUDES the three DEV-only ones (activated, reconciled,
 * unit) and enforces the offline-computable ones: atc_p1 AND atc_p2 (both asserted 0 — C3/P6),
 * invariants.intact, auth_coverage.lost, the auth_delta→attestation conjunct, parity, and
 * warn_delta. Every hard conjunct still fails CLOSED; auth stays the one fail-OPEN conjunct.
 *
 * A full pass is PROVISIONAL (a provisional-pass floor pending live confirmation), never GREEN.
 * The checkpoint shape is IDENTICAL to nodeVerdict's — only the producer (an offline extractor)
 * and this reduced conjunct set differ.
 *
 * Pure. No I/O.
 * @param {object} checkpoint same shape as nodeVerdict; activated/reconciled/unit are ignored
 * @param {{atc_warn_delta?: number}} ratchet
 * @returns {{verdict: "PROVISIONAL"|"BLOCK"|"PARK", reasons: string[]}}
 */
export function offlineVerdict(checkpoint = {}, ratchet = {}) {
  const cp = checkpoint;
  const warn = ratchet.atc_warn_delta;
  const present = (x) => x !== undefined;
  // The PARK class mirrors nodeVerdict, minus the DEV-only `unit` defect (offline can't run it).
  const hasDefect =
    (present(cp.invariants) && cp.invariants?.intact !== true) ||
    (present(cp.auth_coverage) && cp.auth_coverage?.lost !== false) ||
    (present(cp.atc_p1) && cp.atc_p1 !== 0) ||
    (present(cp.atc_p2) && cp.atc_p2 !== 0) || // C3: priority-2 is a defect just like priority-1
    (present(cp.parity) && !passesParity(cp)) ||
    !passesAuth(cp) ||
    (present(warn) && !(Number.isFinite(warn) && warn <= 0));
  if (cp.block_reason === NO_RELEASED_SUCCESSOR && !hasDefect) {
    return { verdict: "PARK", reasons: [NO_RELEASED_SUCCESSOR] };
  }

  const reasons = [];
  if (cp.atc_p1 !== 0) reasons.push("atc-p1-nonzero");
  if (cp.atc_p2 !== 0) reasons.push("atc-p2-nonzero"); // C3 (P6): P1 AND P2 both hard-block; fail-closed
  if (cp.invariants?.intact !== true) reasons.push("p4-invariant-broken");
  if (cp.auth_coverage?.lost === true) reasons.push("auth-coverage-lost");
  if (!passesAuth(cp)) reasons.push("auth-delta-unattested");
  if (!passesParity(cp)) reasons.push(`parity-not-equivalent:${cp.parity?.verdict ?? "missing"}`);
  if (!(Number.isFinite(warn) && warn <= 0)) reasons.push("warn-delta-regressed");

  return reasons.length === 0 ? { verdict: "PROVISIONAL", reasons: [] } : { verdict: "BLOCK", reasons };
}
