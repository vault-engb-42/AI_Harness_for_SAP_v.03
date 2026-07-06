import { basename } from "node:path";
import { harvestRefs, classifyRef } from "./released-api-grounding.js";

/**
 * GF-2 rule specs + the raw-source checks for greenfield's dedicated ABAP-Cloud
 * generation linter. The statement-stream walk lives in cloud-linter.js; this
 * module holds the single-statement rule table, the loop/DB-write sets, the two
 * raw-source rules (CDS classic-view, released-API grounding) and the FOR TESTING
 * assertion check — all greenfield's own code (it shares only the @abaplint
 * LIBRARY and GF-1's registry helpers, never the analyser's rule packs).
 */

// Statement constructor-name -> finding spec (single-statement, any depth).
// Kinds verified against @abaplint/core via the probe in scratchpad — using the
// exact constructor names avoids the silent-non-firing bug.
export const KIND_RULES = {
  Tables: { rule_id: "gf-cloud-no-tables", severity: "error", family: "abap-cloud", message: "TABLES declares a shared work area — not available in ABAP Cloud; type a local DATA structure on a released CDS entity or table type" },
  Write: { rule_id: "gf-cloud-no-write", severity: "error", family: "abap-cloud", message: "WRITE list output is not available in ABAP Cloud; expose data through the RAP/OData layer or a released API" },
  ExecSQL: { rule_id: "gf-cloud-no-native-sql", severity: "error", family: "abap-cloud", message: "EXEC SQL native SQL is forbidden in ABAP Cloud; use Open SQL over released CDS entities" },
  CallScreen: { rule_id: "gf-cloud-no-dynpro", severity: "error", family: "abap-cloud", message: "CALL SCREEN drives a classic Dynpro — not available in ABAP Cloud; build a RAP/Fiori UI" },
  SetScreen: { rule_id: "gf-cloud-no-dynpro", severity: "error", family: "abap-cloud", message: "SET SCREEN drives a classic Dynpro — not available in ABAP Cloud; build a RAP/Fiori UI" },
  CallTransaction: { rule_id: "gf-cloud-no-call-transaction", severity: "error", family: "abap-cloud", message: "CALL TRANSACTION invokes a classic SAP GUI transaction — forbidden in ABAP Cloud; call a released API or RAP action" },
  CallFunction: { rule_id: "gf-cloud-call-function", severity: "warning", family: "abap-cloud", message: "CALL FUNCTION — only released, Cloud-enabled function modules are permitted; prefer a released class method or RAP EML" },
  // Batch 2 — obsolete syntax (mirrors TALOS CLEAN-001/004/007/008/010). `guard`
  // narrows a SHARED statement kind by text: abaplint parses a plain assignment
  // `a = b` as `Move` and a direct call `o->m( )` as `Call`, so these two rules
  // MUST also match the obsolete keyword form or they over-fire on every
  // assignment/call (probe-verified).
  CreateObject: { rule_id: "gf-clean-no-create-object", severity: "error", family: "clean-abap", message: "CREATE OBJECT is obsolete — use the NEW constructor operator" },
  Concatenate: { rule_id: "gf-clean-no-concatenate", severity: "error", family: "clean-abap", message: "CONCATENATE is obsolete — use a string template |{ a }{ b }| or the && operator" },
  Move: { rule_id: "gf-clean-no-move-to", severity: "error", family: "clean-abap", message: "MOVE … TO is obsolete — use the assignment operator =", guard: /^MOVE\b/i },
  Call: { rule_id: "gf-clean-no-call-method", severity: "error", family: "clean-abap", message: "CALL METHOD is obsolete — call the method directly: obj->method( )", guard: /^CALL\s+METHOD\b/i },
  Form: { rule_id: "gf-clean-no-form", severity: "error", family: "clean-abap", message: "FORM subroutines are not available in ABAP Cloud — use a class method" },
  // Batch 1 — restricted-ABAP + Clean-Core hard blockers (mirrors TALOS
  // CLOUD-008/009/010/011/019/022/026 + LEAVE flow). Kinds probe-verified.
  Describe: { rule_id: "gf-cloud-no-describe-lines", severity: "error", family: "abap-cloud", message: "DESCRIBE TABLE … LINES is obsolete — use lines( itab )", guard: /\bLINES\b/i },
  GetReference: { rule_id: "gf-cloud-no-get-reference", severity: "error", family: "abap-cloud", message: "GET REFERENCE OF is not available in ABAP Cloud — use REF #( ) or a data reference obtained through released APIs" },
  ReadReport: { rule_id: "gf-cloud-no-read-report", severity: "error", family: "abap-cloud", message: "READ REPORT reads program source at runtime — not available in ABAP Cloud" },
  Break: { rule_id: "gf-cloud-no-break-point", severity: "error", family: "abap-cloud", message: "BREAK-POINT / BREAK is a debug statement — remove it; it is not permitted in ABAP Cloud" },
  Leave: { rule_id: "gf-cloud-no-leave", severity: "error", family: "abap-cloud", message: "LEAVE (SCREEN / PROGRAM / LIST-PROCESSING / TO TRANSACTION) is classic program flow — not available in ABAP Cloud" },
  Perform: { rule_id: "gf-cloud-no-perform-sap", severity: "error", family: "clean-core", message: "PERFORM … IN PROGRAM calls another program's subroutine — not available in ABAP Cloud; call a released API or class method", guard: /\bIN\s+PROGRAM\b/i },
  EnhancementPoint: { rule_id: "gf-cloud-no-enhancement-point", severity: "error", family: "clean-core", message: "ENHANCEMENT-POINT is a source plug-in — not Clean-Core; extend via BAdI/RAP/CDS-extend" },
  EnhancementSection: { rule_id: "gf-cloud-no-enhancement-point", severity: "error", family: "clean-core", message: "ENHANCEMENT-SECTION is a source plug-in — not Clean-Core; extend via BAdI/RAP/CDS-extend" },
  InterfaceDef: { rule_id: "gf-cloud-no-internal-badi", severity: "error", family: "clean-core", message: "implementing an SAP-internal BAdI (IF_EX_*INTERNAL*) is not a released extension point", guard: /IF_EX_\w*INTERNAL/i },
  // Batch 3 — cloud-runtime + Clean-Core warnings. `notGuard` fires when the
  // regex does NOT match (class not FINAL/ABSTRACT). Kinds probe-verified.
  Message: { rule_id: "gf-cloud-message-type", severity: "warning", family: "abap-cloud", message: "MESSAGE … TYPE (dialog message) is not available in ABAP Cloud; surface messages through a released exception or the RAP message API", guard: /\bTYPE\s+'?[EAXIWS]'?/i },
  ClassDefinition: { rule_id: "gf-cloud-class-not-final", severity: "warning", family: "abap-cloud", message: "a class should be FINAL (or ABSTRACT) in ABAP Cloud — avoid open inheritance", notGuard: /\b(?:FINAL|ABSTRACT|DEFERRED|FOR\s+TESTING)\b/i },
  FieldSymbol: { rule_id: "gf-cloud-fs-type-any", severity: "warning", family: "abap-cloud", message: "FIELD-SYMBOLS TYPE ANY defeats static typing — type the field symbol explicitly", guard: /\bTYPE\s+ANY\b(?!\s+TABLE)/i },
  Compute: { rule_id: "gf-cloud-no-compute", severity: "warning", family: "clean-abap", message: "COMPUTE is obsolete — use a plain assignment x = …" },
};

