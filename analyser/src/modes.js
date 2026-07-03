import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { callAdtTool } from "../../mcp-adt-bridge/adt-client.js";

/**
 * Tri-modal source acquisition for the analyser (arch doc §10):
 *   - offline-bundle:   read a flat directory of source files from disk
 *   - live-via-engine:  pull object list + source from the real MCP-ADT
 *                       sidecar (read-only tools), then parse locally
 *   - live-via-ADT:     no local parse — ATC + migration analysis only
 *                       (docFromAdtOnly), producing the subset document
 *
 * The live functions make real HTTP calls via the bridge's adt-client to the
 * sidecar at ADT_MCP_URL. They are exercised end-to-end in the test:live
 * suite against the real sidecar; there are no test doubles for them.
 */

/** Source-file extensions the Registry can type from the filename. */
const BUNDLE_EXTENSIONS = [".abap", ".asddls", ".asbdef", ".acds"];

/** ADT object type -> abapGit filename suffix for locally-parsed live pulls. */
const TYPE_TO_SUFFIX = {
  CLAS: ".clas.abap",
  INTF: ".intf.abap",
  PROG: ".prog.abap",
  FUGR: ".fugr.abap",
  DDLS: ".ddls.asddls",
  BDEF: ".bdef.asbdef",
};

/**
 * Read all analysable source files from a flat bundle directory.
 * @param {string} dirPath
 * @returns {Array<{filename: string, source: string}>}
 */
export function filesFromBundle(dirPath) {
  let entries;
  try {
    entries = readdirSync(dirPath);
  } catch (e) {
    throw new Error(`bundle path not readable: ${dirPath} (${e.message}) — pass a directory containing *.abap / *.ddls.asddls / *.bdef.asbdef files`);
  }
  const files = [];
  for (const name of entries) {
    const full = join(dirPath, name);
    if (!statSync(full).isFile()) continue;
    if (!BUNDLE_EXTENSIONS.some((ext) => name.endsWith(ext))) continue;
    files.push({ filename: name, source: readFileSync(full, "utf8") });
  }
  return files;
}

/**
 * Pull a package's objects + source from the live sidecar (read-only tools)
 * and map them onto abapGit filenames for local parsing.
 * @param {NodeJS.ProcessEnv} env carries ADT_MCP_URL + X-SAP-* credentials
 * @param {string} packageName
 * @returns {Promise<{files: Array<{filename: string, source: string}>, skipped: string[]}>}
 */
export async function filesFromLiveSystem(env, packageName) {
  const listing = await callAdtTool("aws_abap_cb_get_objects", { package_name: packageName }, env);
  const objects = normalizeObjectList(listing);
  const files = [];
  const skipped = [];
  for (const obj of objects) {
    const suffix = TYPE_TO_SUFFIX[obj.type];
    if (!suffix) {
      skipped.push(`${obj.name} (${obj.type})`);
      continue;
    }
    const res = await callAdtTool("aws_abap_cb_get_source", { object_name: obj.name, object_type: obj.type }, env);
    const source = typeof res?.source === "string" ? res.source : "";
    if (!source) {
      skipped.push(`${obj.name} (${obj.type}: empty source)`);
      continue;
    }
    // abapGit filename convention encodes registered-namespace slashes as '#'
    // (/NS/CL_X -> #ns#cl_x.clas.abap); a raw slash would make abaplint drop
    // the namespace and misclassify vendor code as SAP standard.
    const base = obj.name.toLowerCase().replace(/\//g, "#");
    files.push({ filename: `${base}${suffix}`, source });
  }
  return { files, skipped };
}

/**
 * Tolerant mapping of the sidecar's get_objects result to {name, type} pairs.
 * @param {*} listing
 * @returns {Array<{name: string, type: string}>}
 */
function normalizeObjectList(listing) {
  const arr = Array.isArray(listing) ? listing : listing?.objects ?? listing?.result ?? [];
  const out = [];
  for (const o of arr) {
    const name = o?.object_name ?? o?.name ?? o?.OBJ_NAME;
    const type = o?.object_type ?? o?.type ?? o?.OBJECT_TYPE;
    if (name && type) out.push({ name: String(name).toUpperCase(), type: String(type).toUpperCase() });
  }
  return out;
}

/**
 * live-via-ADT subset mode: no local parse — run ATC + migration analysis on
 * the live system and assemble a schema-valid findings document with an empty
 * graph and an explicit coverage note.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} packageName
 * @param {{source_system?: string, generated_at?: string}} [opts]
 * @returns {Promise<object>}
 */
export async function docFromAdtOnly(env, packageName, opts = {}) {
  const atc = await callAdtTool("aws_abap_cb_run_atc_check", { package_name: packageName, check_variant: "ABAP_CLEAN_CORE_DEVELOPMENT" }, env);
  const migration = await callAdtTool("aws_abap_cb_get_migration_analysis", { object_name: packageName, object_type: "DEVC" }, env);
  return {
    source_system: opts.source_system ?? "unknown",
    package: packageName,
    generated_at: opts.generated_at ?? new Date().toISOString(),
    coverage_note:
      "live-via-ADT subset: findings from run_atc_check + readiness from get_migration_analysis; no local parse, so graph/blast_radius are empty — use analyse_source_system for the full graph.",
    findings: normalizeAtcFindings(atc),
    s4_readiness: normalizeMigrationSummary(migration),
    graph: { nodes: [], edges: [] },
    blast_radius: [],
  };
}

/** @param {*} atc @returns {object[]} schema findings from a tolerant ATC shape */
function normalizeAtcFindings(atc) {
  const arr = atc?.findings ?? atc?.issues ?? atc?.results ?? [];
  const prio = (p) => (p === 1 || p === "1" ? "priority-1" : p === 2 || p === "2" ? "priority-2" : p === 3 || p === "3" ? "priority-3" : "info");
  return arr.map((f) => ({
    rule_id: String(f?.check_id ?? f?.check ?? f?.rule_id ?? "atc"),
    severity: prio(f?.priority),
    object: String(f?.object_name ?? f?.object ?? "unknown"),
    message: String(f?.message ?? f?.text ?? ""),
    family: "atc",
  }));
}

/** @param {*} m @returns {object} schema s4_readiness from a tolerant migration shape */
function normalizeMigrationSummary(m) {
  const s = m?.summary ?? m ?? {};
  // Finite-guard every count: a non-numeric sidecar value must never become
  // NaN (which JSON-serializes to null and violates the schema).
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const released = num(s.released ?? s.released_hits);
  const deprecated = num(s.deprecated ?? s.deprecated_hits);
  const notReleased = num(s.not_released ?? s.not_released_hits);
  const total = released + deprecated + notReleased;
  return {
    s4_readiness_pct: total > 0 ? Math.round((released / total) * 100) : 100,
    released_hits: released,
    deprecated_hits: deprecated,
    not_released_hits: notReleased,
    total_api_calls: total,
  };
}
