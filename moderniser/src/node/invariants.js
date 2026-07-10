/**
 * Invariant diff — P4 preservation over a node's before/after feature bundle
 * (MODERNISER_DESIGN §3.2, §3.2 5.5, L7). Pure; the abaplint parse → feature extraction is
 * a later I/O step. Splits P4 to match the two verdict conjuncts (§3.2 verdict logic):
 *
 *   intact = P4b ∧ P4c — the structural, non-downgradeable parts:
 *     P4b  COMMIT WORK / commit-boundary count not suppressed (after ≥ before).
 *     P4c  SY-SUBRC checked after EVERY AUTHORITY-CHECK in the after (a property of the code).
 *
 *   auth_coverage.lost = P4a — auth NOT weakened, judged by COVERAGE, never statement identity
 *     (a managed RAP BO legitimately has zero AUTHORITY-CHECK; auth moves to DCL, P3). Effective
 *     scope = AUTHORITY-CHECK (object,field) pairs ∪ CDS DCL restrictions (a DCL grant covers its
 *     object for any field). LOSS = a before-covered (object,field) not covered in the after by
 *     an AUTHORITY-CHECK OR a DCL grant on that object, OR `WITH PRIVILEGED ACCESS` on a released
 *     analytical CDS that previously had row-level auth.
 *
 *   auth_delta = any auth-footprint change → an abap-security-reviewer auth-equivalence
 *     attestation is owed before PASS (persisted in node-state `attestations`).
 *
 * @param {{auth_checks?: Array<{object: string, field: string, subrc_checked?: boolean}>, dcl_restrictions?: Array<{object: string}>, commit_work?: number, privileged_cds?: Array<{object: string, had_row_auth?: boolean}>}} before
 * @param {typeof before} after
 * @returns {{intact: boolean, violations: string[], auth_coverage: {lost: boolean, lost_scopes: Array<{object: string, field: string}>}, auth_delta: boolean}}
 */
export function invariantDiff(before = {}, after = {}) {
  const b = normalise(before);
  const a = normalise(after);
  const violations = [];

  if (a.commit_work < b.commit_work) violations.push("P4b:commit-suppressed");
  if (a.auth_checks.some((c) => c.subrc_checked !== true)) violations.push("P4c:subrc-unchecked");

  const afterPairs = new Set(a.auth_checks.map(pairKey));
  const afterObjects = new Set(a.dcl_restrictions.map((d) => d.object));
  const lostScopes = b.auth_checks
    .filter((c) => !afterPairs.has(pairKey(c)) && !afterObjects.has(c.object))
    .map((c) => ({ object: c.object, field: c.field }));
  const privilegedLoss = a.privileged_cds
    .filter((c) => c.had_row_auth === true)
    .map((c) => ({ object: c.object, field: "*" }));
  const lost_scopes = [...lostScopes, ...privilegedLoss];

  const beforePairs = new Set(b.auth_checks.map(pairKey));
  const beforeObjects = new Set(b.dcl_restrictions.map((d) => d.object));
  const privKey = (c) => JSON.stringify([c.object, c.had_row_auth === true]);
  const beforePriv = new Set(b.privileged_cds.map(privKey));
  const afterPriv = new Set(a.privileged_cds.map(privKey));
  const auth_delta =
    !setEqual(beforePairs, afterPairs) || !setEqual(beforeObjects, afterObjects) || !setEqual(beforePriv, afterPriv);

  return {
    intact: violations.length === 0,
    violations,
    auth_coverage: { lost: lost_scopes.length > 0, lost_scopes },
    auth_delta,
  };
}

function normalise(x) {
  return {
    auth_checks: x.auth_checks || [],
    dcl_restrictions: x.dcl_restrictions || [],
    commit_work: x.commit_work || 0,
    privileged_cds: x.privileged_cds || [],
  };
}

const pairKey = (c) => JSON.stringify([c.object, c.field]); // separator-safe for arbitrary ids

function setEqual(x, y) {
  if (x.size !== y.size) return false;
  for (const v of x) if (!y.has(v)) return false;
  return true;
}