// Any-statement text rules — the construct is not a distinct parsed kind (or the
// kind is shared, e.g. CL_SALV_TABLE=>FACTORY parses as a generic `Call`), so
// match the statement text directly. Mirrors TALOS CLOUD-013/015.
export const TEXT_RULES = [
  { rule_id: "gf-cloud-no-classic-alv", severity: "error", family: "abap-cloud", message: "CL_SALV_TABLE=>FACTORY is the classic ALV — not available in ABAP Cloud; expose data through RAP/OData", re: /\bCL_SALV_TABLE\s*=>\s*FACTORY\b/i },
  { rule_id: "gf-cloud-no-using-client", severity: "error", family: "abap-cloud", message: "USING CLIENT cross-client access is forbidden in ABAP Cloud; operate in the current client only", re: /\bUSING\s+CLIENT\b/i },
  // Batch 3 text rules — construct is not a distinct kind (SY-time read, ref to a
  // legacy-UI / SEGW / BOPF class) or a definition prefix (user exit / CI include).
  { rule_id: "gf-cloud-sy-time-direct", severity: "warning", family: "abap-cloud", message: "direct SY-UZEIT/DATUM/TIMLO/TZONE read is time-zone-unsafe in ABAP Cloud — use CL_ABAP_CONTEXT_INFO or a released time API", re: /\bSY-(?:UZEIT|DATUM|TIMLO|TZONE|ZONLO)\b/i },
  { rule_id: "gf-cloud-no-user-exit", severity: "warning", family: "clean-core", message: "classic user/customer exit (USEREXIT_ / CUSTOMER_FUNCTION_) is not a released extension point — use a BAdI or RAP extension", re: /^(?:FORM\s+USEREXIT_|FUNCTION\s+CUSTOMER_FUNCTION_)/i },
  { rule_id: "gf-cloud-legacy-ui", severity: "warning", family: "clean-core", message: "Web Dynpro / legacy-UI reference (IF_WD_*/CL_WD_*/IWCI_*) — build a Fiori/RAP UI instead", re: /\b(?:IF_WD_\w+|CL_WD_\w+|IWCI_\w+)\b/i },
  { rule_id: "gf-cloud-ci-include", severity: "warning", family: "clean-core", message: "classic CI_ append-structure include — extend released structures through released extension points", re: /\bINCLUDE\s+STRUCTURE\s+CI_\w+/i },
  { rule_id: "gf-cloud-segw-bopf", severity: "warning", family: "clean-core", message: "SEGW/BOPF reference (/IWBEP/ or /BOBF/) — model OData through RAP service definitions/bindings", re: /\/(?:IWBEP|BOBF)\/(?:CL|IF)_\w+/i },
  // Batch 4 — Clean ABAP style
  { rule_id: "gf-clean-bool-literal", severity: "warning", family: "clean-abap", message: "'X' / ' ' boolean literal — use abap_true / abap_false", re: /=\s*'[X ]'/ },
];

