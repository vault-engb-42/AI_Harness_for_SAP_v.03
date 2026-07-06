import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { objectsOf } from "../src/abaplint-loader.js";

/**
 * Metadata rule pack — data-driven checks over CDS (DDLS) and RAP (BDEF)
 * annotations, which abaplint exposes only as raw text. Two modes per rule:
 *   - forbid: a regex that, if it matches the source, raises a finding
 *             (e.g. @AccessControl.authorizationCheck: #NOT_REQUIRED)
 *   - require: an annotation path that, if ABSENT from the source, raises a
 *              finding (e.g. missing @AccessControl.authorizationCheck)
 * Optional gates on either mode:
 *   - when:   regex that must match the source for the rule to apply
 *             (e.g. only draft-enabled behaviors need lockingMode)
 *   - unless: regex that suppresses the rule when it matches
 *             (e.g. @VDM.private views are exempt from the usage-type contract)
 *
 * Rows: { id, family, severity, message, applies_to[], forbid?, flags?,
 *         require?, when?, unless? }
 * Findings surface their own rule_id/family.
 */

const DATA_FILE = join(dirname(fileURLToPath(import.meta.url)), "data", "metadata-rules.json");

let _rules = null;

function loadRules() {
  if (_rules) return _rules;
  try {
    _rules = JSON.parse(readFileSync(DATA_FILE, "utf8"));
  } catch {
    _rules = [];
  }
  return _rules;
}

export const metadataPack = {
  id: "metadata-pack",
  family: "metadata-pack",
  verdict: "WARN",
  /**
   * @param {import("../src/rule-engine.js").AnalysisContext} ctx
   * @returns {object[]}
   */
  check(ctx) {
    const findings = [];
    for (const obj of objectsOf(ctx.reg)) {
      const type = obj.getType?.();
      const file = obj.getFiles?.()[0];
      const raw = file?.getRaw?.();
      if (!raw) continue;
      for (const rule of loadRules()) {
        if (!rule.applies_to?.includes(type)) continue;
        evalRule(rule, raw, obj, file, findings);
      }
    }
    return findings;
  },
};

/**
 * @param {object} rule
 * @param {string} raw
 * @param {object} obj
 * @param {object} file
 * @param {object[]} findings
 */
function evalRule(rule, raw, obj, file, findings) {
  if (rule.when && !safeRe(rule.when)?.test(raw)) return;
  if (rule.unless && safeRe(rule.unless)?.test(raw)) return;
  if (rule.require) {
    const present = new RegExp("@" + escapeRegExp(rule.require), "i").test(raw);
    if (!present) push(findings, rule, obj, file, 1);
    return;
  }
  if (rule.forbid) {
    let re;
    try {
      re = new RegExp(rule.forbid, (rule.flags ?? "i").replace(/g/g, ""));
    } catch {
      return; // bad pattern — fail-open
    }
    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        push(findings, rule, obj, file, i + 1);
        return; // one finding per rule per object
      }
    }
  }
}

function push(findings, rule, obj, file, line) {
  findings.push({
    rule_id: rule.id,
    severity: rule.severity,
    object: obj.getName?.(),
    object_type: obj.getType?.(),
    file: file.getFilename?.(),
    line,
    message: rule.message,
    family: rule.family,
  });
}

/** @param {string} s */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Compile a gate regex; a bad pattern disables its gate (fail-open). */
function safeRe(pattern) {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

/** Test seam: drop the rule cache. */
export function _resetCache() {
  _rules = null;
}
