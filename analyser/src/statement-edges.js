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
    for (const st of file.getStatements()) {
      const desc = descriptorFor(st.get(), st.getTokens());
      if (!desc) continue;
      const row = st.getFirstToken()?.getStart()?.getRow?.() ?? 0;
      edges.push({ ...desc, evidence: `${filename}:${row}` });
    }
  }
  return edges;
}

/**
 * @param {object} grammar st.get() grammar instance
 * @param {import("@abaplint/core").Token[]} tokens
 * @returns {Omit<EdgeDescriptor, "evidence">|null}
 */
function descriptorFor(grammar, tokens) {
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
