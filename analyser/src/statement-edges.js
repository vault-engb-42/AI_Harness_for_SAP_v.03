import { Statements } from "@abaplint/core";

/**
 * Statement-AST edge extraction — the CPG relationships that do NOT surface in
 * the SyntaxLogic reference stream: CALL FUNCTION, AUTHORITY-CHECK, INCLUDE,
 * GET BADI. Attribution is object-level (the caller sets source = object name);
 * that is sufficient for blast-radius, which aggregates affected nodes to their
 * owning object via each node's `.object` field.
 *
 * Each descriptor is `{ kind, target, targetKind, evidence }`. `targetKind` is
 * the node kind to materialize when the target's kind is known with confidence
 * (call-function -> function); it is null for edge-only dependencies whose
 * target is not a schema NodeKind (auth object, include program, BADI handle).
 *
 * @typedef {{kind: string, target: string, targetKind: string|null, evidence: string}} EdgeDescriptor
 */

const QUOTED = /^'(.*)'$/;

/** @param {string} s */
function stripQuotes(s) {
  const m = QUOTED.exec(s);
  return (m ? m[1] : s).toUpperCase();
}

/**
 * @param {import("@abaplint/core").Token[]} tokens
 * @param {string} keyword uppercased keyword to search for
 * @returns {import("@abaplint/core").Token|undefined} the token following it
 */
function tokenAfter(tokens, keyword) {
  const i = tokens.findIndex((t) => t.getStr().toUpperCase() === keyword);
  return i >= 0 && i + 1 < tokens.length ? tokens[i + 1] : undefined;
}

/**
 * @param {import("@abaplint/core").IObject} obj an ABAPObject
 * @returns {EdgeDescriptor[]}
 */
export function collectStatementEdges(obj) {
  /** @type {EdgeDescriptor[]} */
  const edges = [];
  for (const file of obj.getABAPFiles?.() ?? []) {
    const filename = file.getFilename();
    // F-9.3: statements between EXEC SQL and ENDEXEC are NATIVE SQL, and abaplint gives them their own
    // statement type carrying the raw tokens. Tracked as a state pair rather than by instanceof, because
    // `Statements.NativeSQL` IS NOT EXPORTED — the constructor is named that, the export does not exist, so
    // `instanceof Statements.NativeSQL` is `instanceof undefined` and throws. ExecSQL/EndExec are exported.
    let inNative = false;
    for (const st of file.getStatements()) {
      const grammar = st.get();
      if (grammar instanceof Statements.ExecSQL) { inNative = true; continue; }
      if (grammar instanceof Statements.EndExec) { inNative = false; continue; }
      const desc = inNative ? nativeSqlDescriptor(st.getTokens()) : descriptorFor(grammar, st.getTokens());
      if (!desc) continue;
      const row = st.getFirstToken()?.getStart()?.getRow?.() ?? 0;
      edges.push({ ...desc, evidence: `${filename}:${row}` });
    }
  }
  return edges;
}

/** A bare, unambiguous identifier. Anything else is not evidence of a DDIC table. */
const BARE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The table a NATIVE SQL statement targets, or null (F-9.3).
 *
 * Native SQL is free-form text to the parser, not a typed grammar, so this is deliberately the most
 * conservative reading that is still useful: only the four unambiguous DML head positions, only a bare
 * identifier, and nothing at all otherwise. The failure this guards against is manufacturing ownership —
 * `owns_customer_table` is what earns an object a managed RAP BO root, and deriving it from a name that
 * might be a schema, a synonym, a view or a host variable would conjure a Business Object for an object
 * that owns nothing. Emitting nothing costs the object an edge; emitting the wrong thing costs it a
 * wrong architecture, and only one of those is recoverable.
 *
 * Two limits worth stating rather than hiding, both measured against @abaplint/core 2.119.53:
 *   - a schema-qualified target (`UPDATE myschema.zorders`) is SPLIT across statements at the `.`, so the
 *     fragment reads `UPDATE myschema .` — rejected here by the trailing-dot check, never claimed;
 *   - a column-qualified select (`SELECT a.id FROM t`) is split the same way, so its FROM lands in a
 *     fragment that does not start with SELECT and yields nothing. Under-reporting, by design;
 *   - the tokenizer STRIPS the host-variable colon, so `INSERT INTO :target` is indistinguishable from a
 *     real table name. That one cannot be detected here and is not claimed to be.
 */
