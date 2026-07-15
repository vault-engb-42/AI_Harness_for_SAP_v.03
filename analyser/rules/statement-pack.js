import { ABAPObject } from "@abaplint/core";
import { objectsOf } from "../src/abaplint-loader.js";

/**
 * Statement-AST rule pack — coded checks over the statement stream that the
 * regex pack cannot express (multi-line statements, loop context, lookback):
 *   - IN_LOOP:          statement types flagged when executed inside a loop
 *   - IN_LOOP_PATTERNS: text/type patterns flagged only inside a loop
 *   - STATEMENT_PATTERNS: single-statement checks (multi-line-statement safe)
 *   - context rules:    guard-lookback (FAE / RAP MODIFY), sort-after-select,
 *                       repeated identical SELECT SINGLE per file
 *
 * Loop nesting is a depth counter over LOOP/WHILE/DO/SELECT..ENDSELECT.
 * Findings surface their own rule_id/family (TALOS code in the message).
 */

const LOOP_OPEN = new Set(["Loop", "While", "Do", "SelectLoop"]);
const LOOP_CLOSE = new Set(["EndLoop", "EndWhile", "EndDo", "EndSelect"]);
// HARDY-3 blocks = loops plus conditionals; ENHANCEMENT tracked separately (S4-2).
const BLOCK_OPEN = new Set([...LOOP_OPEN, "If", "Case"]);
const BLOCK_CLOSE = new Set([...LOOP_CLOSE, "EndIf", "EndCase"]);

/** statement constructor name -> finding spec when seen inside a loop. */
const IN_LOOP = {
  Select: { id: "talos-select-in-loop", family: "performance", severity: "priority-1", message: "SELECT inside LOOP causes N+1 database round-trips; batch-read before the loop (ABAP-N1)" },
  SelectLoop: { id: "talos-select-in-loop", family: "performance", severity: "priority-1", message: "Nested SELECT ... ENDSELECT inside a LOOP causes N+1 database round-trips (ABAP-N1)" },
  InsertDatabase: { id: "talos-dml-in-loop", family: "performance", severity: "priority-2", message: "Database INSERT inside LOOP; collect rows and INSERT ... FROM TABLE once (ABAP-PERF-69)" },
  UpdateDatabase: { id: "talos-dml-in-loop", family: "performance", severity: "priority-2", message: "Database UPDATE inside LOOP; use a set-based update (ABAP-PERF-69)" },
  ModifyDatabase: { id: "talos-dml-in-loop", family: "performance", severity: "priority-2", message: "Database MODIFY inside LOOP; use MODIFY ... FROM TABLE (ABAP-PERF-69)" },
  DeleteDatabase: { id: "talos-dml-in-loop", family: "performance", severity: "priority-2", message: "Database DELETE inside LOOP; use a set-based delete (ABAP-PERF-69)" },
  ModifyEntities: { id: "talos-rap-modify-in-loop", family: "rap-odata", severity: "priority-1", message: "RAP MODIFY ENTITIES inside LOOP; pass the full instance table in one call (ABAP-PERF-11)" },
  CommitEntities: { id: "talos-rap-commit-in-loop", family: "rap-odata", severity: "priority-1", message: "RAP COMMIT ENTITIES inside LOOP; commit once after the loop (ABAP-PERF-11)" },
  Commit: { id: "talos-commit-in-loop", family: "performance", severity: "priority-1", message: "COMMIT WORK inside LOOP; commit once per logical unit of work" },
};

