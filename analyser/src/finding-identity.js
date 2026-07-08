import { hashHex } from "./run-identity.js";

/**
 * finding_id + AST-unit attribution (arch spec §7, conv #10/#11). finding_id =
 * SHA-256(rule_id + object + enclosing_unit + normalized_snippet) — the line-
 * resilient anchor for exemptions + ratchet diff. It survives line-number shifts
 * and whitespace/keyword-case reformatting; it deliberately does NOT survive an
 * identifier or string-literal change (that is a genuinely different finding).
 */

const UNIT_RE = /^\s*(METHOD|FORM|FUNCTION|MODULE)\s+([A-Za-z0-9_~<>/]+)/i;
const END_RE = /^\s*END(METHOD|FORM|FUNCTION|MODULE)\b/i;

/**
 * Normalize the flagged statement text for the hash (conv #10): line-endings ->
 * LF, collapse whitespace runs to one space, upper-case OUTSIDE string literals,
 * preserve literal content verbatim (ABAP keywords/identifiers are case-
 * insensitive; string literals are case-sensitive). Deterministic.
 * @param {string} line
 * @returns {string}
 */
export function normalizeSnippet(line) {
  const s = String(line ?? "").replace(/\r\n?/g, "\n");
  let out = "";
  let i = 0;
  let lastSpace = false;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "'" || ch === "`" || ch === "|") {
      const close = ch;
      out += ch;
      i++;
      while (i < s.length) {
        out += s[i];
        const done = s[i] === close;
        i++;
        if (done) break;
      }
      lastSpace = false;
    } else if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (!lastSpace) {
        out += " ";
        lastSpace = true;
      }
      i++;
    } else {
      out += ch.toUpperCase();
      lastSpace = false;
      i++;
    }
  }
  return out.trim();
}

/**
 * Nearest enclosing METHOD/FORM/FUNCTION/MODULE by a lexical upward scan (conv
 * #10) — AST-free and deterministic; matched depth-first so a finding that sits
 * after a closed unit is not mis-attributed to it. Falls back to the compilation-
 * unit object name (class/report/interface) when the finding is not inside a unit.
 * @param {string[]} lines source lines (LF-split)
 * @param {number} lineNo 1-based line of the finding
 * @param {string} fallbackObject compilation-unit name
 * @returns {string}
 */
export function enclosingUnit(lines, lineNo, fallbackObject) {
  let depth = 0;
  for (let i = Math.min(lineNo - 1, lines.length - 1); i >= 0; i--) {
    const l = lines[i] ?? "";
    if (END_RE.test(l)) {
      depth++;
      continue;
    }
    const m = UNIT_RE.exec(l);
    if (m) {
      if (depth === 0) return `${m[1].toLowerCase()}:${m[2].toLowerCase()}`;
      depth--;
    }
  }
  return fallbackObject ?? "";
}

/**
 * finding_id for one finding (§7). rule_id + object + enclosing_unit +
 * normalized_snippet, joined unambiguously, SHA-256/hex (the shared primitive).
 * @param {object} finding
 * @param {string} enclosing_unit
 * @param {string} normalized_snippet
 * @returns {string} 64-char sha256 hex
 */
export function findingId(finding, enclosing_unit, normalized_snippet) {
  return hashHex([finding.rule_id ?? "", finding.object ?? "", enclosing_unit, normalized_snippet].join("|"));
}

/**
 * Attach enclosing_unit + normalized_snippet + finding_id to each finding, using
 * the canonical source to resolve the flagged line's statement + enclosing unit.
 * @param {object[]} findings
 * @param {Array<{filename: string, source: string}>} files canonical source set
 * @returns {object[]}
 */
export function attachFindingIdentity(findings, files) {
  const byFile = new Map(
    files.map((f) => [f.filename, String(f.source ?? "").replace(/\r\n?/g, "\n").split("\n")]),
  );
  return findings.map((f) => {
    const lines = byFile.get(f.file);
    const lineText = lines && f.line ? lines[f.line - 1] ?? "" : "";
    const normalized_snippet = normalizeSnippet(lineText);
    const enclosing_unit = lines && f.line ? enclosingUnit(lines, f.line, f.object) : (f.object ?? "");
    return { ...f, enclosing_unit, normalized_snippet, finding_id: findingId(f, enclosing_unit, normalized_snippet) };
  });
}

/**
 * Stable total-order sort (A2): (file, line[numeric], rule_id, object, finding_id).
 * @param {object[]} findings
 * @returns {object[]}
 */
export function sortFindings(findings) {
  const key = (f) =>
    [f.file ?? "", String(f.line ?? 0).padStart(9, "0"), f.rule_id ?? "", f.object ?? "", f.finding_id ?? ""].join("|");
  return [...findings].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}
