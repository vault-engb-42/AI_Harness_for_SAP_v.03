/**
 * Edge over-approximation (MODERNISER_DESIGN §3.1 Stage 1, L5) — augment the static
 * analyser CPG with DYNAMIC edges the parser cannot see, BEFORE Tarjan condensation.
 *
 * The analyser boundary artifact (`graph.edges`) is code-reference only; dynamic
 * indirection is invisible to it. So each node's `source` — populated by the later
 * SCOPE/build phase (offline: the bundled corpus; live: ADT `get_source`), and ABSENT
 * on the raw analyser artifact — is scanned for:
 *   - `CALL FUNCTION <var>`, dynamic method (`->(` / `=>(` / `CALL METHOD (`), dynamic
 *     `SELECT ... FROM (tab)`, dynamic write-DML `UPDATE/INSERT/MODIFY/DELETE (tab)`,
 *     dynamic `PERFORM (form)`, `PERFORM form(prog) ON COMMIT`, `CALL/LEAVE TO TRANSACTION
 *     <var>`, `CREATE OBJECT … TYPE (var)`, kernel `GET/CALL BADI`, BTE/FQEVENTS
 *     dispatchers, `ENHANCEMENT`/`ENHO`/`ENHSPOT` → UNRESOLVED target →
 *     `dynamic_seal = NEEDS_MANUAL_SEAM` (blocks signature-changing modernisation until a
 *     human confirms the caller set).
 *   - `PERFORM <form> ON COMMIT`, `SET HANDLER <m> FOR <o>` (literal target) → synthetic edge.
 * A synthetic edge whose target already reaches its source over the code edges closes a
 * cycle and is tagged `possible_cycle`. Design principle (L5): fail toward "human decides
 * ordering" whenever the edge set is known-incomplete — over-approximate, never under.
 *
 * Pure. No I/O. Never mutates the input CPG. Deterministic: synthetic edges are deduped
 * and sorted, so the augmentation is byte-stable across runs. Reachability is ITERATIVE
 * (no recursion) for the 100K+-LOC scale NFR.
 *
 * @param {{nodes: Array<{id: string, source?: string}>, edges: Array<{source: string, target: string, kind?: string, evidence?: string}>}} cpg
 * @returns {{nodes: Array<object>, edges: Array<object>}} G_ref = code_edges ∪ synthetic
 */
export const NEEDS_MANUAL_SEAM = "NEEDS_MANUAL_SEAM";

