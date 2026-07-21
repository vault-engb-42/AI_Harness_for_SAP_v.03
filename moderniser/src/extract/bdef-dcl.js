/**
 * gap-2b B2 — the BDEF/DCL regex engine (engine 2). @abaplint/core parses neither RAP
 * behaviour definitions nor CDS DCL access controls (B1 probe pins this), so their auth and
 * behaviour features are extracted here by regex (RAP_DEEP_EXTRACTION §3.5). Produces the
 * invariantDiff inputs the AST reader CANNOT — `dcl_restrictions` (the pfcg_auth objects a DCL
 * grants) and `privileged_cds` (WITH PRIVILEGED ACCESS bypasses row-level auth) — plus the
 * composition/lock `edges` parity consumes. Comment-safe (a commented grant never counts) and
 * TOTAL (never throws on malformed input). Pure over a supplied file set.
 */

const DCL_RE = /\.dcls(\.asdcls)?$/i;
const BDEF_RE = /\.bdef(\.asbdef)?$/i;

/** Strip CDS/DCL/BDEF comments (block `/* … */`, then `//` line) so a commented clause never counts. */
function stripComments(src) {
  return String(src ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

const uniqSort = (arr) => [...new Set(arr)].sort();

/**
 * @param {Array<{filename: string, source: string}>} files
 * @returns {{dcl_restrictions: Array<{object: string}>, privileged_cds: Array<{object: string, had_row_auth: boolean}>, edges: Array<{kind: string, source: string, target: string}>}}
 */
export function extractBdefDcl(files) {
  const list = Array.isArray(files) ? files : [];
  const authObjects = [];
  const privileged = [];
  const edges = [];
  for (const f of list) {
    if (!f || typeof f.source !== "string") continue;
    if (DCL_RE.test(f.filename)) {
      const src = stripComments(f.source);
      authObjects.push(...dclAuthObjects(src));
      privileged.push(...privilegedCds(src));
    } else if (BDEF_RE.test(f.filename)) {
      edges.push(...bdefEdges(stripComments(f.source)));
    }
  }
  return {
    // Auth objects are canonical UPPER (matched cross-bundle against AUTHORITY-CHECK objects).
    dcl_restrictions: uniqSort(authObjects).map((object) => ({ object })),
    privileged_cds: privileged,
    edges,
  };
}

/** `… = aspect pfcg_auth( OBJ, … )` → OBJ (namespaced [\w/] names), upper-cased. */
function dclAuthObjects(src) {
  return [...src.matchAll(/aspect\s+pfcg_auth\s*\(\s*([\w/]+)/gi)].map((m) => m[1].toUpperCase());
}

/** A grant carrying `with privileged access` → {object: the granted CDS view (canonical UPPER — ABAP
 * entity names are case-insensitive and invariantDiff compares this CROSS-bundle, before-file vs
 * after-file, so a case-only rewrite must not read as a new privileged grant), had_row_auth: the
 * grant also has a `where` row restriction}. */
function privilegedCds(src) {
  const out = [];
  for (const stmt of src.split(";")) {
    if (!/\bwith\s+privileged\s+access\b/i.test(stmt)) continue;
    const cds = stmt.match(/\bgrant\s+select\s+on\s+([\w/]+)/i);
    if (cds) out.push({ object: cds[1].toUpperCase(), had_row_auth: /\bwhere\b/i.test(stmt) });
  }
  return out;
}

/** Per-entity BDEF segments → lock-dependency edges (resolved to the parent entity via the alias
 * map) and composition association edges (target = the association name). Entities upper-cased. */
function bdefEdges(src) {
  const decls = [...src.matchAll(/define\s+behavior\s+for\s+([\w/]+)(?:\s+alias\s+(\w+))?/gi)];
  const aliasToEntity = new Map();
  for (const d of decls) {
    const entity = d[1].toUpperCase();
    aliasToEntity.set(entity, entity);
    if (d[2]) aliasToEntity.set(d[2].toUpperCase(), entity);
  }
  const edges = [];
  for (let i = 0; i < decls.length; i++) {
    const entity = decls[i][1].toUpperCase();
    const body = src.slice(decls[i].index, i + 1 < decls.length ? decls[i + 1].index : src.length);
    const lockDep = body.match(/\block\s+dependent\s+by\s+_(\w+)/i);
    if (lockDep) {
      const key = lockDep[1].toUpperCase();
      edges.push({ kind: "lock", source: entity, target: aliasToEntity.get(key) ?? `_${key}` });
    }
    for (const a of body.matchAll(/\bassociation\s+_(\w+)/gi)) {
      edges.push({ kind: "composition", source: entity, target: `_${a[1].toUpperCase()}` });
    }
  }
  return edges;
}
