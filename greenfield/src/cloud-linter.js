import { ABAPObject } from "@abaplint/core";
import { parseAbap, objectsOf } from "./abap-parse.js";
import {
  KIND_RULES, TEXT_RULES, STMT_RULES, LOOP_OPEN, LOOP_CLOSE, SELECT_KINDS, DB_WRITE_STMTS, DECLARE_RE,
  HEADER_LINE_SPEC, SELECT_STAR_SPEC, SELECT_IN_LOOP_SPEC, COMMIT_IN_LOOP_SPEC,
  AUTHCHECK_SPEC, AUTHCHECK_AFTER_WRITE_SPEC, RAP_DB_WRITE_SPEC,
  lineOf, objNameOf, isDeclaredLocal, hasHeaderLine, isSelectStar, authCheckVerdict,
  cdsClassicViewFindings, releasedApiFindings, testNoAssertFindings, modMarkerFindings, commitInRapPoolFindings,
} from "./cloud-linter-checks.js";
import { complexityFindings, publicCoverageFindings } from "./cloud-linter-complexity.js";

/**
 * GF-2 — the dedicated ABAP-Cloud generation linter. Post-generation validation
 * for the greenfield pipeline (the TALOS Forge `abap_cloud_linter` analogue),
 * run OFFLINE before any SAP round-trip: it blocks on `error`, and its findings
 * feed the lint→regenerate loop via formatViolationsForRepair. Parser-based on
 * the @abaplint/core LIBRARY through greenfield's own loader — NOT the analyser.
 *
 * @param {Array<{filename: string, source: string}>} files generated ABAP artifacts
 * @returns {{findings: object[], errorCount: number, warningCount: number}}
 */
export function lintAbapCloud(files) {
  const list = Array.isArray(files) ? files.filter((f) => f && typeof f.source === "string") : [];
  const findings = [];

  // Statement-stream rules run over what the parser accepts; a malformed object
  // is dropped by parseAbap (P8) but still covered by the raw-source rules below.
  const reg = parseAbap(list);
  for (const obj of objectsOf(reg)) {
    if (!(obj instanceof ABAPObject)) continue;
    for (const file of obj.getABAPFiles()) {
      scanStatements(obj.getName(), obj.getType(), file, findings);
      findings.push(...testNoAssertFindings(obj.getName(), file));
      findings.push(...complexityFindings(obj.getName(), obj.getType(), file));
    }
    findings.push(...publicCoverageFindings(obj));
  }

  // Raw-source rules read the original files directly (parse-independent).
  findings.push(...cdsClassicViewFindings(list));
  findings.push(...modMarkerFindings(list));
  findings.push(...commitInRapPoolFindings(list));
  findings.push(...releasedApiFindings(list));

  const errorCount = findings.filter((f) => f.severity === "error").length;
  const warningCount = findings.filter((f) => f.severity === "warning").length;
  return { findings, errorCount, warningCount };
}

/**
 * Walk one ABAP file's statement stream, tracking loop depth and declared locals
 * so context rules (in-loop, direct-DB-write) fire correctly.
 * @param {string} objName
 * @param {string} objType
 * @param {import("@abaplint/core").ABAPFile} file
 * @param {object[]} findings sink
 */
function scanStatements(objName, objType, file, findings) {
  const stmts = file.getStatements();
  const declared = new Set();
  let depth = 0;
  const emit = (spec, st) => findings.push({
    rule_id: spec.rule_id, severity: spec.severity, object: objName, object_type: objType,
    file: file.getFilename(), line: lineOf(st), message: spec.message, family: spec.family,
  });

  for (let i = 0; i < stmts.length; i++) {
    const st = stmts[i];
    const kind = st.get()?.constructor?.name;
    const text = st.concatTokens();

    const decl = DECLARE_RE.exec(text);
    if (decl) declared.add(decl[1].toUpperCase());

    const kindRule = KIND_RULES[kind];
    if (kindRule && (!kindRule.guard || kindRule.guard.test(text)) && (!kindRule.notGuard || !kindRule.notGuard.test(text))) emit(kindRule, st);
    for (const tr of TEXT_RULES) if (tr.re.test(text)) emit(tr, st);
    for (const sr of STMT_RULES) if (sr.kinds.has(kind) && sr.re.test(text) && (!sr.notRe || !sr.notRe.test(text))) emit(sr, st);
    if (hasHeaderLine(text)) emit(HEADER_LINE_SPEC, st);
    if (SELECT_KINDS.has(kind) && isSelectStar(text)) emit(SELECT_STAR_SPEC, st);
    if (kind === "AuthorityCheck") {
      const verdict = authCheckVerdict(stmts, i, declared);
      if (verdict === "after-write") emit(AUTHCHECK_AFTER_WRITE_SPEC, st);
      else if (verdict === "missing") emit(AUTHCHECK_SPEC, st);
    }
    if (DB_WRITE_STMTS.has(kind) && !isDeclaredLocal(text, declared)) emit(RAP_DB_WRITE_SPEC, st);

    // Loop-context rules test depth BEFORE this statement adjusts it, so a
    // top-level SELECT..ENDSELECT header is not counted as "inside a loop".
    if (depth > 0) {
      if (SELECT_KINDS.has(kind)) emit(SELECT_IN_LOOP_SPEC, st);
      if (kind === "Commit") emit(COMMIT_IN_LOOP_SPEC, st);
    }
    if (LOOP_OPEN.has(kind)) depth++;
    else if (LOOP_CLOSE.has(kind)) depth = Math.max(0, depth - 1);
  }
}

/**
 * Render lint findings as an injectable repair brief for the lint→regenerate
 * loop: blocking errors first (the generator MUST clear these before the next
 * SAP round-trip), then warnings. Deterministic ordering (by file, then line).
 * @param {object[]} findings
 * @returns {string}
 */
export function formatViolationsForRepair(findings) {
  const list = [...(findings ?? [])].sort((a, b) => (a.file ?? "").localeCompare(b.file ?? "") || (a.line ?? 0) - (b.line ?? 0));
  if (!list.length) return "No ABAP Cloud lint violations — the generated source is Clean-Core clean.";
  const render = (f) => `- [${f.rule_id}] ${f.file}:${f.line} — ${f.message}`;
  const errors = list.filter((f) => f.severity === "error").map(render);
  const warnings = list.filter((f) => f.severity === "warning").map(render);
  const out = ["=== ABAP Cloud lint violations — fix before the next generation/SAP round-trip ==="];
  if (errors.length) out.push(`ERRORS (blocking — must be cleared):`, ...errors);
  if (warnings.length) out.push(`WARNINGS (address or justify):`, ...warnings);
  return out.join("\n");
}