/** text/type patterns flagged only inside a loop. `stmts` and `re` AND together. */
const IN_LOOP_PATTERNS = [
  { id: "talos-sync-http-in-loop", family: "performance", severity: "priority-1", re: /\w+->\s*(?:send|receive)\s*\(/i, message: "Synchronous HTTP send/receive inside LOOP; batch or dispatch asynchronously (ABAP-PERF-16)" },
  { id: "talos-free-in-loop", family: "performance", severity: "priority-2", re: /^FREE\b/i, message: "FREE inside LOOP deallocates capacity every iteration; use CLEAR/REFRESH outside the loop (ABAP-PERF-45)" },
  { id: "talos-itab-fulltable-op-in-loop", family: "performance", severity: "priority-2", stmts: ["Sort"], message: "Whole-table SORT inside LOOP is O(n²); sort once after the loop (ABAP-PERF-66)" },
  { id: "talos-itab-fulltable-op-in-loop", family: "performance", severity: "priority-2", stmts: ["DeleteInternal"], re: /\b(?:ADJACENT\s+DUPLICATES|WHERE)\b/i, message: "Whole-table DELETE inside LOOP is O(n²); restructure the loop (ABAP-PERF-66)" },
  { id: "talos-window-function-candidate", family: "performance", severity: "priority-2", re: /^(\w+)\s*=\s*\1\s*[+-]/i, message: "Running total/counter computed per row in an ABAP loop; SQL window function or CDS aggregation candidate (ABAP-PERF-36)" },
  { id: "talos-assign-component-in-loop", family: "performance", severity: "info", re: /^ASSIGN\s+COMPONENT\b/i, message: "ASSIGN COMPONENT inside a loop does per-iteration RTTI lookup; resolve the component once before the loop (ABAP-PERF-46)" },
  { id: "talos-scalar-fn-in-loop", family: "performance", severity: "priority-2", re: /CALL\s+FUNCTION\s+'(?:CONVERT_TO_LOCAL_CURRENCY|CONVERT_TO_FOREIGN_CURRENCY|UNIT_CONVERSION_SIMPLE|CURRENCY_CONVERSION|FISCAL_\w+)'/i, message: "HANA scalar function reimplemented per row via CALL FUNCTION in a loop; push down to CDS/AMDP (ABAP-PERF-35)" },
  { id: "talos-aggregation-in-loop", family: "performance", severity: "priority-2", re: /^COLLECT\b/i, message: "COLLECT aggregation in an ABAP loop; push SUM/COUNT/GROUP BY to a CDS view (ABAP-PERF-2)" },
];

/** single-statement checks, any depth. `re` must match; `notRe` must NOT. */
const STATEMENT_PATTERNS = [
  { id: "talos-enqueue-no-wait", family: "performance", severity: "priority-1", stmts: ["CallFunction"], re: /CALL\s+FUNCTION\s+'ENQUEUE_/i, notRe: /_WAIT/i, message: "ENQUEUE_* without a bounded _WAIT parameter risks unbounded lock wait (ABAP-PERF-33)" },
  { id: "talos-endselect-no-package-size", family: "performance", severity: "priority-2", stmts: ["SelectLoop"], notRe: /PACKAGE\s+SIZE/i, message: "SELECT ... ENDSELECT without PACKAGE SIZE does single-row round-trips (ABAP-PERF-56)" },
  { id: "talos-select-single-no-where", family: "performance", severity: "priority-2", stmts: ["Select"], re: /^SELECT\s+SINGLE\b/i, notRe: /\bWHERE\b/i, message: "SELECT SINGLE without a WHERE clause reads an arbitrary row; constrain the full key (ABAP-PERF-58)" },
  { id: "talos-limit-without-filter", family: "performance", severity: "priority-2", stmts: ["Select", "SelectLoop"], re: /\bUP\s+TO\s+\S+\s+ROWS\b/i, notRe: /\bWHERE\b/i, message: "UP TO n ROWS without a selective WHERE applies the limit after a full scan; filter first (ABAP-PERF-96)" },
  { id: "talos-excessive-secondary-keys", family: "performance", severity: "info", stmts: ["Data", "ClassData", "Types"], re: /(?:\bKEY\b[\s\S]*?){4}/i, message: "internal table declares 4+ keys; every write maintains each key — trim secondary keys (ABAP-PERF-39)" },
  // Moved from the regex pack: statement text is multi-line safe, so the
  // standard ADT class header (FINAL on a continuation line) parses correctly.
  { id: "talos-cloud-005-class-final-abstract", family: "clean-core", severity: "priority-2", stmts: ["ClassDefinition"], notRe: /\b(?:FINAL|ABSTRACT|DEFERRED|LOCAL\s+FRIENDS|FOR\s+TESTING)\b/i, message: "CLASS definition must be FINAL or ABSTRACT in ABAP Cloud (CLOUD-005)" },
];

// CLOUD-021 (coded): abaplint's MODIFY/DELETE classification is syntactic —
// `MODIFY itab FROM wa` parses as ModifyDatabase too — so the check also
// consults the file's DECLARED names: a declared local is an itab, not a
// DDIC table.
const DB_WRITE_STMTS = new Set(["InsertDatabase", "UpdateDatabase", "ModifyDatabase", "DeleteDatabase"]);
const DB_WRITE_TARGET_RE = /^(?:INSERT(?:\s+INTO)?|UPDATE|MODIFY(?:\s+TABLE)?|DELETE(?:\s+FROM)?)\s+(\w+)/i;
const DECLARE_RE = /^(?:CLASS-)?DATA\s+(\w+)/i;

const FAE_RE = /FOR\s+ALL\s+ENTRIES\s+IN\s+@?(\w+)/i;
const MODIFY_WITH_RE = /\bWITH\s+@?(\w+)/i;
const GUARD_LOOKBACK = 6;

// ABAP constructor operators. When a FAE/MODIFY driver is captured as one of these, the
// collection is an inline `WITH VALUE #( … )` / `NEW …` literal — non-empty by construction,
// so a runtime IS NOT INITIAL guard is meaningless and the no-guard finding is a false
// positive. The capture is the operator keyword, not a table variable, so skip it.
const CONSTRUCTOR_OPS = new Set(["VALUE", "NEW", "CONV", "CORRESPONDING", "CAST", "REF", "EXACT", "REDUCE", "FILTER", "COND", "SWITCH"]);

// PERF-14 heuristic: common leading primary-key fields across SAP tables.
// Without DDIC metadata a prefix allowlist is the strongest portable check;
// the finding message states the heuristic.
const COMMON_PK_PREFIX = new Set([
  "MANDT", "BUKRS", "BELNR", "GJAHR", "MATNR", "VBELN", "POSNR", "KUNNR",
  "LIFNR", "WERKS", "EBELN", "EBELP", "AUFNR", "KOKRS", "PERNR", "OBJNR",
  "EQUNR", "TPLNR", "QMNUM", "BANFN", "BNFPO", "RLDNR", "RBUKRS", "CARRID",
  "CONNID", "SPRAS", "LANGU",
]);

export const statementPack = {
  id: "statement-pack",
  family: "statement-pack",
  verdict: "WARN",
  /**
   * @param {import("../src/rule-engine.js").AnalysisContext} ctx
   * @returns {object[]}
   */
  check(ctx) {
    const findings = [];
    const ddic = buildDdicIndex(ctx.reg);
    for (const obj of objectsOf(ctx.reg)) {
      if (!(obj instanceof ABAPObject)) continue;
      for (const file of obj.getABAPFiles()) {
        scanStatements(file, obj, findings, ddic);
      }
    }
    return findings;
  },
};

/**
 * In-bundle TABL key/index knowledge for the DDIC-aware FAE check (PERF-51):
 * table -> { keys, indexLeads } (leading field of each secondary index).
 * @param {import("@abaplint/core").Registry} reg
 * @returns {Map<string, {keys: Set<string>, indexLeads: Set<string>}>}
 */
function buildDdicIndex(reg) {
  const ddic = new Map();
  for (const obj of objectsOf(reg)) {
    if (obj.getType?.() !== "TABL") continue;
    const fields = obj.parsedData?.fields ?? [];
    const keys = new Set(fields.filter((f) => f.KEYFLAG === "X").map((f) => String(f.FIELDNAME).toUpperCase()));
    const indexLeads = new Set(
      (obj.getSecondaryIndexes?.() ?? []).map((i) => String(i.fields?.[0] ?? "").toUpperCase()).filter(Boolean),
    );
    ddic.set(obj.getName().toUpperCase(), { keys, indexLeads });
  }
  return ddic;
}

function scanStatements(file, obj, findings, ddic = new Map()) {
  const stmts = file.getStatements();
  const fileState = { selectSingles: new Map(), unorderedTables: new Set(), fromTables: new Set(), firstSelect: null, declared: new Set(), readHandlers: new Set(), ddic };
  let depth = 0;
  let blockDepth = 0;
  let enhDepth = 0;
  let currentMethod = null;
  for (let i = 0; i < stmts.length; i++) {
    const name = stmts[i].get()?.constructor?.name;
    const text = stmts[i].concatTokens();
    currentMethod = trackMethod(name, text, fileState.readHandlers, currentMethod);

    // Check target BEFORE adjusting depth: a top-level SELECT..ENDSELECT is not
    // "inside a loop"; a nested one (depth > 0) is.
    if (depth > 0) {
      if (IN_LOOP[name]) push(findings, IN_LOOP[name], obj, file, stmts[i]);
      matchPatterns(IN_LOOP_PATTERNS, name, text, findings, obj, file, stmts[i]);
    }
    matchPatterns(STATEMENT_PATTERNS, name, text, findings, obj, file, stmts[i]);
    checkContext(stmts, i, name, text, { blockDepth, enhDepth, fileState, currentMethod }, obj, file, findings);

    if (LOOP_OPEN.has(name)) depth++;
    else if (LOOP_CLOSE.has(name)) depth = Math.max(0, depth - 1);
    if (BLOCK_OPEN.has(name)) blockDepth++;
    else if (BLOCK_CLOSE.has(name)) blockDepth = Math.max(0, blockDepth - 1);
    if (name === "Enhancement") enhDepth++;
    else if (name === "EndEnhancement") enhDepth = Math.max(0, enhDepth - 1);
  }
  reportFileLevel(fileState, obj, file, findings);
}

/** Per-statement context rules (guards, lookbacks, file-state accumulation). */
function checkContext(stmts, i, name, text, ctx, obj, file, findings) {
  if (name === "Select" || name === "SelectLoop") {
    checkGuard(stmts, i, FAE_RE, "talos-fae-no-guard", "SELECT ... FOR ALL ENTRIES on %D% without a preceding IS NOT INITIAL guard (an empty driver reads the whole table) (ABAP-PERF-13)", obj, file, findings);
    checkFaePrefix(text, obj, file, stmts[i], findings, ctx.fileState.ddic);
    checkSelectSinglePartialKey(text, obj, file, stmts[i], findings, ctx.fileState.ddic);
    countSelectSingle(text, stmts[i], ctx.fileState.selectSingles);
    trackSelect(text, stmts[i], ctx.fileState);
  }
  if (name === "ModifyEntities") {
    checkGuard(stmts, i, MODIFY_WITH_RE, "talos-rap-modify-no-guard", "MODIFY ENTITIES on %D% without a preceding IS NOT INITIAL guard on the input collection (ABAP-PERF-12)", obj, file, findings);
    // Method-scoped (not the file-level regex it replaced): a MODIFY ENTITIES only violates
    // ABAP-PERF-78 when it sits inside a FOR READ handler — a read path must not mutate buffer state.
    if (ctx.currentMethod && ctx.fileState.readHandlers.has(ctx.currentMethod)) {
      push(findings, { id: "talos-rap-modify-entities-in-read-handler", family: "rap-odata", severity: "priority-1", message: "EML MODIFY ENTITIES inside a FOR READ handler — read paths must not change buffer state; model side effects as an action/determination (ABAP-PERF-78)." }, obj, file, stmts[i]);
    }
  }
  if (name === "Sort") {
    checkSortAfterSelect(stmts, i, text, obj, file, findings);
  }
  if (name === "Data" || name === "ClassData") {
    const decl = DECLARE_RE.exec(text);
    if (decl) ctx.fileState.declared.add(decl[1].toUpperCase());
    if (ctx.blockDepth > 0) {
      push(findings, { id: "talos-data-in-block", family: "anti-pattern", severity: "priority-2", message: "DATA declared inside an IF/LOOP/CASE block is misleading — ABAP scopes it to the whole method; declare at the top (HARDY-3)" }, obj, file, stmts[i]);
    }
  }
  if (DB_WRITE_STMTS.has(name)) {
    const m = DB_WRITE_TARGET_RE.exec(text);
    const target = m?.[1]?.toUpperCase();
    if (target && !/^[ZYQ]/.test(target) && !ctx.fileState.declared.has(target)) {
      push(findings, { id: "talos-cloud-021-direct-table-write", family: "clean-core", severity: "priority-1", message: `Direct write to SAP-namespace DDIC table ${target} — modify SAP data only through released APIs/BAPIs (CLOUD-021)` }, obj, file, stmts[i]);
    }
  }
  if (name === "CallFunction" && ctx.enhDepth > 0 && /CALL\s+FUNCTION\s+'BAPI_/i.test(text)) {
    push(findings, { id: "talos-bapi-in-enhancement", family: "deprecation", severity: "info", message: "BAPI call inside an ENHANCEMENT block; migrate the enhancement to a RAP action + EML (S4-2)" }, obj, file, stmts[i]);
  }
  if (name === "ReadTable" && /\bBINARY\s+SEARCH\b/i.test(text)) {
    const m = /^READ\s+TABLE\s+(\w+)/i.exec(text);
    if (m && ctx.fileState.unorderedTables.has(m[1].toUpperCase())) {
      push(findings, { id: "talos-binary-search-no-order-by", family: "performance", severity: "priority-2", message: `BINARY SEARCH on ${m[1].toUpperCase()}, which was filled by a SELECT without ORDER BY — the sort order is not guaranteed (ABAP-OB1)` }, obj, file, stmts[i]);
    }
  }
}

/** Track SELECT targets/sources for the file-level rules (OB1, PERF-4). */
function trackSelect(text, st, fileState) {
  // Lookahead excludes internal-table sources (FROM @lt) — only DB tables count.
  const from = /\bFROM\s+(?!@)(\w+)/i.exec(text);
  if (from) {
    fileState.fromTables.add(from[1].toUpperCase());
    if (!fileState.firstSelect) fileState.firstSelect = st;
  }
  if (!/\bORDER\s+BY\b/i.test(text)) {
    const into = /\bINTO\s+TABLE\s+@?(?:DATA\()?(\w+)\)?/i.exec(text);
    if (into) fileState.unorderedTables.add(into[1].toUpperCase());
  }
}

/**
 * RAP handler method context (gap-2a read-handler precision). A `METHODS <name> FOR READ …`
 * definition marks a read handler; the current method is tracked across MethodImplementation →
 * EndMethod so a MODIFY ENTITIES can be scoped to the method it sits in — a file-level regex
 * cannot (it over-matches any behaviour pool). @returns {string|null} current method, UPPERCASE.
 */
function trackMethod(name, text, readHandlers, currentMethod) {
  if (name === "MethodDef") {
    const md = /^METHODS\s+(\w+)\s+FOR\s+READ\b/i.exec(text);
    if (md) readHandlers.add(md[1].toUpperCase());
    return currentMethod;
  }
  if (name === "MethodImplementation") return /^METHOD\s+(\w+)/i.exec(text)?.[1]?.toUpperCase() ?? null;
  if (name === "EndMethod") return null;
  return currentMethod;
}

/** Apply a pattern table to one statement. */
function matchPatterns(patterns, name, text, findings, obj, file, st) {
  for (const p of patterns) {
    if (p.stmts && !p.stmts.includes(name)) continue;
    if (p.re && !p.re.test(text)) continue;
    if (p.notRe && p.notRe.test(text)) continue;
    if (!p.stmts && !p.re) continue;
    push(findings, p, obj, file, st);
  }
}

/**
 * Flag a statement whose driver table (captured by `capRe`) is not proven
 * non-empty by a preceding IS NOT INITIAL / lines( ) check.
 */
function checkGuard(stmts, i, capRe, id, messageTpl, obj, file, findings) {
  const m = capRe.exec(stmts[i].concatTokens());
  if (!m) return;
  const driver = m[1].toUpperCase();
  if (CONSTRUCTOR_OPS.has(driver)) return; // inline constructor collection — non-empty by construction, no guard applies
  for (let j = i - 1; j >= Math.max(0, i - GUARD_LOOKBACK); j--) {
    const t = stmts[j].concatTokens().toUpperCase();
    // Both guard polarities count: `IF drv IS NOT INITIAL.` (wrapping) and
    // `IF drv IS INITIAL. RETURN/EXIT.` (early return) prove non-emptiness,
    // as does a LINES( drv ) comparison. "IS INITIAL" also matches the
    // old-syntax `IF NOT drv IS INITIAL`.
    if (t.includes(driver) && (t.includes("IS NOT INITIAL") || t.includes("IS INITIAL") || t.includes("LINES("))) return;
  }
  push(
    findings,
    { rule_id: id, id, family: id.includes("rap") ? "rap-odata" : "performance", severity: "priority-1", message: messageTpl.replace("%D%", driver) },
    obj,
    file,
    stmts[i]
  );
}

/**
 * PERF-14 / PERF-51: a FOR ALL ENTRIES whose WHERE clause leads with a field
 * that misaligns with the target's index. When the target table is in the
 * bundle (TABL XML), its REAL key fields and secondary-index leads decide
 * (PERF-51, precise); otherwise the common-PK allowlist heuristic applies
 * (PERF-14, stated in the message).
 */
function checkFaePrefix(text, obj, file, st, findings, ddic) {
  if (!FAE_RE.test(text)) return;
  const m = /\bWHERE\s+(\w+)/i.exec(text);
  if (!m) return;
  const lead = m[1].toUpperCase();
  const tableName = /\bFROM\s+(?!@)(\w+)/i.exec(text)?.[1]?.toUpperCase();
  const info = tableName ? ddic?.get(tableName) : undefined;

  if (info) {
    if (info.keys.has(lead) || info.indexLeads.has(lead)) return;
    push(
      findings,
      { id: "talos-fae-unindexed-where", family: "performance", severity: "priority-2", message: `FOR ALL ENTRIES on ${tableName} leads with ${lead}, which is neither a key field nor a secondary-index lead of the table — full scan per driver row (ABAP-PERF-51)` },
      obj,
      file,
      st,
    );
    return;
  }
  if (COMMON_PK_PREFIX.has(lead)) return;
  push(
    findings,
    { id: "talos-fae-nonpk-where-prefix", family: "performance", severity: "priority-2", message: `FOR ALL ENTRIES WHERE clause leads with ${lead}, which is not a common primary-key prefix field — index misalignment risk (heuristic; verify against the table's key) (ABAP-PERF-14)` },
    obj,
    file,
    st,
  );
}

/**
 * PERF-58 (partial-key refinement): a SELECT SINGLE whose WHERE constrains only
 * PART of the target's primary key still returns an arbitrary matching row.
 * Fires only when the table is in the bundle (real key known) and at least one
 * — but not all — of its non-client key fields appears in the WHERE, so it
 * never guesses (out-of-bundle tables and single-field keys stay silent; the
 * base no-WHERE case is the data-row rule talos-select-single-no-where).
 */
function checkSelectSinglePartialKey(text, obj, file, st, findings, ddic) {
  if (!/^SELECT\s+SINGLE\b/i.test(text) || !/\bWHERE\b/i.test(text)) return;
  const tableName = /\bFROM\s+(?!@)(\w+)/i.exec(text)?.[1]?.toUpperCase();
  const info = tableName ? ddic?.get(tableName) : undefined;
  if (!info || info.keys.has(".INCLUDE")) return; // not in bundle, or key hidden by an include
  const realKeys = [...info.keys].filter((k) => k !== "MANDT" && k !== "CLIENT");
  if (realKeys.length < 2) return; // a single-field key cannot be partially constrained
  const where = text.slice(text.search(/\bWHERE\b/i));
  const present = realKeys.filter((k) => new RegExp(`(?<![\\w~])${k}(?![\\w~])`, "i").test(where));
  if (present.length > 0 && present.length < realKeys.length) {
    const missing = realKeys.filter((k) => !present.includes(k));
    push(findings, { id: "talos-select-single-partial-key", family: "performance", severity: "priority-2", message: `SELECT SINGLE on ${tableName} constrains only part of the primary key (missing ${missing.join(", ")}) — it returns an arbitrary matching row; constrain the full key (ABAP-PERF-58)` }, obj, file, st);
  }
}

/** PERF-3: SORT <itab> right after a SELECT ... INTO TABLE <itab> lacking ORDER BY. */
function checkSortAfterSelect(stmts, i, text, obj, file, findings) {
  const m = /^SORT\s+(\w+)/i.exec(text);
  if (!m) return;
  const target = m[1].toUpperCase();
  for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
    const t = stmts[j].concatTokens().toUpperCase();
    if (stmts[j].get()?.constructor?.name === "Select" && t.includes("INTO TABLE") && t.includes(target)) {
      if (!t.includes("ORDER BY")) {
        push(findings, { id: "talos-client-sort-after-select", family: "performance", severity: "priority-2", message: `client-side SORT of ${target} right after its SELECT; add ORDER BY to push sorting to the database (ABAP-PERF-3)` }, obj, file, stmts[i]);
      }
      return;
    }
  }
}

/** HARDY-11: count identical SELECT SINGLE (normalized: INTO clause stripped). */
function countSelectSingle(text, st, counts) {
  if (!/^SELECT\s+SINGLE\b/i.test(text)) return;
  const key = text.toUpperCase().replace(/\bINTO\b.*?(?=\bWHERE\b|$)/s, " ").replace(/\s+/g, " ").trim();
  const rec = counts.get(key) ?? { n: 0, st };
  rec.n++;
  counts.set(key, rec);
}

function reportFileLevel(fileState, obj, file, findings) {
  for (const rec of fileState.selectSingles.values()) {
    if (rec.n >= 3) {
      push(findings, { id: "talos-repeated-select-single", family: "performance", severity: "priority-2", message: `identical SELECT SINGLE repeated ${rec.n}x in this source; read once and cache (HARDY-11)` }, obj, file, rec.st);
    }
  }
  if (fileState.fromTables.size >= 3 && fileState.firstSelect) {
    push(findings, { id: "talos-cds-join-candidate", family: "performance", severity: "info", message: `${fileState.fromTables.size} tables read by separate SELECTs in this source; a single CDS view join may replace them (ABAP-PERF-4)` }, obj, file, fileState.firstSelect);
  }
}

function push(findings, spec, obj, file, st) {
  findings.push({
    rule_id: spec.id,
    severity: spec.severity,
    object: obj.getName(),
    object_type: obj.getType(),
    file: file.getFilename(),
    line: st.getFirstToken()?.getStart()?.getRow?.() ?? 0,
    message: spec.message,
    family: spec.family,
  });
}
