/**
 * Focused validator for the planner-digest schema — enforces the required fields
 * and enums the planner grounds on. In-house (no ajv dependency); mirrors
 * .claude/schemas/planner-digest.schema.json. Fail-closed: writeDigest refuses a
 * digest this rejects, exactly as writeReport refuses a schema-invalid findings doc.
 */

const GRADE = new Set(["A", "B", "C", "D", "unknown"]);
const TIER = new Set(["retire", "re-platform", "keep-and-clean", "unknown"]);
const SEVERITY = new Set(["priority-1", "priority-2", "priority-3", "info"]);
const OBJECT_KEYS = new Set(["object", "grade", "successor", "effort_tier"]);
const FINDING_KEYS = new Set(["object", "rule_id", "severity", "family", "message"]);

/** A required field is missing when null OR undefined. */
const absent = (v) => v == null;

/**
 * @param {object} digest a produced planner-digest document
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validatePlannerDigest(digest) {
  const errors = [];
  for (const f of ["digest_version", "package", "source_system", "object_count", "finding_count", "objects", "findings"]) {
    if (absent(digest?.[f])) errors.push(`missing required top-level field: ${f}`);
  }
  for (const c of ["object_count", "objects_included", "finding_count", "findings_included"]) {
    const v = digest?.[c];
    if (v !== undefined && (!Number.isInteger(v) || v < 0)) errors.push(`${c} must be a non-negative integer: ${v}`);
  }
  validateObjects(digest?.objects, errors);
  validateDigestFindings(digest?.findings, errors);
  // truncation counts must be internally consistent: the retained slice never exceeds the total.
  if (Array.isArray(digest?.objects) && Number.isInteger(digest?.object_count) && digest.objects.length > digest.object_count) {
    errors.push(`objects.length ${digest.objects.length} exceeds object_count ${digest.object_count}`);
  }
  if (Array.isArray(digest?.findings) && Number.isInteger(digest?.finding_count) && digest.findings.length > digest.finding_count) {
    errors.push(`findings.length ${digest.findings.length} exceeds finding_count ${digest.finding_count}`);
  }
  return { valid: errors.length === 0, errors };
}

function validateObjects(objects, errors) {
  if (!Array.isArray(objects)) return void errors.push("objects is not an array");
  objects.forEach((o, i) => {
    for (const r of ["object", "grade", "effort_tier"]) if (absent(o?.[r])) errors.push(`objects[${i}] missing ${r}`);
    if (o?.grade != null && !GRADE.has(o.grade)) errors.push(`objects[${i}] bad grade: ${o.grade}`);
    if (o?.effort_tier != null && !TIER.has(o.effort_tier)) errors.push(`objects[${i}] bad effort_tier: ${o.effort_tier}`);
    if (o && "successor" in o && typeof o.successor !== "string") errors.push(`objects[${i}] successor must be a string`);
    for (const k of Object.keys(o ?? {})) if (!OBJECT_KEYS.has(k)) errors.push(`objects[${i}] unexpected key: ${k}`);
  });
}

function validateDigestFindings(findings, errors) {
  if (!Array.isArray(findings)) return void errors.push("findings is not an array");
  findings.forEach((f, i) => {
    for (const r of ["object", "rule_id", "severity", "message"]) if (absent(f?.[r])) errors.push(`findings[${i}] missing ${r}`);
    if (f?.severity != null && !SEVERITY.has(f.severity)) errors.push(`findings[${i}] bad severity: ${f.severity}`);
    if (f && "family" in f && f.family !== null && typeof f.family !== "string") errors.push(`findings[${i}] family must be a string or null`);
    for (const k of Object.keys(f ?? {})) if (!FINDING_KEYS.has(k)) errors.push(`findings[${i}] unexpected key: ${k}`);
  });
}
