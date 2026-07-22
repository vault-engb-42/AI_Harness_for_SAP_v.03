/**
 * gap-2b B4 — the before/after DIFF. Turns two `assembleBundle` sides into the feature bundle
 * `parity.js` consumes, emitting ALL 12 fields it reads: the four classify signals
 * (`changed_edges, transformations, money_operands, statement_kind_changes`), `client_specified_delta`,
 * the `paradigm_shift` band override, the two vetoes (`auth_vanished, reassembly_broken`) and the
 * four §15.4 deductions (`auth_object_changed, exception_path_dropped, cfg_branch_regression,
 * max_nesting_regression`). The count is asserted by a test, because the design doc's original
 * enumeration said "12" while listing 11 — it was written before B0 deleted `def_use_lost`, and
 * `paradigm_shift` restores the total honestly rather than by arithmetic coincidence.
 * A 4-field extractor produces no deduction signals → `score = 1` always → a PERMANENT FALSE-GREEN;
 * that is the trap this module exists to close.
 *
 * ONE INVARIANT RUNS THROUGH EVERY FIELD: each is a **DELTA, never a snapshot.** An unchanged
 * before/after pair must yield an entirely inert diff — otherwise a node that changed nothing
 * would still owe mandatory-parity evidence (F14). So `money_operands` is the symmetric difference,
 * not the union; the deductions compare counts; `changed_edges` compares CPG-node adjacency.
 *
 * The deductions all read "the after has LESS structure than the before" (§15.4: a rewrite that
 * silently drops an exception path, a branch, or a nesting level has dropped semantics). They are
 * scored, not vetoed — parity is a conservative proxy for an undecidable property, never a proof.
 *
 * Pure + total: a missing or malformed side degrades to an inert diff rather than throwing (P8).
 */

const asArray = (x) => (Array.isArray(x) ? x : []);
const num = (x) => (Number.isFinite(x) ? x : 0);
// Composite-key separator. CONSTRUCTED, never a literal NUL byte in source: no ABAP identifier,
// edge kind or type name can contain it, so `${source}${SEP}${kind}` is unambiguous.
const SEP = String.fromCharCode(0);

/**
 * @param {object} before an `assembleBundle` bundle
 * @param {object} after an `assembleBundle` bundle
 * @param {{touched_files?: string[]}} [opts] the files this node was ALLOWED to rewrite — the
 *   `reassembly_broken` veto asserts a positive fact (an untouched file's bytes changed), so with
 *   no declared touched set it cannot be asserted and stays false.
 * @returns {object} the 12-field parity diff bundle
 */
export function diffBundles(before, after, opts = {}) {
  const b = before ?? {};
  const a = after ?? {};
  // An imperative → declarative rewrite (B6.5 F10). The three structure deductions below are
  // IMPERATIVE measures; a faithful RAP rewrite moves that structure into CDS and BDEF artifacts
  // they cannot see, so firing them scored the canonical modernisation 0.25 → `scope_reduced`,
  // which is non-attestable and burned the cycle budget to a ceiling BLOCK. Suppressing them here
  // is not a softening: `parity.js` routes a paradigm shift to `needs_review`, so such a node still
  // NEVER auto-passes — it goes to the human who can actually judge the equivalence.
  const paradigm_shift = num(a.declarative_artifacts) > 0 && num(b.declarative_artifacts) === 0;
  const comparable = (worse) => (paradigm_shift ? false : worse);
  return {
    changed_edges: changedEdges(b, a),
    transformations: transformations(b, a),
    money_operands: symmetricMoney(b, a),
    statement_kind_changes: statementKindChanges(b, a),
    client_specified_delta: num(b.client_specified) !== num(a.client_specified),
    paradigm_shift,
    auth_vanished: authScope(b) > 0 && authScope(a) === 0,
    reassembly_broken: reassemblyBroken(b, a, opts.touched_files),
    auth_object_changed: !setEqual(authObjects(b), authObjects(a)),
    exception_path_dropped: comparable(num(a.exception_paths) < num(b.exception_paths)),
    cfg_branch_regression: comparable(num(a.cfg_branches) < num(b.cfg_branches)),
    max_nesting_regression: comparable(num(a.max_nesting) < num(b.max_nesting)),
  };
}

/**
 * CPG adjacency diff at NODE granularity (devepos R1). Edges are grouped by `(source, kind)` and
 * compared as target SETS, so a comment/whitespace edit — which moves every `evidence` line but no
 * node — produces nothing. A removed target reads `target_after: null` and an added one
 * `target_before: null`; parity's data-source test is `target_before !== target_after`, so a
 * dropped or introduced data source classifies exactly like a swapped one.
 */
