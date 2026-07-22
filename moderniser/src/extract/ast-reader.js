import { Registry, MemoryFile } from "@abaplint/core";

/**
 * gap-2b B3 — the abaplint AST reader (engine 1). Extracts the plain-ABAP before/after features
 * engine 2 (the BDEF/DCL regex parser) cannot reach: `auth_checks` (AUTHORITY-CHECK object/field
 * + whether SY-SUBRC is tested — invariantDiff's P4a coverage and P4c subrc conjuncts),
 * `commit_work` (the COMMIT boundary count — P4b "not suppressed"), `money_operands` (parity's
 * `money` mandatory-parity class), `statement_kinds` (parity's SELECT→EML read-idiom diff) and the
 * four structure counters the §15.4 parity DEDUCTIONS are computed from in B4 — `exception_paths`,
 * `cfg_branches`, `max_nesting` and `client_specified`. Counters, not verdicts: a deduction is a
 * before/after DELTA, so this side only counts and `bundle-diff.js` decides.
 *
 * Parse-robust (P8): each file is parsed in ISOLATION inside a try/catch, so one malformed
 * object degrades to "no statements" instead of crashing the extraction. Pure + total.
 */

const ABAP_RE = /\.abap$/i;
const SUBRC_RE = /\bSY-SUBRC\b/i;
// Mirrors the analyser's P4 rule window (invariant-auth-check.js): SY-SUBRC must appear within
// the next few statements for the gate's result to be considered tested.
const SUBRC_LOOKAHEAD = 3;

// F6 remediation. SY-SUBRC is a single global register: any statement that WRITES it between the
// AUTHORITY-CHECK and the test makes that test read the later statement's result, not the gate's.
// The window is therefore an allowlist of kinds known NOT to touch SY-SUBRC, and anything else —
// including a kind not listed here — ends the window unchecked. Fail-CLOSED is the only defensible
// direction for an authorization gate: an unrecognised statement must block, never bless.
const SUBRC_SAFE = new Set([
  "Move", "Data", "DataBegin", "DataEnd", "Constant", "Type", "TypeBegin", "TypeEnd", "Static",
  "FieldSymbol", "Write", "Add", "Subtract", "Multiply", "Divide", "Clear", "Refresh", "Free", "Comment",
]);
const BLOCK_END = new Set(["EndMethod", "EndForm", "EndFunction", "EndClass", "EndModule"]);

// The FROM entity of a `SELECT … WITH PRIVILEGED ACCESS` — the ABAP-SQL half of the authorization
// bypass (the CDS-annotation half is engine 2's). This is where the addition actually lives:
// @abaplint/core models it as a statement addition, not as DCL grammar.
const PRIVILEGED_SQL_RE = /\bFROM\s+([\w/]+)[\s\S]*?\bWITH\s+PRIVILEGED\s+ACCESS\b/i;

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

// §15.4 deduction inputs. Kinds empirically probed against @abaplint/core this session.
const CLIENT_SPECIFIED_RE = /\bCLIENT\s+SPECIFIED\b/i;
const EXCEPTION_KINDS = new Set(["Catch", "Raise", "RaiseException", "Cleanup"]);
// Every point where control can diverge. `ElseIf`/`Else`/`When` are branches but NOT new blocks.
const CFG_BRANCH_KINDS = new Set(["If", "ElseIf", "Else", "When", "WhenOthers", "Loop", "Do", "While"]);
const OPEN_KINDS = new Set(["If", "Loop", "Do", "While", "Case", "Try"]);
const CLOSE_KINDS = new Set(["EndIf", "EndLoop", "EndDo", "EndWhile", "EndCase", "EndTry"]);

/**
 * @param {Array<{filename: string, source: string}>} files
 * @returns {{auth_checks: Array<{object: string, field: string, subrc_checked: boolean}>, commit_work: number, money_operands: Array<{field: string, type: string}>, statement_kinds: Record<string, number>, client_specified: number, exception_paths: number, cfg_branches: number, max_nesting: number}}
 */
export function extractAst(files) {
  const list = Array.isArray(files) ? files : [];
  const auth_checks = [];
  const money_operands = [];
  const privileged_sql = [];
  const statement_kinds = {};
  const unreadable = [];
  const tally = { commit_work: 0, client_specified: 0, exception_paths: 0, cfg_branches: 0, max_nesting: 0 };

  for (const file of list) {
    if (!file || typeof file.source !== "string" || !ABAP_RE.test(String(file.filename ?? ""))) continue;
    const parsed = statementsOf(file);
    // F11: an UNREADABLE file must be reported, never extracted as "zero features". Silence here
    // let a file abaplint cannot type pass every P4 conjunct vacuously — auth=0 and commit=0 on
    // both sides look exactly like a node with nothing to protect.
    if (!parsed.readable) {
      unreadable.push(file.filename);
      continue;
    }
    const stmts = parsed.statements;
    let depth = 0;
    for (let i = 0; i < stmts.length; i++) {
      const kind = stmts[i].get()?.constructor?.name;
      const text = stmts[i].concatTokens();
      if (kind === "AuthorityCheck") {
        auth_checks.push(...authChecks(text, subrcCheckedAfter(stmts, i)));
      } else if (kind === "Select" || kind === "SelectLoop") {
        const priv = text.match(PRIVILEGED_SQL_RE);
        if (priv) privileged_sql.push({ object: priv[1].toUpperCase() });
      } else if (kind === "Commit" || kind === "CommitEntities") {
        // Both are the save boundary: classic COMMIT WORK and the RAP COMMIT ENTITIES. Counting
        // both is what lets a classic→RAP rewrite read as "boundary preserved", not suppressed.
        tally.commit_work++;
      } else if (kind === "Data") {
        const operand = moneyOperand(text);
        if (operand) money_operands.push(operand);
      }
      const counter = KIND_TO_COUNTER[kind];
      if (counter) statement_kinds[counter] = (statement_kinds[counter] ?? 0) + 1;
      depth = tallyStructure(tally, kind, text, depth);
    }
  }
  return { auth_checks, money_operands, privileged_sql, statement_kinds, unreadable, ...tally };
}

