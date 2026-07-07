/**
 * GAP#3a — offline runtime-signal substrate (SCMON usage + SMODILOG mods).
 *
 * ADT exposes no REST endpoint for these table-level signals, so the live tools
 * report data_available:false. When an OFFLINE canonical dataset is present
 * (produced by a pluggable adapter in integrations/ from an SCMON/UPL/CCM-app
 * export, validated against this schema), the same MCP tools serve it instead —
 * identical response shape, data_available flipped true.
 *
 * The code is GENERIC over the schema: nothing about a customer's system, object
 * names, or thresholds is hardcoded. The dataset path and the retire policy are
 * config (env override, sane default). Fail-closed: a missing, malformed, or
 * schema-invalid file NEVER serves garbage — it degrades to data_available:false
 * with a stated reason, and consumers must never read that absence as "unused".
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
const DEFAULT_SIGNALS_FILE = join(DATA_DIR, "runtime-signals.json");
const DEFAULT_POLICY_FILE = join(DATA_DIR, "retire-policy.json");

/** Idle beyond idle_days, dead beyond stale_days. Named constant = the spec. */
export const DEFAULT_RETIRE_POLICY = { idle_days: 180, stale_days: 365 };

const SIGNAL_SOURCES = new Set(["scmon", "upl", "ccm-app", "smodilog"]);
const MS_PER_DAY = 86_400_000;

const USAGE_COVERAGE_NOTE =
  "Lists objects OBSERVED executing within the measured window. Absence from this " +
  "list is NOT proof an object is dead — cross-reference the object inventory and " +
  "apply the idle policy before proposing retirement.";
const MOD_COVERAGE_NOTE =
  "Lists SAP-standard objects with recorded modifications. Absence is NOT proof an " +
  "object is unmodified; do not infer cleanliness from a missing signal.";

const absent = (v) => v == null;

// ---- schema validation (the canonical contract; in-house, no ajv) ----

/**
 * @param {object} doc parsed runtime-signals dataset
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateRuntimeSignals(doc) {
  const errors = [];
  if (doc == null || typeof doc !== "object") return { valid: false, errors: ["dataset must be an object"] };
  for (const f of ["schema_version", "system", "generated_at"]) {
    if (absent(doc[f])) errors.push(`missing required header field: ${f}`);
  }
  if (doc.usage != null) validateUsageSection(doc.usage, errors);
  if (doc.modifications != null) validateModSection(doc.modifications, errors);
  return { valid: errors.length === 0, errors };
}

function validateUsageSection(usage, errors) {
  if (usage.source != null && !SIGNAL_SOURCES.has(usage.source)) errors.push(`usage.source not in {${[...SIGNAL_SOURCES].join(",")}}: ${usage.source}`);
  if (!Array.isArray(usage.rows)) { errors.push("usage.rows must be an array"); return; }
  usage.rows.forEach((r, i) => {
    for (const f of ["object_type", "object_name"]) if (absent(r?.[f])) errors.push(`usage.rows[${i}] missing ${f}`);
    if (typeof r?.exec_count !== "number" || r.exec_count < 0) errors.push(`usage.rows[${i}] exec_count must be a number >= 0`);
    if (r?.last_used != null && typeof r.last_used !== "string") errors.push(`usage.rows[${i}] last_used must be an ISO date string or null`);
  });
}

function validateModSection(mods, errors) {
  if (mods.source != null && !SIGNAL_SOURCES.has(mods.source)) errors.push(`modifications.source not in {${[...SIGNAL_SOURCES].join(",")}}: ${mods.source}`);
  if (!Array.isArray(mods.rows)) { errors.push("modifications.rows must be an array"); return; }
  mods.rows.forEach((r, i) => {
    for (const f of ["object_name", "object_type", "modified_by", "modified_on"]) if (absent(r?.[f])) errors.push(`modifications.rows[${i}] missing ${f}`);
  });
}

// ---- config resolution (path + policy are overridable; defaults ship) ----

function resolveSignalsPath() {
  return process.env.HARNESS_SIGNALS_FILE || DEFAULT_SIGNALS_FILE;
}

/** Default policy, overridable by HARNESS_RETIRE_POLICY or data/retire-policy.json. */
export function resolveRetirePolicy() {
  const path = process.env.HARNESS_RETIRE_POLICY || DEFAULT_POLICY_FILE;
  if (!existsSync(path)) return DEFAULT_RETIRE_POLICY;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return {
      idle_days: Number.isFinite(parsed.idle_days) ? parsed.idle_days : DEFAULT_RETIRE_POLICY.idle_days,
      stale_days: Number.isFinite(parsed.stale_days) ? parsed.stale_days : DEFAULT_RETIRE_POLICY.stale_days,
    };
  } catch (e) {
    // Fail-closed to the shipped default rather than crash a readiness run.
    return DEFAULT_RETIRE_POLICY;
  }
}

