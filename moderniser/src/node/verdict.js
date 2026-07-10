/**
 * Node verdict — the fixed GREEN / BLOCK / PARK conjunction (MODERNISER_DESIGN §3.2,
 * re-tokenised to §6.1's parity enum). There is NO author-settable soft path for the hard
 * gates (P4 invariants, ATC priority-1) [§3.2 7.1].
 *
 *   GREEN ⇔ activated ∧ reconciled ∧ atc_p1 == 0 ∧ unit.green ∧ P4.intact
 *            ∧ auth_coverage.not_lost ∧ parity ∈ {equivalent, PASS_STRUCTURAL} ∧ atc_warn_delta ≤ 0
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
 * @param {{activated?: boolean, reconciled?: boolean, atc_p1?: number, unit?: {green?: boolean}, invariants?: {intact?: boolean}, auth_coverage?: {lost?: boolean}, parity?: {verdict?: string}, block_reason?: string}} checkpoint
 * @param {{atc_warn_delta?: number}} ratchet
 * @returns {{verdict: "GREEN"|"BLOCK"|"PARK", reasons: string[]}}
 */
import { NO_RELEASED_SUCCESSOR } from "../state/node-status.js";

const PASS_PARITY = new Set(["equivalent", "PASS_STRUCTURAL"]);

export function nodeVerdict(checkpoint = {}, ratchet = {}) {
  const cp = checkpoint;
  const warn = ratchet.atc_warn_delta;

  // PARK is the deterministic no-released-successor class ONLY. It NEVER applies to a
  // P4-invariant OR a defective-output BLOCK (§3.2, L7): PARK is for a node that could not
  // even be attempted (no released successor), so its checkpoint conjuncts are ABSENT, not
  // failing. Any PRESENT failing conjunct is a defect that forces BLOCK.
  const hasDefect =
    cp.invariants?.intact === false ||
    cp.auth_coverage?.lost === true ||
    (typeof cp.atc_p1 === "number" && cp.atc_p1 > 0) ||
    cp.unit?.green === false ||
    (cp.parity !== undefined && !PASS_PARITY.has(cp.parity.verdict)) ||
    (typeof warn === "number" && warn > 0);
  if (cp.block_reason === NO_RELEASED_SUCCESSOR && !hasDefect) {
    return { verdict: "PARK", reasons: [NO_RELEASED_SUCCESSOR] };
  }

  const reasons = [];
  if (!(cp.activated === true && cp.reconciled === true)) reasons.push("not-activated-or-reconciled");
  if (cp.atc_p1 !== 0) reasons.push("atc-p1-nonzero");
  if (cp.unit?.green !== true) reasons.push("unit-not-green");
  if (cp.invariants?.intact !== true) reasons.push("p4-invariant-broken"); // fail-closed: must PROVE intact
  if (cp.auth_coverage?.lost === true) reasons.push("auth-coverage-lost"); // fail-open: block only on proven loss
  if (!PASS_PARITY.has(cp.parity?.verdict)) reasons.push(`parity-not-equivalent:${cp.parity?.verdict ?? "missing"}`);
  if (!(Number.isFinite(warn) && warn <= 0)) reasons.push("warn-delta-regressed"); // non-number/missing → fail-closed

  return reasons.length === 0 ? { verdict: "GREEN", reasons: [] } : { verdict: "BLOCK", reasons };
}
