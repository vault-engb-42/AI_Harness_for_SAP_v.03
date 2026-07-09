import { objectsOf } from "./abaplint-loader.js";
import { severityForAbaplintRule, familyForAbaplintRule } from "./finding-severity.js";

/**
 * Adapter over abaplint's built-in rule set (~185 rules incl. cloud_types).
 * Runs the registry's configured rules and maps each Issue onto the
 * analyser-findings schema `findings` shape. We reuse these rules rather than
 * re-implement them; the ported TALOS rules (C4c/C4d) cover only what abaplint
 * lacks.
 */

/**
 * @param {import("@abaplint/core").Registry} reg a parsed Registry
 * @returns {Array<object>} schema `findings` items
 */
export function runAbaplintRules(reg) {
  const fileIndex = buildFileIndex(reg);
  try {
    return reg.findIssues().map((issue) => toFinding(issue, fileIndex));
  } catch {
    // abaplint can crash internally on some malformed source (e.g. the abapdoc
    // rule on a condensed class). The registry-wide run aborts, so fall back to
    // per-object isolation — a single bad object must never abort the whole scan
    // (fail-closed, arch spec §10).
    return runPerObjectIsolated(reg, fileIndex);
  }
}

/**
 * Fail-closed fallback: run abaplint one object at a time so a crash is confined
 * to that object (degraded to an engine-error diagnostic) while every other
 * object is still analyzed. Cross-object rules are lost in this degraded mode —
 * an acceptable trade when the registry-wide run already crashed.
 * @param {import("@abaplint/core").Registry} reg
 * @param {Map<string, {object: string, object_type: string}>} fileIndex
 * @returns {Array<object>}
 */
function runPerObjectIsolated(reg, fileIndex) {
  const findings = [];
  for (const obj of objectsOf(reg)) {
    try {
      for (const issue of reg.findIssuesObject(obj)) findings.push(toFinding(issue, fileIndex));
    } catch (e) {
      findings.push({
        rule_id: "abaplint_engine_error",
        severity: "info",
        object: obj.getName?.() ?? "",
        object_type: obj.getType?.(),
        message: `abaplint could not analyze this object (engine error): ${String(e?.message ?? e).slice(0, 160)}`,
        family: "engine",
      });
    }
  }
  return findings;
}

/**
 * Map each source filename to its owning object, so an Issue (which carries a
 * filename) can be attributed to an object name + type.
 * @param {import("@abaplint/core").Registry} reg
 * @returns {Map<string, {object: string, object_type: string}>}
 */
function buildFileIndex(reg) {
  const idx = new Map();
  for (const obj of objectsOf(reg)) {
    for (const f of obj.getFiles?.() ?? []) {
      idx.set(f.getFilename(), { object: obj.getName(), object_type: obj.getType() });
    }
  }
  return idx;
}

/**
 * @param {import("@abaplint/core").Issue} issue
 * @param {Map<string, {object: string, object_type: string}>} fileIndex
 * @returns {object} schema finding
 */
function toFinding(issue, fileIndex) {
  const file = issue.getFilename?.();
  const owner = fileIndex.get(file) ?? { object: fileToObjectName(file), object_type: undefined };
  const key = issue.getKey?.();
  return {
    rule_id: key,
    severity: severityForAbaplintRule(key, issue.getSeverity?.()),
    object: owner.object,
    object_type: owner.object_type,
    file,
    line: issue.getStart?.()?.getRow?.() ?? 0,
    message: issue.getMessage?.(),
    family: familyForAbaplintRule(key),
  };
}

/**
 * Fallback: derive an object name from an abapGit filename
 * ("zr_bad.prog.abap" -> "ZR_BAD") when the file isn't in the object index.
 * @param {string|undefined} file
 * @returns {string}
 */
function fileToObjectName(file) {
  if (!file) return "";
  return file.split(/[\\/]/).pop().split(".")[0].toUpperCase();
}
