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
 * Each data row: { id, family, severity, pattern, flags?, message, object_types? }
 * A finding carries the row's own id/family so the rule engine surfaces the
 * specific rule, not "regex-pack".
 *
 * Full-line comments (`*` in column-effective position) are skipped to avoid
 * matching commented-out code. Patterns that fail to compile are dropped
 * (fail-open) so one bad row can't disable the pack.
 */

const DATA_FILE = join(dirname(fileURLToPath(import.meta.url)), "data", "regex-rules.json");

/** @type {Array<{id: string, family: string, severity: string, message: string, re: RegExp, object_types: string[]}>|null} */
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
 * @param {string} raw
 * @param {string} filename
 * @param {string} objName
 * @param {string} type
 * @param {Array} rules
 * @param {object[]} findings
 */
function scanFile(raw, filename, objName, type, rules, findings) {
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\*/.test(line)) continue; // full-line comment
    for (const rule of rules) {
      if (rule.object_types.length && !rule.object_types.includes(type)) continue;
      if (rule.re.test(line)) {
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
