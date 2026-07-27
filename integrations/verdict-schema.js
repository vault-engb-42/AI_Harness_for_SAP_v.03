/**
 * GAP#1a — strict validator for the five gate-verdict files the /abap-validate
 * lane produces (specs/reviews/*-verdict.json). They are LLM-agent-emitted to a
 * prose schema, so a downstream adapter (CI gate, ALM ticketing) cannot trust the
 * shape without this. In-house (no ajv), mirroring analyser/src/validate-findings.js;
 * the JSON-Schema companion is .claude/schemas/verdict.schema.json.
 *
 * Two idioms, honoured per file (do NOT unify): sap-verdict + design-critique key
 * on a string `verdict` (PASS/WARN/BLOCK); clean-core + security + diff-review key
 * on a boolean `pass`. Enum casing is per-file by design and is not normalised.
 */

const VERDICT3 = new Set(["PASS", "WARN", "BLOCK"]);
const FINDING_LEVEL = new Set(["BLOCK", "WARN", "INFO"]);
const FAILURE_LAYER = new Set(["activation", "atc", "atc-unavailable", "abapunit", "invariant", "infrastructure"]);
const CLEAN_CORE_LEVEL = new Set(["A", "not-A"]);

/** A required field is missing when null OR undefined. */
const absent = (v) => v == null;
/** An enum field is invalid when present and non-null but outside the allowed set. */
const badEnum = (o, k, allowed) => o != null && o[k] != null && !allowed.has(o[k]);

/**
 * @param {"sap"|"clean-core"|"security"|"design-critique"|"diff-review"} kind
 * @param {object} doc the produced verdict document
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateVerdict(kind, doc) {
  const fn = VALIDATORS[kind];
  if (!fn) return { valid: false, errors: [`unknown verdict kind: ${kind}`] };
  const errors = [];
  fn(doc, errors);
  return { valid: errors.length === 0, errors };
}

/** Shared: require every named top-level field to be present and non-null. */
function requireFields(doc, fields, label, errors) {
  for (const f of fields) if (absent(doc?.[f])) errors.push(`${label} missing required field: ${f}`);
}

/** Shared: gate const + boolean pass + findings[].level enum (clean-core/security/diff). */
function passStyle(doc, gateConst, label, errors) {
  if (doc?.gate !== gateConst) errors.push(`${label} gate must be "${gateConst}"`);
  if (typeof doc?.pass !== "boolean") errors.push(`${label} pass must be a boolean`);
  if (doc?.findings != null && !Array.isArray(doc.findings)) errors.push(`${label} findings must be an array`);
  else if (Array.isArray(doc?.findings)) {
    doc.findings.forEach((f, i) => { if (badEnum(f, "level", FINDING_LEVEL)) errors.push(`${label} findings[${i}] bad level: ${f.level}`); });
  }
}

function validateSap(doc, errors) {
  requireFields(doc, ["verdict", "timestamp", "connection", "objects", "activation", "atc", "abap_unit", "clean_core_level", "invariant_diff", "ratchet"], "sap-verdict", errors);
  if (doc?.verdict != null && !VERDICT3.has(doc.verdict)) errors.push(`sap-verdict bad verdict: ${doc.verdict}`);
  // failure_layer is required as a KEY but may be null (PASS) — check presence + enum, not absence.
  if (!doc || !("failure_layer" in doc)) errors.push("sap-verdict missing required field: failure_layer");
  else if (doc.failure_layer != null && !FAILURE_LAYER.has(doc.failure_layer)) errors.push(`sap-verdict bad failure_layer: ${doc.failure_layer}`);
  if (badEnum(doc, "clean_core_level", CLEAN_CORE_LEVEL)) errors.push(`sap-verdict bad clean_core_level: ${doc.clean_core_level}`);
  if (doc?.atc != null && !Array.isArray(doc.atc.priority1)) errors.push("sap-verdict atc.priority1 must be an array");
  // C3 (P6): priority-2 is a distinct hard-block tier; require it as an array when atc is present (fail-closed, mirrors priority1).
  if (doc?.atc != null && !Array.isArray(doc.atc.priority2)) errors.push("sap-verdict atc.priority2 must be an array");
  if (doc?.invariant_diff != null) {
    // commit_entities_suppressed: P4(b) RAP save — the pre-write hook fires `commit-entities-suppressed`
    // (.claude/hooks/lib/abap-checks.js); this is its home in the proof bundle, co-equal with the classic
    // commit_work_suppressed. Fail-closed: a missing flag reads as non-boolean and is rejected.
    for (const k of ["authority_check_weakened", "commit_work_suppressed", "commit_entities_suppressed", "sy_subrc_check_dropped"]) {
      if (typeof doc.invariant_diff[k] !== "boolean") errors.push(`sap-verdict invariant_diff.${k} must be a boolean`);
    }
  }
  // G10: published_services — SRVB delivery proof (published OData URL + $metadata reachability).
  // Optional (a CDS-/class-only change publishes nothing), but fail-closed WHEN present: an SRVB whose
  // $metadata is unreachable is not delivered, and reachability may not be faked by omitting the flag.
  if (doc?.published_services != null) {
    if (!Array.isArray(doc.published_services)) errors.push("sap-verdict published_services must be an array");
    else doc.published_services.forEach((s, i) => {
      for (const k of ["service_binding", "service_url"]) if (absent(s?.[k])) errors.push(`sap-verdict published_services[${i}].${k} is required`);
      if (typeof s?.metadata_reachable !== "boolean") errors.push(`sap-verdict published_services[${i}].metadata_reachable must be a boolean`);
    });
  }
}

function validateCleanCore(doc, errors) {
  passStyle(doc, "clean-core", "clean-core-verdict", errors);
  requireFields(doc, ["atc", "grounding", "summary"], "clean-core-verdict", errors);
}

function validateSecurity(doc, errors) {
  passStyle(doc, "security", "security-verdict", errors);
  requireFields(doc, ["invariants", "summary"], "security-verdict", errors);
  const inv = doc?.invariants;
  if (inv != null) {
    // commit_entities: P4(b) RAP save status, co-equal with commit_work (the classic save). See sapVerdict.
    for (const k of ["authority_check", "commit_work", "commit_entities", "sy_subrc"]) if (absent(inv[k])) errors.push(`security-verdict invariants.${k} is required`);
    if (typeof inv.baseline_established !== "boolean") errors.push("security-verdict invariants.baseline_established must be a boolean");
  }
}

function validateDiff(doc, errors) {
  passStyle(doc, "abap-diff-review", "diff-review-verdict", errors);
  requireFields(doc, ["range", "acceptance_criteria_source", "summary"], "diff-review-verdict", errors);
}

function validateDesign(doc, errors) {
  requireFields(doc, ["story_id", "iteration", "timestamp", "scores", "weighted_average", "threshold", "verdict", "failing_criteria", "grounding", "critique"], "design-critique", errors);
  if (doc?.verdict != null && !VERDICT3.has(doc.verdict)) errors.push(`design-critique bad verdict: ${doc.verdict}`);
  if (doc?.scores != null) {
    for (const k of ["cds_modelling", "rap_behavior", "extensibility_tier", "released_api", "namespace", "blast_radius"]) {
      const v = doc.scores[k];
      if (typeof v !== "number" || v < 1 || v > 10) errors.push(`design-critique scores.${k} must be an integer 1-10`);
    }
  }
}

const VALIDATORS = {
  sap: validateSap,
  "clean-core": validateCleanCore,
  security: validateSecurity,
  "design-critique": validateDesign,
  "diff-review": validateDiff,
};