/** Accumulate the four §15.4 deduction counters; returns the block depth after this statement. */
function tallyStructure(tally, kind, text, depth) {
  if (CLIENT_SPECIFIED_RE.test(text)) tally.client_specified++;
  if (EXCEPTION_KINDS.has(kind)) tally.exception_paths++;
  if (CFG_BRANCH_KINDS.has(kind)) tally.cfg_branches++;
  if (OPEN_KINDS.has(kind)) {
    depth += 1;
    if (depth > tally.max_nesting) tally.max_nesting = depth;
    return depth;
  }
  // Clamped: an unbalanced END* (truncated source) must not drive the depth negative and then
  // mask a genuinely nested block that follows.
  return CLOSE_KINDS.has(kind) ? Math.max(0, depth - 1) : depth;
}

/**
 * Parse ONE file in isolation (P8). `readable` distinguishes "abaplint produced an ABAP object for
 * this file" from "it produced nothing" — a file whose abapGit type token is missing (`zcl_x.abap`)
 * satisfies the `.abap` gate but yields no object at all, and reporting that as zero features would
 * pass every P4 conjunct vacuously (F11).
 * @returns {{readable: boolean, statements: object[]}}
 */
function statementsOf(file) {
  try {
    const reg = new Registry();
    reg.addFile(new MemoryFile(file.filename, file.source));
    reg.parse();
    const out = [];
    let readable = false;
    for (const obj of reg.getObjects()) {
      const abapFiles = obj.getABAPFiles?.() ?? [];
      if (abapFiles.length > 0) readable = true;
      for (const abapFile of abapFiles) out.push(...abapFile.getStatements());
    }
    return { readable, statements: out };
  } catch {
    return { readable: false, statements: [] };
  }
}

/**
 * Whether the gate's SY-SUBRC is actually TESTED (F6). Walks forward at most SUBRC_LOOKAHEAD
 * statements and stops early on anything that would CLOBBER the register or leave the block, so a
 * `SELECT` hoisted between the AUTHORITY-CHECK and the `IF sy-subrc` no longer reports the gate as
 * checked — the IF would be testing the SELECT's result.
 */
function subrcCheckedAfter(stmts, i) {
  for (let j = i + 1; j <= i + SUBRC_LOOKAHEAD && j < stmts.length; j++) {
    const kind = stmts[j].get()?.constructor?.name;
    if (SUBRC_RE.test(stmts[j].concatTokens())) return true;
    if (BLOCK_END.has(kind) || !SUBRC_SAFE.has(kind)) return false; // clobbered, or left the block
  }
  return false;
}

/**
 * `AUTHORITY-CHECK OBJECT 'obj' ID 'f1' FIELD v1 ID 'f2' DUMMY` → ONE ROW PER ID (F1).
 *
 * Capturing only the first ID made an authorization WEAKENING invisible: converting
 * `ID 'BUKRS' FIELD lv_b` to `ID 'BUKRS' DUMMY` extracted byte-identically, so the field stopped
 * being enforced while the bundle said nothing changed. `DUMMY` explicitly means "do not check this
 * field", so it is recorded and the judge treats it as NOT covered.
 *
 * `field` is the auth-object FIELD NAME (the ID operand), not the checked value — that is the
 * granularity invariantDiff's (object,field) coverage pairs are keyed on. A non-literal object is
 * kept as `VAR:<NAME>` rather than collapsing to `""`, so two different dynamic objects are not
 * silently equal.
 */
function authChecks(text, subrc_checked) {
  const object = authObject(text);
  const ids = [...text.matchAll(/\bID\s+'([^']+)'\s+(DUMMY|FIELD)\b/gi)];
  if (ids.length === 0) return [{ object, field: "", dummy: false, subrc_checked }];
  return ids.map((m) => ({
    object,
    field: m[1].toUpperCase(),
    dummy: m[2].toUpperCase() === "DUMMY",
    subrc_checked,
  }));
}

function authObject(text) {
  const literal = text.match(/OBJECT\s+'([^']+)'/i);
  if (literal) return literal[1].toUpperCase();
  const variable = text.match(/OBJECT\s+([\w/-]+)/i);
  return variable ? `VAR:${variable[1].toUpperCase()}` : "";
}

/** `DATA name TYPE elem` → {field, type} when elem is a seeded amount/quantity element. */
function moneyOperand(text) {
  const m = text.match(/\bDATA\s+(\w+)\s+TYPE\s+(\w+)/i);
  if (!m) return null;
  const type = MONEY_ELEMENTS.get(m[2].toUpperCase());
  return type ? { field: m[1].toUpperCase(), type } : null;
}
