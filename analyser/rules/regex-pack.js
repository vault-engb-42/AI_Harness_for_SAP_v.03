import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { objectsOf } from "../src/abaplint-loader.js";

/**
 * Regex rule pack — a single engine that applies a data table of pattern-based
 * checks (analyser/rules/data/regex-rules.json) to each object's raw source.
 * This is how the bulk of TALOS's regex-mechanism rules are ported: the engine
 * is coded + tested once; coverage scales by adding data rows.
 *
 * Row shape: { id, family, severity, pattern, flags?, message, object_types?,
 *             when?, unless?, scan_comments? }
 *   - when:          regex that must match somewhere in the FILE for the row
 *                    to apply (e.g. RAP-handler rules only fire inside
 *                    behavior handler/saver classes)
 *   - unless:        regex that, if it matches the FILE, SUPPRESSES the row —
 *                    the symmetric counterpart to `when`, for RAP-context
 *                    gating (e.g. skip an EML `IN LOCAL MODE` finding inside a
 *                    behavior pool, or a dynamic-WHERE finding inside a DCL)
 *   - scan_comments: the row sees raw comment lines (for rules whose subject
 *                    IS a comment marker, e.g. SAP modification markers)
 *
 * Line sanitization before matching (unless scan_comments): full-line
 * comments (`*` in column 1, or first non-blank `"`), trailing `"` comments,
 * and '...' string-literal CONTENTS are removed — commented-out or merely
 * quoted code must never raise findings. Patterns that fail to compile are
 * dropped (fail-open) so one bad row can't disable the pack.
 */

const DATA_FILE = join(dirname(fileURLToPath(import.meta.url)), "data", "regex-rules.json");

/** @type {Array<object>|null} */
let _compiled = null;

function compiledRules() {
  if (_compiled) return _compiled;
  let rows;
  try {
    rows = JSON.parse(readFileSync(DATA_FILE, "utf8"));
  } catch {
    rows = [];
  }
  _compiled = [];
  for (const r of rows) {
    try {
      // Non-global so RegExp.test is stateless across lines.
      const flags = (r.flags ?? "i").replace(/g/g, "");
      _compiled.push({
        id: r.id,
        family: r.family,
        severity: r.severity,
        message: r.message,
        re: new RegExp(r.pattern, flags),
        when: r.when ? new RegExp(r.when, "i") : null,
        unless: r.unless ? new RegExp(r.unless, "i") : null,
        scanComments: r.scan_comments === true,
        object_types: Array.isArray(r.object_types) ? r.object_types : [],
      });
    } catch {
      // skip un-compilable pattern
    }
  }
  return _compiled;
}

export const regexPack = {
  id: "regex-pack",
  family: "regex-pack",
  verdict: "WARN",
  /**
   * @param {import("../src/rule-engine.js").AnalysisContext} ctx
   * @returns {object[]}
   */
  check(ctx) {
    const findings = [];
    const rules = compiledRules();
    for (const obj of objectsOf(ctx.reg)) {
      const type = obj.getType?.();
      for (const file of obj.getFiles?.() ?? []) {
        const raw = file.getRaw?.();
        if (!raw) continue;
        scanFile(raw, file.getFilename?.(), obj.getName?.(), type, rules, findings);
      }
    }
    return findings;
  },
};

/**
 * Strip the trailing `"` comment from a line. String literals are copied
 * VERBATIM (many rules legitimately inspect them — CALL FUNCTION 'BAPI_*',
 * CALL 'SYSTEM', hardcoded credentials); the literal tracking exists only so
 * a `"` INSIDE a literal is never mistaken for a comment start. Caller has
 * already excluded full-line comments.
 * @param {string} line
 * @returns {string}
 */
export function sanitizeLine(line) {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inString) {
      if (ch === "'") {
        if (line[i + 1] === "'") {
          i++; // escaped '' inside the literal
          continue;
        }
        inString = false;
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
      continue;
    }
    if (ch === '"') return line.slice(0, i); // genuine trailing comment
  }
  return line;
}

/**
 * @param {string} raw
 * @param {string} filename
 * @param {string} objName
 * @param {string} type
 * @param {Array} rules
 * @param {object[]} findings
 */
function scanFile(raw, filename, objName, type, rules, findings) {
  const applicable = rules.filter(
    (rule) =>
      (!rule.object_types.length || rule.object_types.includes(type)) &&
      (!rule.when || rule.when.test(raw)) &&
      (!rule.unless || !rule.unless.test(raw)),
  );
  if (!applicable.length) return;

  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isComment = /^\s*[*"]/.test(line);
    const sanitized = isComment ? null : sanitizeLine(line);
    for (const rule of applicable) {
      const subject = rule.scanComments ? line : sanitized;
      if (subject === null) continue; // comment line, rule doesn't scan comments
      if (rule.re.test(subject)) {
        findings.push({
          rule_id: rule.id,
          severity: rule.severity,
          object: objName,
          object_type: type,
          file: filename,
          line: i + 1,
          message: rule.message,
          family: rule.family,
        });
      }
    }
  }
}

/** Test seam: drop the compiled-rule cache. */
export function _resetCache() {
  _compiled = null;
}