// Statement rules keyed by kind AND text — the flexible matcher for cases where
// two rules share a kind (both gf-clean-hungarian and gf-clean-standalone-data
// target `Data`), so KIND_RULES (one-per-kind) cannot express them.
export const STMT_RULES = [
  { rule_id: "gf-clean-hungarian", severity: "warning", family: "clean-abap", message: "Hungarian-notation prefix (lt_/gs_/mv_/lo_…) — Clean ABAP names describe content, not type or scope", kinds: new Set(["Data", "ClassData"]), re: /^(?:CLASS-)?DATA\s+[lgme][tvsoraixe]_/i },
  { rule_id: "gf-clean-standalone-data", severity: "warning", family: "clean-abap", message: "standalone typed DATA declaration — prefer an inline DATA(x) at first assignment where practical", kinds: new Set(["Data"]), re: /^DATA\s+\w+\s+TYPE\b/i },
  { rule_id: "gf-clean-raise-exc-type", severity: "warning", family: "clean-abap", message: "RAISE EXCEPTION TYPE — prefer RAISE EXCEPTION NEW zcx_…( ) to construct and raise in one step", kinds: new Set(["Raise"]), re: /\bTYPE\b/i },
  { rule_id: "gf-clean-redundant-exporting", severity: "warning", family: "clean-abap", message: "redundant EXPORTING in a method call — omit the keyword for a single set of exporting parameters", kinds: new Set(["Call", "Move"]), re: /\(\s*EXPORTING\s+/i },
];

export const LOOP_OPEN = new Set(["Loop", "While", "Do", "SelectLoop"]);
export const LOOP_CLOSE = new Set(["EndLoop", "EndWhile", "EndDo", "EndSelect"]);
export const SELECT_KINDS = new Set(["Select", "SelectLoop"]);
export const DB_WRITE_STMTS = new Set(["InsertDatabase", "UpdateDatabase", "ModifyDatabase", "DeleteDatabase"]);

export const HEADER_LINE_SPEC = { rule_id: "gf-cloud-with-header-line", severity: "error", family: "abap-cloud", message: "WITH HEADER LINE is not available in ABAP Cloud; declare the internal table and a separate work area" };
export const SELECT_STAR_SPEC = { rule_id: "gf-cloud-select-star", severity: "warning", family: "performance", message: "SELECT * reads every column; project only the fields the RAP/CDS contract needs" };
export const SELECT_IN_LOOP_SPEC = { rule_id: "gf-perf-select-in-loop", severity: "warning", family: "performance", message: "SELECT inside a loop causes N+1 database round-trips; read the set once before the loop" };
export const COMMIT_IN_LOOP_SPEC = { rule_id: "gf-inv-commit-in-loop", severity: "error", family: "invariant", message: "COMMIT WORK inside a loop breaks the logical unit of work; commit once after the loop" };
export const AUTHCHECK_SPEC = { rule_id: "gf-inv-authcheck-no-subrc", severity: "warning", family: "invariant", message: "AUTHORITY-CHECK is not followed by an SY-SUBRC test — the authorization result is ignored (P4); test SY-SUBRC immediately after" };
export const AUTHCHECK_AFTER_WRITE_SPEC = { rule_id: "gf-x-authcheck-subrc-after-write", severity: "error", family: "invariant", message: "the AUTHORITY-CHECK's SY-SUBRC is tested only AFTER a protected database write — the gate runs too late to stop the write (P4)" };
export const RAP_DB_WRITE_SPEC = { rule_id: "gf-rap-direct-db-write", severity: "warning", family: "rap-odata", message: "direct database write to a persistent table — in RAP, persist through EML (MODIFY ENTITIES) so the behavior pool owns the data" };

export const DECLARE_RE = /^(?:CLASS-)?DATA\s+(\w+)/i;
const DB_WRITE_TARGET_RE = /^(?:INSERT(?:\s+INTO)?|UPDATE|MODIFY(?:\s+TABLE)?|DELETE(?:\s+FROM)?)\s+(\w+)/i;
const HEADER_LINE_RE = /\bWITH\s+HEADER\s+LINE\b/i;
const SELECT_STAR_RE = /\bSELECT\s+(?:SINGLE\s+)?\*/i;
const SUBRC_RE = /\bSY-SUBRC\b/i;
const DDLS_RE = /\.ddls(?:\.asddls)?$/i;
const DEFINE_VIEW_RE = /\bDEFINE\s+VIEW\b(?!\s+ENTITY\b)/i;
const ASSERT_RE = /\bCL_A(?:BAP_UNIT|UNIT)_ASSERT\b/i;

/** @param {import("@abaplint/core").StatementNode} st @returns {number} 1-based source row */
export function lineOf(st) {
  return st?.getFirstToken()?.getStart()?.getRow?.() ?? 1;
}

/** @param {string} filename @returns {string} the object name (first dotted segment, uppercased) */
export function objNameOf(filename) {
  return basename(String(filename ?? "")).split(".")[0].toUpperCase();
}

/** @returns {boolean} whether the DATA/UPDATE/etc. target is a declared local (not a DB table) */
export function isDeclaredLocal(text, declared) {
  const m = DB_WRITE_TARGET_RE.exec(text);
  const target = m?.[1]?.toUpperCase();
  return !target || declared.has(target);
}

/** @returns {boolean} whether WITH HEADER LINE appears in the statement text */
export function hasHeaderLine(text) {
  return HEADER_LINE_RE.test(text);
}

/** @returns {boolean} whether the SELECT projects the whole row (SELECT * / SELECT SINGLE *) */
export function isSelectStar(text) {
  return SELECT_STAR_RE.test(text);
}

/**
 * P4 verdict for an AUTHORITY-CHECK, scanning forward within the method/window:
 *  - "ok"          — an SY-SUBRC test appears before any protected DB write.
 *  - "after-write" — a protected DB write (to a non-local, i.e. persistent target)
 *                    appears BEFORE the SY-SUBRC test: the gate ran but its result
 *                    is inspected too late — the write already fired.
 *  - "missing"     — no SY-SUBRC test within the window.
 * @param {import("@abaplint/core").StatementNode[]} stmts
 * @param {number} i index of the AUTHORITY-CHECK statement
 * @param {Set<string>} declared local names in scope (an itab write is not persistence)
 * @returns {"ok" | "after-write" | "missing"}
 */
export function authCheckVerdict(stmts, i, declared) {
  const limit = Math.min(stmts.length - 1, i + 20);
  for (let j = i + 1; j <= limit; j++) {
    const kind = stmts[j].get()?.constructor?.name;
    if (kind === "EndMethod" || kind === "EndForm") break;
    const text = stmts[j].concatTokens();
    if (SUBRC_RE.test(text)) return "ok";
    if (DB_WRITE_STMTS.has(kind) && !isDeclaredLocal(text, declared)) return "after-write";
  }
  return "missing";
}

/**
 * gf-cds-classic-view — a DDLS source that declares a classic `DEFINE VIEW`
 * instead of `DEFINE VIEW ENTITY`. Raw-source rule: abaplint models DDLS as its
 * own object, so the check reads the generated text directly.
 * @param {Array<{filename: string, source: string}>} files
 * @returns {object[]}
 */
export function cdsClassicViewFindings(files) {
  const findings = [];
  for (const f of files) {
    if (!DDLS_RE.test(f.filename ?? "")) continue;
    const lines = String(f.source ?? "").split(/\r?\n/);
    const idx = lines.findIndex((l) => DEFINE_VIEW_RE.test(l));
    if (idx >= 0) {
      findings.push({ rule_id: "gf-cds-classic-view", severity: "error", object: objNameOf(f.filename), object_type: "DDLS", file: f.filename, line: idx + 1, message: "classic DEFINE VIEW is not Clean-Core; generate a CDS view entity (DEFINE VIEW ENTITY)", family: "cds" });
    }
  }
  return findings;
}

const MOD_MARKER_RE = /\*\$\*\$-(?:Start|End):/;

/**
 * gf-cloud-no-mod-marker (CLOUD-020) — an SAP source-modification marker
 * (`*$*$-Start/End:`) lives in a comment, so it is not a parsed statement; scan
 * the raw source. One finding per file (the first marker) is enough to block.
 * @param {Array<{filename: string, source: string}>} files
 * @returns {object[]}
 */
export function modMarkerFindings(files) {
  const findings = [];
  for (const f of files) {
    const lines = String(f.source ?? "").split(/\r?\n/);
    const idx = lines.findIndex((l) => MOD_MARKER_RE.test(l));
    if (idx >= 0) {
      findings.push({ rule_id: "gf-cloud-no-mod-marker", severity: "error", object: objNameOf(f.filename), object_type: undefined, file: f.filename, line: idx + 1, message: "SAP source-modification marker (*$*$) — modifying SAP source is not Clean-Core; extend via BAdI/RAP/CDS-extend", family: "clean-core" });
    }
  }
  return findings;
}

/**
 * The GF-1↔GF-2 link. Harvest SAP object refs from each generated source (raw
 * text, so a parse-dropped file is still covered) and classify them against the
 * released-API registry. Four actionable verdicts: gf-ground-deprecated (with
 * successor, error), gf-ground-not-released (notToBeReleased, error),
 * gf-ground-no-api (noAPI, error), gf-ground-classic-api (classicAPI, info).
 * @param {Array<{filename: string, source: string}>} files
 * @returns {object[]}
 */
// released-API verdict -> finding spec. Only these four states are actionable;
// `released`/`unknown` produce no finding. classifyRef surfaces classicAPI/noAPI
// straight from objectClassifications_SAP.json.
const GROUND_SPECS = {
  deprecated: (ref, c) => ({ rule_id: "gf-ground-deprecated", severity: "error", message: `${ref} is DEPRECATED — replace with released successor ${c.successor ?? "(none published — find a released alternative)"}` }),
  notToBeReleased: (ref) => ({ rule_id: "gf-ground-not-released", severity: "error", message: `${ref} is NOT released for ABAP Cloud (notToBeReleased) — model a released alternative` }),
  noAPI: (ref) => ({ rule_id: "gf-ground-no-api", severity: "error", message: `${ref} has NO released API (noAPI) — there is no Cloud-released way to consume it; model a released alternative` }),
  classicAPI: (ref, c) => ({ rule_id: "gf-ground-classic-api", severity: "info", message: `${ref} is a CLASSIC API (Level B, not Clean-Core Level A)${c.successor ? ` — prefer released successor ${c.successor}` : " — prefer a released successor"}` }),
};

export function releasedApiFindings(files) {
  const findings = [];
  for (const f of files) {
    const source = String(f.source ?? "");
    const upperLines = source.split(/\r?\n/).map((l) => l.toUpperCase());
    for (const ref of harvestRefs(source)) {
      const c = classifyRef(ref);
      const spec = GROUND_SPECS[c.state];
      if (!spec) continue;
      const line = upperLines.findIndex((l) => new RegExp(`(?<![\\w~])${ref}(?![\\w~])`).test(l)) + 1 || 1;
      const s = spec(ref, c);
      findings.push({ rule_id: s.rule_id, severity: s.severity, object: objNameOf(f.filename), object_type: undefined, file: f.filename, line, message: s.message, family: "released-api" });
    }
  }
  return findings;
}

/**
 * gf-hardy-test-no-assert — a FOR TESTING method whose body contains no
 * CL_ABAP_UNIT_ASSERT proves nothing. Walks the parsed statement stream (so
 * colon-chained `METHODS:` are normalized to individual MethodDef nodes), pairs
 * each FOR TESTING declaration with its method body, and flags the assert-less
 * ones. Mirrors the analyser's fixed test-quality walk — greenfield's own code.
 * @param {string} objName
 * @param {import("@abaplint/core").ABAPFile} file
 * @returns {object[]}
 */
export function testNoAssertFindings(objName, file) {
  const testMethods = new Set();
  const bodies = new Map();
  let current = null;
  let buf = [];
  let line = 1;
  for (const st of file.getStatements?.() ?? []) {
    const kind = st.get()?.constructor?.name;
    const text = st.concatTokens();
    if (kind === "MethodDef") {
      if (/\bFOR\s+TESTING\b/i.test(text)) {
        const nm = /^METHODS\s+([\w~]+)/i.exec(text)?.[1]?.toUpperCase();
        if (nm) testMethods.add(nm);
      }
    } else if (kind === "MethodImplementation" || kind === "Method") {
      current = /^METHOD\s+([\w~]+)/i.exec(text)?.[1]?.toUpperCase() ?? null;
      buf = [];
      line = lineOf(st);
    } else if (kind === "EndMethod") {
      if (current) bodies.set(current, { text: buf.join("\n"), line });
      current = null;
    } else if (current) {
      buf.push(text);
    }
  }
  const findings = [];
  for (const name of testMethods) {
    const body = bodies.get(name);
    if (!body || ASSERT_RE.test(body.text)) continue;
    findings.push({ rule_id: "gf-hardy-test-no-assert", severity: "warning", object: objName, object_type: "CLAS", file: file.getFilename(), line: body.line, message: `test method ${name} contains no CL_ABAP_UNIT_ASSERT — it can never fail and proves nothing`, family: "anti-pattern" });
  }
  return findings;
}
