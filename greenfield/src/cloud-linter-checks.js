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
};

export const LOOP_OPEN = new Set(["Loop", "While", "Do", "SelectLoop"]);
export const LOOP_CLOSE = new Set(["EndLoop", "EndWhile", "EndDo", "EndSelect"]);
export const SELECT_KINDS = new Set(["Select", "SelectLoop"]);
export const DB_WRITE_STMTS = new Set(["InsertDatabase", "UpdateDatabase", "ModifyDatabase", "DeleteDatabase"]);

export const HEADER_LINE_SPEC = { rule_id: "gf-cloud-with-header-line", severity: "error", family: "abap-cloud", message: "WITH HEADER LINE is not available in ABAP Cloud; declare the internal table and a separate work area" };
export const SELECT_STAR_SPEC = { rule_id: "gf-cloud-select-star", severity: "warning", family: "performance", message: "SELECT * reads every column; project only the fields the RAP/CDS contract needs" };
export const SELECT_IN_LOOP_SPEC = { rule_id: "gf-perf-select-in-loop", severity: "warning", family: "performance", message: "SELECT inside a loop causes N+1 database round-trips; read the set once before the loop" };
export const COMMIT_IN_LOOP_SPEC = { rule_id: "gf-inv-commit-in-loop", severity: "error", family: "invariant", message: "COMMIT WORK inside a loop breaks the logical unit of work; commit once after the loop" };
export const AUTHCHECK_SPEC = { rule_id: "gf-inv-authcheck-no-subrc", severity: "warning", family: "invariant", message: "AUTHORITY-CHECK is not followed by an SY-SUBRC test — the authorization result is ignored (P4); test SY-SUBRC immediately after" };
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
 * P4: an AUTHORITY-CHECK must be followed by an SY-SUBRC test. Scan the next two
 * real statements (comments/blank lines are not statement nodes) for an SY-SUBRC
 * reference; absence is the finding.
 * @param {import("@abaplint/core").StatementNode[]} stmts
 * @param {number} i index of the AUTHORITY-CHECK statement
 * @returns {boolean}
 */
export function subrcCheckedAfter(stmts, i) {
  for (let j = i + 1; j <= Math.min(stmts.length - 1, i + 2); j++) {
    if (SUBRC_RE.test(stmts[j].concatTokens())) return true;
  }
  return false;
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