// Unresolved dynamic indirection → seal the node (target is not statically knowable).
// Scanned on the COMMENT-STRIPPED line — these are live statements.
const SEAL_PATTERNS = [
  /\bCALL\s+FUNCTION\s+(?!')\S/i, //           CALL FUNCTION <var>  (a literal opens with ')
  /->\s*\(|=>\s*\(|\bCALL\s+METHOD\s+\(/i, //  dynamic method component
  /\bFROM\s*\(\s*[\w~/]+\s*\)/i, //            dynamic SELECT ... FROM (tab)  (not a derived table)
  /\bPERFORM\s*\(/i, //                        dynamic PERFORM (form)
  /\bSET\s+HANDLER\s+\(/i, //                  dynamic SET HANDLER (var)
  /\bSUBMIT\s*\(/i, //                         dynamic SUBMIT (report)
  /\bGENERATE\s+SUBROUTINE\s+POOL\b|\bINSERT\s+REPORT\b/i, // runtime code generation (backdoor pattern, security.md)
  /\bCALL\s+TRANSFORMATION\s*\(/i, //          dynamic CALL TRANSFORMATION (name)
  /\bCALL\s+CUSTOMER-FUNCTION\b/i, //          classic customer exit (customizing-driven)
  /OPEN_FI_PERFORM|FQEVENTS|\bBTE_|SWE_EVENT_CREATE/i, // BTE / FQEVENTS / workflow-event dispatch (table-driven)
  // --- round-2 families (branch-review F8 — L5: over-approximate, never under) ---
  /\b(?:UPDATE|INSERT|MODIFY|DELETE)\s+\(\s*[\w~/]+\s*\)/i, // dynamic write-DML target (the read side seals via FROM ( above)
  /\b(?:CALL|LEAVE\s+TO)\s+TRANSACTION\s+(?!')\S/i, //       dynamic transaction (a literal tcode opens with ')
  /\bCREATE\s+OBJECT\s+\S+\s+TYPE\s*\(/i, //                 dynamic class instantiation TYPE (var)
  /\b(?:GET|CALL)\s+BADI\b/i, //                             kernel BAdI dispatch (filter/customizing-driven callee set)
  /\bPERFORM\s+[\w~/]+\s*\(\s*[\w~/]+\s*\)\s+ON\s+COMMIT/i, // PERFORM form(prog) ON COMMIT — cross-program late call
  /\bINSERT\s+INTO\s*\(/i, //                                dynamic write-DML, INTO form (F8-escape review)
  /\bPERFORM\s+[\w~/]+\s+IN\s+PROGRAM\b[^."]*\bON\s+COMMIT/i, // PERFORM f IN PROGRAM p ON COMMIT — same late call, keyword form
  /\bPERFORM\s+[\w~/]+\s+IN\s+PROGRAM\s*\(/i, //             dynamic program name — unknowable callee
];

// Enhancement markers are load-bearing COMMENTS in abapGit-serialized source
// (`*ENHANCEMENT-POINT …`, `"{ Begin ENHO … }`), so they MUST be scanned on the RAW
// (pre-strip) line. MARKER SHAPES only (L6 review): the bare word "enhancement" is common
// English in SAP prose comments — sealing on it parks large corpus fractions behind
// spurious seam confirmations. Matched: ENHANCEMENT-POINT/-SECTION <id>, the numbered
// implementation statement `ENHANCEMENT n …`, END-ENHANCEMENT, abapGit `"{ Begin ENHO`,
// and ENHSPOT.
const RAW_SEAL_PATTERNS = [
  /^\s*\*?\s*ENHANCEMENT(?:-POINT|-SECTION)\s+\S|^\s*ENHANCEMENT\s+\d|^\s*END-ENHANCEMENT\b|"\{\s*Begin\s+ENHO\b|\bENHSPOT\b/i,
];

// Resolvable indirection with a literal target → a synthetic edge. `multi` splits the
// captured token run into one edge per target; a target containing `(` is dynamic → seal.
// The regexes carry /g and are consumed via matchAll: ABAP chains statements on one
// physical line, and a once-per-line exec silently lost the second edge (L5 review).
const RESOLVABLE = [
  { re: /\bPERFORM\s+([\w~/]+)\s+ON\s+COMMIT/gi, kind: "perform-on-commit" },
  { re: /\bSET\s+HANDLER\s+(.+?)\s+FOR\b/gi, kind: "set-handler", multi: true },
];

export function overApproximateEdges(cpg) {
  const synthetic = [];
  const nodes = cpg.nodes.map((n) => {
    const scan = scanNode(n);
    for (const s of scan.synthetic) synthetic.push({ source: n.id, target: s.target, kind: s.kind });
    return scan.sealed ? { ...n, dynamic_seal: NEEDS_MANUAL_SEAM } : { ...n };
  });

  const codeAdj = adjacency(cpg.edges);
  const synEdges = dedupe(synthetic).map((e) => {
    const edge = { source: e.source, target: e.target, kind: e.kind, synthetic: true, evidence: `augment:${e.source}` };
    if (reachable(e.target, e.source, codeAdj)) edge.possible_cycle = true; // closes a cycle over code edges
    return edge;
  });

  return { nodes, edges: [...cpg.edges, ...synEdges] };
}

/** Scan one node's source. @returns {{synthetic: Array<{target: string, kind: string}>, sealed: boolean}} */
function scanNode(node) {
  const out = { synthetic: [], sealed: false };
  if (!node.source) return out;
  for (const raw of node.source.split(/\r?\n/)) {
    if (RAW_SEAL_PATTERNS.some((p) => p.test(raw))) out.sealed = true; // markers live in comments — scan pre-strip
    const line = stripComment(raw);
    if (!line.trim()) continue;
    for (const { re, kind, multi } of RESOLVABLE) {
      for (const m of line.matchAll(re)) {
        for (const t of multi ? m[1].trim().split(/\s+/) : [m[1]]) {
          if (t.includes("(")) out.sealed = true; // dynamic target -> seal, not a malformed edge
          else out.synthetic.push({ target: t.toUpperCase(), kind });
        }
      }
    }
    if (SEAL_PATTERNS.some((p) => p.test(line))) out.sealed = true;
  }
  return out;
}

/**
 * Strip an ABAP comment: a full-line `*` comment, or an inline `"` that is OUTSIDE any
 * string literal. ABAP has three literal delimiters — `'…'` char, `` `…` `` string, and
 * `|…|` template (with `\` escaping `|`/`{`/`}`) — and a `"` inside any of them is data,
 * not a comment. Stripping such a `"` would drop trailing real code (under-approximation).
 */
function stripComment(line) {
  if (/^\*/.test(line)) return ""; // ABAP full-line comments require '*' in COLUMN 1 — an
  // indented '*' is code (e.g. a SELECT field list on a continuation line); erasing it
  // would hide dynamic constructs from the seal scan (under-approximation, L4 review)
  let delim = null; // "'", "`", or "|" when inside a literal
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (delim === "|" && c === "\\") i += 1; // template escape: \| \{ \}
    else if (delim) {
      if (c === delim) delim = null;
    } else if (c === "'" || c === "`" || c === "|") delim = c;
    else if (c === '"') return line.slice(0, i);
  }
  return line;
}

/** Directed adjacency over the code edges only. @returns {Map<string, string[]>} */
function adjacency(edges) {
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source).push(e.target);
  }
  return adj;
}

/** Iterative reachability `from →* to` over `adj` (no recursion — deep chains at scale). */
function reachable(from, to, adj) {
  if (from === to) return true;
  const seen = new Set([from]);
  const stack = [from];
  while (stack.length) {
    for (const nx of adj.get(stack.pop()) || []) {
      if (nx === to) return true;
      if (!seen.has(nx)) {
        seen.add(nx);
        stack.push(nx);
      }
    }
  }
  return false;
}

/** Dedupe synthetic edges by (source, target, kind) and sort for byte-stability. */
function dedupe(edges) {
  const seen = new Set();
  const out = [];
  for (const e of edges) {
    const k = JSON.stringify([e.source, e.target, e.kind]); // separator-safe for arbitrary ids
    if (!seen.has(k)) {
      seen.add(k);
      out.push(e);
    }
  }
  out.sort((a, b) =>
    a.source !== b.source ? cmp(a.source, b.source) : a.target !== b.target ? cmp(a.target, b.target) : cmp(a.kind, b.kind),
  );
  return out;
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
