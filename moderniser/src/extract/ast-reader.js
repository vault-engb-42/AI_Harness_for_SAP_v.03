import { Registry, MemoryFile } from "@abaplint/core";

/**
 * gap-2b B3 — the abaplint AST reader (engine 1). Extracts the plain-ABAP before/after features
 * engine 2 (the BDEF/DCL regex parser) cannot reach: `auth_checks` (AUTHORITY-CHECK object/field
 * + whether SY-SUBRC is tested — invariantDiff's P4a coverage and P4c subrc conjuncts),
 * `commit_work` (the COMMIT boundary count — P4b "not suppressed"), `money_operands` (parity's
 * `money` mandatory-parity class) and `statement_kinds` (parity's SELECT→EML read-idiom diff).
 *
 * Parse-robust (P8): each file is parsed in ISOLATION inside a try/catch, so one malformed
 * object degrades to "no statements" instead of crashing the extraction. Pure + total.
 */

const ABAP_RE = /\.abap$/i;
const SUBRC_RE = /\bSY-SUBRC\b/i;
// Mirrors the analyser's P4 rule window (invariant-auth-check.js): SY-SUBRC must appear within
// the next few statements for the gate's result to be considered tested.
const SUBRC_LOOKAHEAD = 3;

// Offline money-type fallback, owed by parity.js's docstring: resolving a data element to its
// CURR/QUAN/DEC domain needs the DDIC, which the offline extractor does not have — so a seeded
// standard amount/quantity-element allowlist stands in for abaplint's `unknown` type inference.
const MONEY_ELEMENTS = new Map([
  ["DMBTR", "CURR"], ["WRBTR", "CURR"], ["NETWR", "CURR"], ["HWBAS", "CURR"],
  ["FWBAS", "CURR"], ["KWERT", "CURR"], ["DMBE2", "CURR"], ["DMBE3", "CURR"],
  ["MENGE", "QUAN"],
]);

/** abaplint statement kind → the parity read-idiom counter key. */
const KIND_TO_COUNTER = { Select: "select", ReadEntities: "read_entities", ModifyEntities: "modify_entities" };

/**
 * @param {Array<{filename: string, source: string}>} files
 * @returns {{auth_checks: Array<{object: string, field: string, subrc_checked: boolean}>, commit_work: number, money_operands: Array<{field: string, type: string}>, statement_kinds: Record<string, number>}}
 */
export function extractAst(files) {
  const list = Array.isArray(files) ? files : [];
  const auth_checks = [];
  const money_operands = [];
  const statement_kinds = {};
  let commit_work = 0;

  for (const file of list) {
    if (!file || typeof file.source !== "string" || !ABAP_RE.test(String(file.filename ?? ""))) continue;
    const stmts = statementsOf(file);
    for (let i = 0; i < stmts.length; i++) {
      const kind = stmts[i].get()?.constructor?.name;
      const text = stmts[i].concatTokens();
      if (kind === "AuthorityCheck") {
        auth_checks.push(authCheck(text, subrcCheckedAfter(stmts, i)));
      } else if (kind === "Commit" || kind === "CommitEntities") {
        // Both are the save boundary: classic COMMIT WORK and the RAP COMMIT ENTITIES. Counting
        // both is what lets a classic→RAP rewrite read as "boundary preserved", not suppressed.
        commit_work++;
      } else if (kind === "Data") {
        const operand = moneyOperand(text);
        if (operand) money_operands.push(operand);
      }
      const counter = KIND_TO_COUNTER[kind];
      if (counter) statement_kinds[counter] = (statement_kinds[counter] ?? 0) + 1;
    }
  }
  return { auth_checks, commit_work, money_operands, statement_kinds };
}

/** Parse ONE file in isolation; its statements, or [] when abaplint cannot parse it (P8). */
function statementsOf(file) {
  try {
    const reg = new Registry();
    reg.addFile(new MemoryFile(file.filename, file.source));
    reg.parse();
    const out = [];
    for (const obj of reg.getObjects()) {
      for (const abapFile of obj.getABAPFiles?.() ?? []) out.push(...abapFile.getStatements());
    }
    return out;
  } catch {
    return [];
  }
}

/** SY-SUBRC referenced within the next SUBRC_LOOKAHEAD statements. */
function subrcCheckedAfter(stmts, i) {
  for (let j = i + 1; j <= i + SUBRC_LOOKAHEAD && j < stmts.length; j++) {
    if (SUBRC_RE.test(stmts[j].concatTokens())) return true;
  }
  return false;
}

/** `AUTHORITY-CHECK OBJECT 'obj' ID 'field' FIELD 'value'` → {object, field, subrc_checked}, upper.
 * `field` is the auth-object FIELD NAME (the ID operand), not the checked value — that is the
 * granularity invariantDiff's (object,field) coverage pairs are keyed on. */
function authCheck(text, subrc_checked) {
  return {
    object: (text.match(/OBJECT\s+'([^']+)'/i)?.[1] ?? "").toUpperCase(),
    field: (text.match(/ID\s+'([^']+)'/i)?.[1] ?? "").toUpperCase(),
    subrc_checked,
  };
}

/** `DATA name TYPE elem` → {field, type} when elem is a seeded amount/quantity element. */
function moneyOperand(text) {
  const m = text.match(/\bDATA\s+(\w+)\s+TYPE\s+(\w+)/i);
  if (!m) return null;
  const type = MONEY_ELEMENTS.get(m[2].toUpperCase());
  return type ? { field: m[1].toUpperCase(), type } : null;
}
