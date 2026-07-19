import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { validatePlannerDigest } from "./validate-planner-digest.js";

/**
 * G5 — the planner digest (arch spec §15.8, gap #20). A deterministic, size-capped
 * STRICT projection of the analyser-findings document that the planner grounds on
 * instead of the raw findings (which does not scale to 100K LOC): used compilation-
 * unit objects only, each reduced to {object, grade, successor?, effort_tier}, plus
 * the Top-N findings by severity. Carries NO wall-clock field, so it is byte-identical
 * across runs over the same bundle. Consumers must fail-closed on validation.
 */

const DIGEST_VERSION = "1.0.0";
const DIGEST_BASENAME = "planner-digest.json";
// Members carry their owner's namespace but are not distinct repository objects
// (mirrors the orchestrator's namespace-summary exclusion) — the digest counts objects.
const MEMBER_NODE_KINDS = new Set(["method", "form"]);
const SEVERITY_RANK = { "priority-1": 0, "priority-2": 1, "priority-3": 2, info: 3 };
const CUSTOMER_NS = new Set(["Z", "Y"]);

/** @param {string} envName @param {number} fallback @returns {number} a positive-int cap */
function cap(envName, fallback) {
  const v = Number(process.env[envName]);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

const byStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Customer (Z/Y) objects first, then PageRank importance, then name/id — so the
 * modernization targets survive the cap before SAP dependency nodes. Total order. */
function objectComparator(a, b) {
  const ca = CUSTOMER_NS.has(a.namespace) ? 0 : 1;
  const cb = CUSTOMER_NS.has(b.namespace) ? 0 : 1;
  if (ca !== cb) return ca - cb;
  const ra = a.rank ?? 0, rb = b.rank ?? 0;
  if (ra !== rb) return rb - ra;
  return byStr(String(a.object), String(b.object)) || byStr(String(a.id), String(b.id));
}

/** Most severe first, then a total order over EVERY projected field (object, rule_id,
 * message, family) plus finding_id — so two findings that tie on (severity, object,
 * rule_id, finding_id) but differ in message still order deterministically. The digest's
 * finding order therefore never depends on the input order, independent of the upstream sort. */
function findingComparator(a, b) {
  const sa = SEVERITY_RANK[a.severity] ?? 99, sb = SEVERITY_RANK[b.severity] ?? 99;
  if (sa !== sb) return sa - sb;
  return byStr(String(a.object), String(b.object))
    || byStr(String(a.rule_id), String(b.rule_id))
    || byStr(String(a.message ?? ""), String(b.message ?? ""))
    || byStr(String(a.family ?? ""), String(b.family ?? ""))
    || byStr(String(a.finding_id ?? ""), String(b.finding_id ?? ""));
}

/** @param {object} n a graph node @returns {object} the §15.8 object projection */
function projectObject(n) {
  const grade = n.clean_core_grade ?? "unknown";
  const effort_tier = n.effort_tier ?? "unknown";
  return n.modernization_target
    ? { object: n.object, grade, successor: n.modernization_target, effort_tier }
    : { object: n.object, grade, effort_tier };
}

/** @param {object} f a finding @returns {object} the minimal actionable projection */
function projectFinding(f) {
  return { object: f.object, rule_id: f.rule_id, severity: f.severity, family: f.family ?? null, message: f.message };
}

/**
 * Derive the planner digest from a produced analyser-findings document. Pure.
 * @param {object} doc analyser-findings document
 * @returns {object} planner digest
 */
export function buildPlannerDigest(doc) {
  const maxObjects = cap("PLANNER_DIGEST_MAX_OBJECTS", 500);
  const maxFindings = cap("PLANNER_DIGEST_MAX_FINDINGS", 200);
  const nodes = (doc?.graph?.nodes ?? []).filter((n) => !MEMBER_NODE_KINDS.has(n.kind));
  const rankedObjects = [...nodes].sort(objectComparator);
  const rankedFindings = [...(doc?.findings ?? [])].sort(findingComparator);
  const objects = rankedObjects.slice(0, maxObjects).map(projectObject);
  const findings = rankedFindings.slice(0, maxFindings).map(projectFinding);
  return {
    digest_version: DIGEST_VERSION,
    schema_version: doc?.schema_version ?? null,
    package: doc?.package ?? "unknown",
    source_system: doc?.source_system ?? "unknown",
    source_hash: doc?.source_hash ?? null,
    config_hash: doc?.config_hash ?? null,
    run_id: doc?.run_id ?? null,
    object_count: rankedObjects.length,
    objects_included: objects.length,
    finding_count: rankedFindings.length,
    findings_included: findings.length,
    objects,
    findings,
  };
}

/** @param {string} findingsOutPath @returns {string} the sibling digest path */
export function digestPathFor(findingsOutPath) {
  return join(dirname(findingsOutPath), DIGEST_BASENAME);
}

/**
 * Build + validate + write the planner digest as pretty JSON (creates parent dirs).
 * Fail-closed: a schema-invalid digest is refused before write, exactly as writeReport
 * refuses a schema-invalid findings document.
 * @param {object} doc analyser-findings document
 * @param {string} outPath the digest path
 * @returns {string} the path written
 */
export function writeDigest(doc, outPath) {
  const digest = buildPlannerDigest(doc);
  const { valid, errors } = validatePlannerDigest(digest);
  if (!valid) {
    throw new Error(`refusing to write a schema-invalid planner digest: ${errors.slice(0, 5).join("; ")}`);
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(digest, null, 2), "utf8");
  return outPath;
}
