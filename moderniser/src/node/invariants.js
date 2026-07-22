/**
 * Invariant diff — P4 preservation over a node's before/after feature bundle
 * (MODERNISER_DESIGN §3.2, §3.2 5.5, L7). Pure; the feature extraction that produces each side is
 * BUILT in gap-2b — `extract/bundle.js` → `invariantInput(bundle)` yields exactly the 4 fields
 * below. Splits P4 to match the two verdict conjuncts (§3.2 verdict logic):
 *
 *   intact = P4b ∧ P4c — the structural, non-downgradeable parts:
 *     P4b  COMMIT WORK / commit-boundary count not suppressed (after ≥ before).
 *     P4c  SY-SUBRC checked after EVERY AUTHORITY-CHECK in the after (a property of the code).
 *
 *   auth_coverage.lost = P4a — auth NOT weakened, judged by COVERAGE, never statement identity
 *     (a managed RAP BO legitimately has zero AUTHORITY-CHECK; auth moves to DCL, P3). Effective
 *     scope = AUTHORITY-CHECK (object,field) pairs ∪ CDS DCL restrictions (a DCL grant covers its
 *     object for any field) ∪ BDEF `authorization master|dependent` clauses. LOSS = a before-covered
 *     (object,field) not covered in the after by an AUTHORITY-CHECK OR a DCL grant on that object,
 *     OR a before-DCL object with neither an after-DCL nor an after-check on it (F13), OR a
 *     before-BDEF authorization clause whose entity is unauthorized in the after, OR an INTRODUCED
 *     CDS authorization bypass on a view that had row-level auth — pre-existing privileged access
 *     is carried debt, never re-counted (L6.2, F14).
 *
 *     B6.5: the BDEF clause joined this set because CLAUDE.md P4a NAMES it as the RAP authorization
 *     gate, yet deleting it used to change nothing in the extracted bundle. The same remediation
 *     added grant-form awareness: a DCL restriction is NOT lost while the after still grants on the
 *     same ENTITY by any form, so the SAP-recommended `pfcg_auth` → `inheriting conditions`
 *     migration reads as continuity instead of a false auth-loss BLOCK.
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
  const afterCheckObjects = new Set(a.auth_checks.map((c) => c.object));
  const lostScopes = b.auth_checks
    .filter((c) => !afterPairs.has(pairKey(c)) && !afterObjects.has(c.object))
    .map((c) => ({ object: c.object, field: c.field }));
  // A before-DCL restriction is before-covered scope (docstring: pairs ∪ DCL). Removed with
  // no after-DCL and no after-check on the object → the row-level auth is GONE (F13). A grant on
  // the same ENTITY in ANY form still covers it: the condition moved, the authorization did not.
  const afterGrantEntities = new Set(a.dcl_grants.map((g) => g.entity));
  const dclLoss = b.dcl_restrictions
    .filter((d) => !afterObjects.has(d.object) && !afterCheckObjects.has(d.object) && !afterGrantEntities.has(d.entity))
    .map((d) => ({ object: d.object, field: "*" }));
  // P4a's RAP gate: a behaviour definition that had an `authorization` clause and no longer does
  // has had its authorization switched OFF, whatever else the bundle still contains.
  const afterAuthEntities = new Set(a.auth_bdef.map((x) => x.entity));
  const bdefLoss = b.auth_bdef
    .filter((x) => !afterAuthEntities.has(x.entity))
    .map((x) => ({ object: x.entity, field: "*" }));
  // Only INTRODUCED privileged access is loss — a before-privileged object is carried debt,
  // not re-counted every diff (L6.2; an unchanged bundle must never read as a loss, F14).
  const beforePrivObjects = new Set(b.privileged_cds.map((c) => c.object));
  const privilegedLoss = a.privileged_cds
    .filter((c) => c.had_row_auth === true && !beforePrivObjects.has(c.object))
    .map((c) => ({ object: c.object, field: "*" }));
  const lost_scopes = [...lostScopes, ...dclLoss, ...bdefLoss, ...privilegedLoss];

  const beforePairs = new Set(b.auth_checks.map(pairKey));
  const beforeObjects = new Set(b.dcl_restrictions.map((d) => d.object));
  const privKey = (c) => JSON.stringify([c.object, c.had_row_auth === true]);
  const beforePriv = new Set(b.privileged_cds.map(privKey));
  const afterPriv = new Set(a.privileged_cds.map(privKey));
  // The RAP gate's footprint: entity + mode + scope, so narrowing `global` to `instance` — a real
  // authorization change that loses no entity — still owes an attestation instead of passing silently.
  const bdefKey = (x) => JSON.stringify([x.entity, x.mode, x.scope]);
  const grantKey = (g) => JSON.stringify([g.entity, g.form]);
  const auth_delta =
    !setEqual(beforePairs, afterPairs) ||
    !setEqual(beforeObjects, afterObjects) ||
    !setEqual(beforePriv, afterPriv) ||
    !setEqual(new Set(b.auth_bdef.map(bdefKey)), new Set(a.auth_bdef.map(bdefKey))) ||
    !setEqual(new Set(b.dcl_grants.map(grantKey)), new Set(a.dcl_grants.map(grantKey)));

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
    dcl_grants: x.dcl_grants || [],
    auth_bdef: x.auth_bdef || [],
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