function nativeSqlDescriptor(tokens) {
  const words = tokens.map((t) => t.getStr());
  const head = words[0]?.toUpperCase();
  const at = (i) => (words[i + 1] === "." ? null : words[i]); // a following dot means qualified/truncated
  const afterKeyword = (kw) => {
    const i = words.findIndex((w) => w.toUpperCase() === kw);
    return i >= 0 && i + 1 < words.length ? at(i + 1) : null;
  };

  let name = null;
  let access = null;
  if (head === "SELECT") { name = afterKeyword("FROM"); access = "read"; }
  else if (head === "INSERT") { name = afterKeyword("INTO"); access = "write"; }
  else if (head === "UPDATE") { name = at(1); access = "write"; }
  else if (head === "DELETE") { name = afterKeyword("FROM") ?? at(1); access = "write"; }

  if (!name || !BARE_IDENTIFIER.test(name)) return null;
  return { kind: "uses-table", target: name.toUpperCase(), targetKind: "table", access };
}

/**
 * The DATABASE table a write statement targets, or null. Each ABAP write names its table in a different
 * position, so the token is taken per statement shape rather than guessed:
 *   INSERT <tab> FROM ...   /  UPDATE <tab> SET ...  /  MODIFY <tab> FROM ...  — the table follows the keyword
 *   DELETE FROM <tab> ...   — and also the bare `DELETE <tab>` form
 * A dynamic target ( `(lv_tab)` ) or a host variable ( `@lt` ) is skipped exactly as the read path skips them:
 * an unresolvable name is not evidence.
 */
function writtenTable(grammar, tokens) {
  const isWrite = grammar instanceof Statements.InsertDatabase
    || grammar instanceof Statements.UpdateDatabase
    || grammar instanceof Statements.ModifyDatabase
    || grammar instanceof Statements.DeleteDatabase;
  if (!isWrite) return null;
  const first = tokens[0]?.getStr()?.toUpperCase();
  // DELETE FROM <tab>; every other form names the table immediately after the keyword.
  const t = first === "DELETE" ? (tokenAfter(tokens, "FROM") ?? tokens[1]) : tokens[1];
  const name = t?.getStr();
  if (!name || name.startsWith("@") || name.startsWith("(")) return null;
  return name.toUpperCase();
}

/**
 * @param {object} grammar st.get() grammar instance
 * @param {import("@abaplint/core").Token[]} tokens
 * @returns {Omit<EdgeDescriptor, "evidence">|null}
 */
function descriptorFor(grammar, tokens) {
  if (grammar instanceof Statements.Select || grammar instanceof Statements.SelectLoop) {
    const t = tokenAfter(tokens, "FROM");
    if (!t) return null;
    const name = t.getStr();
    // Skip dynamic ( FROM (lv_tab) ) and internal-table ( FROM @lt ) sources.
    if (name.startsWith("@") || name.startsWith("(")) return null;
    return { kind: "uses-table", target: name.toUpperCase(), targetKind: "table", access: "read" };
  }
  // WRITES. Until R3a the CPG saw reads only, so no consumer could distinguish a reader from a writer — and
  // an independent review failed four re-architecture recommendations that put a managed, draft-enabled RAP
  // Business Object on objects which never write. A managed BO exists to own and mutate data; that claim now
  // has an evidence channel. abaplint types the DATABASE variants separately from the internal-table ones
  // (InsertDatabase vs InsertInternal), so an itab operation is never mistaken for persistence.
  const written = writtenTable(grammar, tokens);
  if (written) return { kind: "uses-table", target: written, targetKind: "table", access: "write" };
  if (grammar instanceof Statements.CallFunction) {
    const lit = tokens.find((t) => t.getStr().startsWith("'"));
    if (!lit) return null; // dynamic CALL FUNCTION <var> — no static target
    return { kind: "call-function", target: stripQuotes(lit.getStr()), targetKind: "function" };
  }
  if (grammar instanceof Statements.AuthorityCheck) {
    const t = tokenAfter(tokens, "OBJECT");
    if (!t) return null;
    return { kind: "authority-check", target: stripQuotes(t.getStr()), targetKind: null };
  }
  if (grammar instanceof Statements.Include) {
    const t = tokenAfter(tokens, "INCLUDE");
    if (!t) return null;
    return { kind: "includes", target: t.getStr().toUpperCase(), targetKind: null };
  }
  if (grammar instanceof Statements.GetBadi) {
    const t = tokenAfter(tokens, "BADI");
    if (!t) return null;
    // Target is the handle variable; the concrete BADI spot is the handle's
    // type (resolved later). Edge-only: the dependency signal is what matters.
    return { kind: "get-badi", target: t.getStr().toUpperCase(), targetKind: null };
  }
  return null;
}