/**
 * Load + validate the offline dataset. Never throws.
 * @returns {{dataset: object|null, reason: string|null}}
 */
function loadDataset() {
  const path = resolveSignalsPath();
  if (!existsSync(path)) return { dataset: null, reason: null };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { dataset: null, reason: `offline signals dataset at ${path} is malformed JSON: ${e.message}` };
  }
  const { valid, errors } = validateRuntimeSignals(parsed);
  if (!valid) return { dataset: null, reason: `offline signals dataset present but failed schema validation: ${errors.join("; ")}` };
  return { dataset: parsed, reason: null };
}

// ---- retire classifier (facts derived per row; policy-driven) ----

/**
 * @param {{last_used: string|null}} row
 * @param {{idle_days: number, stale_days: number}} policy
 * @param {Date} asOf reference date (handler passes now; tests pass fixed)
 * @returns {{activity: "active"|"idle"|"stale"|"unknown", days_since_last_use: number|null}}
 */
export function classifyUsageRow(row, policy, asOf) {
  if (absent(row?.last_used)) return { activity: "unknown", days_since_last_use: null };
  const parsed = Date.parse(row.last_used);
  if (Number.isNaN(parsed)) return { activity: "unknown", days_since_last_use: null };
  const days = Math.floor((asOf.getTime() - parsed) / MS_PER_DAY);
  const activity = days <= policy.idle_days ? "active" : days <= policy.stale_days ? "idle" : "stale";
  return { activity, days_since_last_use: days };
}

// ---- tool responses (the live-path shape, data-backed when present) ----

/**
 * @param {{window_days?: number, package_name?: string}} params
 * @param {Date} [asOf]
 */
export function usageResponse(params = {}, asOf = new Date()) {
  const { dataset, reason } = loadDataset();
  if (!dataset?.usage) {
    return {
      executed_objects: [],
      window_days: params.window_days ?? 90,
      measurement_start: "",
      data_available: false,
      reason: reason ?? "SCMON is not exposed via the ADT REST protocol and no offline usage dataset is present (set HARNESS_SIGNALS_FILE or add data/runtime-signals.json)",
      coverage_note: "No usage signal available; do NOT infer retirement from this absence.",
    };
  }
  return shapeUsage(dataset, params, asOf);
}

function shapeUsage(dataset, params, asOf) {
  const policy = resolveRetirePolicy();
  const wanted = params.package_name ? String(params.package_name).toUpperCase() : null;
  const executed = dataset.usage.rows
    .filter((r) => !wanted || String(r.package ?? "").toUpperCase() === wanted)
    .map((r) => ({ ...r, ...classifyUsageRow(r, policy, asOf) }));
  return {
    executed_objects: executed,
    window_days: dataset.usage.window_days ?? null,
    requested_window_days: params.window_days ?? null,
    measurement_start: dataset.usage.measurement_start ?? "",
    data_available: true,
    source: dataset.usage.source ?? "unknown",
    system: dataset.system,
    generated_at: dataset.generated_at,
    retire_policy: policy,
    coverage_note: USAGE_COVERAGE_NOTE,
  };
}

/**
 * @param {{package_name?: string, date_from?: string}} params
 */
export function modificationsResponse(params = {}) {
  const { dataset, reason } = loadDataset();
  if (!dataset?.modifications) {
    return {
      modifications: [],
      data_available: false,
      package_name: params.package_name ?? "",
      date_from: params.date_from ?? "",
      reason: reason ?? "SMODILOG is not exposed via the ADT REST protocol and no offline modification dataset is present (set HARNESS_SIGNALS_FILE or add data/runtime-signals.json)",
      coverage_note: "No modification signal available; do NOT infer cleanliness from this absence.",
    };
  }
  const wanted = params.package_name ? String(params.package_name).toUpperCase() : null;
  const since = params.date_from || null;
  const rows = dataset.modifications.rows
    .filter((r) => !wanted || String(r.package ?? "").toUpperCase() === wanted)
    .filter((r) => !since || String(r.modified_on ?? "") >= since);
  return {
    modifications: rows,
    data_available: true,
    package_name: params.package_name ?? "",
    date_from: params.date_from ?? "",
    source: dataset.modifications.source ?? "unknown",
    system: dataset.system,
    generated_at: dataset.generated_at,
    coverage_note: MOD_COVERAGE_NOTE,
  };
}