function changedEdges(b, a) {
  const bg = groupEdges(b.cpg_edges);
  const ag = groupEdges(a.cpg_edges);
  const out = [];
  for (const key of [...new Set([...bg.keys(), ...ag.keys()])].sort()) {
    const [source, kind] = key.split(SEP);
    const bt = bg.get(key) ?? new Set();
    const at = ag.get(key) ?? new Set();
    for (const t of [...bt].filter((x) => !at.has(x)).sort()) {
      out.push({ kind, source, target_before: t, target_after: null });
    }
    for (const t of [...at].filter((x) => !bt.has(x)).sort()) {
      out.push({ kind, source, target_before: null, target_after: t });
    }
  }
  return out;
}

function groupEdges(edges) {
  const map = new Map();
  for (const e of asArray(edges)) {
    const key = `${e.source}${SEP}${e.kind}`;
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(e.target);
  }
  return map;
}

/**
 * A released-API swap: a BEFORE object that the analyser gave a released successor for and that is
 * no longer in the AFTER CPG — i.e. the modernisation actually performed the swap. Plan
 * transformations that name a `released_successor` are folded in through the same blast-radius map,
 * which is the kind-resolution step `parity.js` records as owed by this extractor.
 */
function transformations(b, a) {
  const afterNodes = new Set(asArray(a.cpg_nodes).map((n) => n.toUpperCase()));
  const kindByObject = new Map(asArray(b.blast_radius).map((x) => [x.object, x.successor_kind]));
  // "Left the CPG" is only decidable when the AFTER side actually HAS a CPG. With no after-graph
  // (the caller supplied an analysis doc for one side only) every blast-radius object would read as
  // swapped — a phantom on a node that changed nothing. Absence of evidence, not evidence of a swap.
  const swapped = afterNodes.size === 0
    ? []
    : asArray(b.blast_radius).filter((x) => !afterNodes.has(x.object)).map((x) => x.object);
  const named = asArray(b.plan_successors).filter((n) => kindByObject.has(n));
  return [...new Set([...swapped, ...named])]
    .sort()
    .map((object) => ({ kind: "released-api", object, successor_kind: kindByObject.get(object) }));
}

/** Money operands ADDED or REMOVED. Union would make every unchanged money-touching node owe
 *  currency-matrix evidence forever; the symmetric difference is the actual change. */
function symmetricMoney(b, a) {
  const key = (m) => `${m.field}${SEP}${m.type}`;
  const bm = new Map(asArray(b.money_operands).map((m) => [key(m), m]));
  const am = new Map(asArray(a.money_operands).map((m) => [key(m), m]));
  const out = [];
  for (const [k, m] of bm) if (!am.has(k)) out.push(m);
  for (const [k, m] of am) if (!bm.has(k)) out.push(m);
  return out.sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));
}

/** Read-idiom migrations parity scores: SELECT→EML from engine 1's statement counts, and
 *  CALL-FUNCTION→CALL-METHOD from the CPG call edges (engine 1 does not count those kinds). */
function statementKindChanges(b, a) {
  const out = [];
  const eml = (x) => num(x.statement_kinds?.read_entities) + num(x.statement_kinds?.modify_entities);
  const sel = (x) => num(x.statement_kinds?.select);
  if (sel(b) > sel(a) && eml(a) > eml(b)) out.push({ from: "SELECT", to: "EML" });
  const edges = (x, kind) => asArray(x.cpg_edges).filter((e) => e.kind === kind).length;
  if (edges(b, "call-function") > edges(a, "call-function") && edges(a, "call-method") > edges(b, "call-method")) {
    out.push({ from: "CALL-FUNCTION", to: "CALL-METHOD" });
  }
  return out;
}

/** L0: a file OUTSIDE the declared touched set whose bytes changed. A file absent from the after
 *  side is NOT a break — a modernisation legitimately replaces a report with RAP artifacts under
 *  new names; only a co-present, unrequested rewrite breaks byte-exact reassembly. */
function reassemblyBroken(b, a, touched) {
  if (!Array.isArray(touched)) return false;
  const allowed = new Set(touched);
  for (const [name, hash] of Object.entries(b.file_hashes ?? {})) {
    if (allowed.has(name)) continue;
    const now = (a.file_hashes ?? {})[name];
    if (now !== undefined && now !== hash) return true;
  }
  return false;
}

/** Effective auth scope = AUTHORITY-CHECK statements ∪ DCL grants — the same union `invariantDiff`
 *  judges coverage on, so a classic→managed-RAP relocation never reads as a vanish (C2). */
const authScope = (x) => asArray(x.auth_checks).length + asArray(x.dcl_restrictions).length;

const authObjects = (x) =>
  new Set([...asArray(x.auth_checks).map((c) => c.object), ...asArray(x.dcl_restrictions).map((d) => d.object)]);

function setEqual(x, y) {
  if (x.size !== y.size) return false;
  for (const v of x) if (!y.has(v)) return false;
  return true;
}
