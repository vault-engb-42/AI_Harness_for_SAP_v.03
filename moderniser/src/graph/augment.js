/**
 * Edge over-approximation (MODERNISER_DESIGN §3.1 Stage 1, L5) — augment the static
 * analyser CPG with DYNAMIC edges the parser cannot see, BEFORE Tarjan condensation.
 *
 * The analyser boundary artifact (`graph.edges`) is code-reference only; dynamic
 * indirection is invisible to it. So each node's `source` — populated by the later
 * SCOPE/build phase (offline: the bundled corpus; live: ADT `get_source`), and ABSENT
 * on the raw analyser artifact — is scanned for:
 *   - `CALL FUNCTION <var>`, dynamic method (`->(` / `=>(` / `CALL METHOD (`), dynamic
 *     `SELECT ... FROM (tab)`, dynamic `PERFORM (form)`, BTE/FQEVENTS dispatchers,
 *     `ENHANCEMENT`/`ENHO`/`ENHSPOT` → UNRESOLVED target → `dynamic_seal = NEEDS_MANUAL_SEAM`
 *     (blocks signature-changing modernisation until a human confirms the caller set).
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
const SEAL_PATTERNS = [
  /\bCALL\s+FUNCTION\s+(?!')\S/i, //           CALL FUNCTION <var>  (a literal opens with ')
  /->\s*\(|=>\s*\(|\bCALL\s+METHOD\s+\(/i, //  dynamic method component
  /\bFROM\s*\(\s*[\w~/]+\s*\)/i, //            dynamic SELECT ... FROM (tab)  (not a derived table)
  /\bPERFORM\s*\(/i, //                        dynamic PERFORM (form)
  /OPEN_FI_PERFORM|FQEVENTS|\bBTE_/i, //       Business Transaction Events dispatcher (customizing-driven)
  /\bENHANCEMENT\b|\bENHO\b|\bENHSPOT\b/i, //  runtime enhancement injection
];

// Resolvable indirection with a literal target → a synthetic edge (captured group 1).
const RESOLVABLE = [
  { re: /\bPERFORM\s+([\w~/]+)\s+ON\s+COMMIT/i, kind: "perform-on-commit" },
  { re: /\bSET\s+HANDLER\s+([\w~/=>]+)\s+FOR\b/i, kind: "set-handler" },
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
    const line = stripComment(raw);
    if (!line.trim()) continue;
    for (const { re, kind } of RESOLVABLE) {
      const m = re.exec(line);
      if (m) out.synthetic.push({ target: m[1].toUpperCase(), kind });
    }
    if (SEAL_PATTERNS.some((p) => p.test(line))) out.sealed = true;
  }
  return out;
}

/** Strip an ABAP comment: a full-line `*` comment, or an inline `"` outside a '...' literal. */
function stripComment(line) {
  if (/^\s*\*/.test(line)) return ""; // no valid statement begins with '*'
  let inStr = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === "'") inStr = !inStr;
    else if (c === '"' && !inStr) return line.slice(0, i);
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
