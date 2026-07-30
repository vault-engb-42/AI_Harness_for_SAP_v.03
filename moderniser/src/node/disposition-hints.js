/**
 * Disposition hints (B2-generalisation, operator 2026-07-29). Derives a GENERIC re-architecture signal from a
 * finding — from the analyser's OWN description (`family` + `message`), NOT a hand-picked list of rule_ids. So
 * ANY analyser rule whose message names a legacy construct maps to the right hint, and a legacy archetype the
 * classifier has never literally seen (dynpro, ALV, SmartForms, Web Dynpro, IDoc) still classifies correctly —
 * as long as the analyser HAS a rule for it (a `ui_forms` gap = an analyser-coverage gap, not a classifier gap).
 *
 * The hint is the axis the classifier reasons on:
 *   ui_rearch   — classic UI (dynpro/WRITE/list/ALV/SmartForms/WebDynpro/BSP): no in-stack Cloud UI → re_architect
 *   os_exec     — OS/file ops (OPEN DATASET/CALL 'SYSTEM'/frontend services): no released equivalent → re_architect
 *   rfc_rebuild — cross-system (CALL FUNCTION DESTINATION/RFC/IDoc/ALE): candidate for side-by-side rebuild
 *   db_refactor — DB access (SELECT/DDIC/N+1): fixable in place
 *   auth        — authorization (AUTHORITY-CHECK/DCL): fixable in place
 *   style       — cosmetic / any clean-core swap with no re-arch-forcing construct: fixable in place
 * Ordered by re-arch-forcing precedence — the FIRST matching pattern wins.
 */

const HINT_PATTERNS = [
  // `write\s*[:/]` is the ABAP WRITE *statement* (WRITE: / WRITE /) — NOT a bare `\bwrite\b`, which the
  // adversarial review (2026-07-29) showed matches the English verb "write" in remediation prose of ≥5 real
  // analyser rules (ABAP-PERF-79, direct-table-write, strict-direct-db, …) → false ui_rearch → false re_architect.
  ["ui_rearch", /dynpro|module.?pool|call\s+screen|selection.?screen|write\s*[:/]|classic\s*list|list\s*processor|list\s*output|format\s+color|\balv\b|salv|reuse_alv|grid_display|smart\s*form|sapscript|adobe\s*form|web\s*dynpro|\bbsp\b|classic.?ui|legacy.?ui/i],
  ["os_exec", /open\s+dataset|call\s+.system.|\bsxpg\b|gui_download|gui_upload|frontend_services|cl_gui_frontend|cl_gui_/i],
  // The cross-system CONSTRUCT, not a coincidental noun: `CALL FUNCTION ... DESTINATION` (not the BTP
  // "Destination service" noun), and `RFC` only in an ABAP RFC keyword context (not a dead "…RFC 'SFW…'" probe
  // or the CSV standard "RFC 4180"). Hardened by the adversarial review (2026-07-29).
  ["rfc_rebuild", /call\s+function\b[\s\S]{0,60}\bdestination\b|\brfc[-_ ]?(?:enabled|destination|call|function|server|client)\b|remote\s+function|\bidoc\b|\bale\b/i],
  ["db_refactor", /\bselect\b|\bddic\b|database|n\+1|host\s+variable|\bsql\b/i],
  ["auth", /authority.?check|\bpfcg\b|\bdcl\b|authorization/i],
];

const KNOWN_HINTS = new Set(["ui_rearch", "os_exec", "rfc_rebuild", "db_refactor", "auth", "style"]);

/**
 * @param {{family?: string, rule_id?: string, message?: string}} finding
 * @returns {"ui_rearch"|"os_exec"|"rfc_rebuild"|"db_refactor"|"auth"|"style"}
 */
export function dispositionHint(finding) {
  // Data-driven (2026-07-30): the analyser tags each re-arch-forcing rule with a `disposition_hint` at emission
  // (regex-pack / metadata-pack), captured from the rule author's construct intent. Prefer it — it is robust to
  // message wording (fixes the real-code under-fire). The regex-over-message below is the FALLBACK for untagged
  // findings (abaplint built-ins + un-tagged harness rules) and for STATIC fixture docs authored before tagging,
  // so both fixture baselines are unchanged by construction.
  if (finding.disposition_hint && KNOWN_HINTS.has(finding.disposition_hint)) return finding.disposition_hint;
  if ((finding.family || "") === "abaplint") return "style"; // abaplint = cosmetic/quality, never a re-arch signal
  const txt = `${finding.rule_id || ""} ${finding.message || ""}`;
  for (const [hint, re] of HINT_PATTERNS) if (re.test(txt)) return hint;
  return "style"; // no re-arch-forcing construct detected → in-place / cosmetic
}

/**
 * @param {Array<{family?: string, rule_id?: string, message?: string}>} findings
 * @returns {string[]} the sorted DISTINCT hint set
 */
export function hintsForFindings(findings) {
  return [...new Set((findings || []).map(dispositionHint))].sort();
}
