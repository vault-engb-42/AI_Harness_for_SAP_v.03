import { createHash } from "node:crypto";
import { sourceHash } from "../../../analyser/src/run-identity.js";
import { extractAst } from "./ast-reader.js";
import { extractBdefDcl } from "./bdef-dcl.js";

/**
 * gap-2b B4 — bundle assembly. Merges engine 1 (`ast-reader`, plain ABAP via @abaplint/core) and
 * engine 2 (`bdef-dcl`, the RAP/DCL regex parser) into ONE per-side feature bundle carrying:
 *   - the 4-field `invariantDiff` INPUT (`auth_checks, dcl_restrictions, commit_work, privileged_cds`);
 *   - the parity classify signals + the §15.4 deduction counters;
 *   - the analyser's CPG nodes/edges, which is the granularity the diff keys on — NOT text
 *     (devepos R1), so a comment or whitespace edit spawns no phantom `changed_edges`. Edge
 *     `evidence` (file:line) is deliberately DROPPED for exactly that reason.
 *
 * SCALE (devepos R2 / the 100K+ LOC NFR): the bundle is hash-keyed by the analyser's existing
 * `source_hash`, so a revisit of an unchanged side is an O(1) cache hit rather than a re-parse.
 * The BEFORE side is extracted once per run and reused across every node — a per-node
 * `analyzePackage` rescan would be O(N²) and is explicitly forbidden by the build contract.
 *
 * The caller owns running `analyzePackage` and passes the doc as `opts.analysis` (same division of
 * labour as `node/rule-gate.js`). Without it the bundle still carries every engine-1/2 feature and
 * simply has no CPG view — degraded, never broken. Pure + total.
 */

const asArray = (x) => (Array.isArray(x) ? x : []);

/** A fresh BEFORE-bundle cache. Keyed by `source_hash`; the caller owns its lifetime (per run). */
export const createBundleCache = () => new Map();

/**
 * @param {Array<{filename: string, source: string}>} files
 * @param {{analysis?: object, cache?: Map<string, object>}} [opts]
 * @returns {Readonly<object>} the frozen per-side feature bundle
 */
export function assembleBundle(files, opts = {}) {
  const list = asArray(files).filter((f) => f && typeof f.source === "string");
  const source_hash = sourceHash(list);
  const cached = opts.cache?.get(source_hash);
  if (cached) return cached;

  const ast = extractAst(list);
  const rap = extractBdefDcl(list);
  const bundle = Object.freeze({
    source_hash,
    file_hashes: fileHashes(list),
    // invariantDiff INPUT — 4/4, exactly the shape `invariants.js` normalises.
    auth_checks: ast.auth_checks,
    dcl_restrictions: rap.dcl_restrictions,
    commit_work: ast.commit_work,
    privileged_cds: rap.privileged_cds,
    // parity classify signals
    money_operands: ast.money_operands,
    statement_kinds: ast.statement_kinds,
    rap_edges: rap.edges,
    cpg_edges: cpgEdges(opts.analysis),
    cpg_nodes: cpgNodes(opts.analysis),
    blast_radius: blastRadius(opts.analysis),
    plan_successors: planSuccessors(opts.analysis),
    // §15.4 deduction counters (deltas are computed in bundle-diff.js)
    client_specified: ast.client_specified,
    exception_paths: ast.exception_paths,
    cfg_branches: ast.cfg_branches,
    max_nesting: ast.max_nesting,
  });
  opts.cache?.set(source_hash, bundle);
  return bundle;
}

/** The exact 4-field slice `invariantDiff` consumes — passing the whole bundle would still work,
 *  but the narrow slice is what keeps the P4 judge's input contract auditable. */
export function invariantInput(bundle = {}) {
  return {
    auth_checks: bundle.auth_checks ?? [],
    dcl_restrictions: bundle.dcl_restrictions ?? [],
    commit_work: bundle.commit_work ?? 0,
    privileged_cds: bundle.privileged_cds ?? [],
  };
}

/** Per-file content SHA — the `reassembly_broken` veto's input (L0: an untouched byte changed). */
function fileHashes(files) {
  const out = {};
  for (const f of files) {
    out[f.filename] = createHash("sha256").update(String(f.source).replace(/\r\n?/g, "\n"), "utf8").digest("hex");
  }
  return out;
}

/** CPG edges WITHOUT `evidence` — dropping file:line is what makes the diff node-granular (R1). */
function cpgEdges(analysis) {
  return asArray(analysis?.graph?.edges)
    .filter((e) => e && e.source != null && e.target != null)
    .map((e) => ({ source: String(e.source), target: String(e.target), kind: String(e.kind ?? "") }));
}

function cpgNodes(analysis) {
  return asArray(analysis?.graph?.nodes).filter((n) => n?.id != null).map((n) => String(n.id));
}

/** `{object, successor_kind}` — the analyser's TADIR-style successor vocabulary parity classifies on. */
function blastRadius(analysis) {
  return asArray(analysis?.blast_radius)
    .filter((b) => b?.object != null && b.successor_kind != null)
    .map((b) => ({ object: String(b.object).toUpperCase(), successor_kind: String(b.successor_kind) }));
}

/** Plan transformations naming a `released_successor`. The §6.2 contract carries the successor as a
 *  NAME with no kind token; resolving the kind is the diff extractor's owed step (parity.js:43-45),
 *  discharged in `bundle-diff.js` against the blast-radius map. */
function planSuccessors(analysis) {
  const out = [];
  for (const obj of asArray(analysis?.modernization_plan?.objects)) {
    for (const t of asArray(obj?.transformations)) {
      if (t?.released_successor) out.push(String(t.released_successor).toUpperCase());
    }
  }
  return [...new Set(out)].sort();
}
