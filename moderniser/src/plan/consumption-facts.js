/**
 * The CPG consumption detector (BUILD_PLAN S11/S14). A PURE pre-pass over the analyser doc's CPG
 * (`graph.nodes` + `graph.edges`) that emits, per object, a CLOSED enum of *consumption facts* — the
 * finer UI/remote surface the disposition classifier's coarse `disposition_hints` (ui_rearch / os_exec /
 * rfc_rebuild) don't distinguish, but which the target-shape reasoning (match.js, S14) needs
 * (dynpro vs SALV vs frontend; RFC vs BAPI vs IDoc). Sibling to `ground-candidates.js` (S3): recomputed
 * deterministically from the frozen, content-addressed doc, so its output is covered by the fact hash
 * (arch-facts.js) — never a plan-node schema change.
 *
 * P8: the source is the RESOLVED CPG symbol graph (AST-derived construct names + node kinds), never raw
 * source or finding-message prose. Every construct name is mapped to a value in the closed enum below;
 * an unrecognised construct emits NOTHING (no free-form string ever escapes this module).
 */

import { classifyName } from "../../../oracle/src/oracle.js";

/**
 * The closed, sorted consumption-fact enum. `no_surface_evidence` is a MEMBER, not an escape hatch: it is
 * the explicit statement that the detector found nothing, and it must satisfy the same P8 injection-closure
 * as every other fact because it reaches the judge's prompt exactly like they do.
 */
export const CONSUMPTION_FACTS = [
  "batch_report", "classic_api_surface", "no_surface_evidence", "remote_bapi", "remote_idoc",
  "remote_idoc_inbound", "remote_idoc_outbound", "remote_rfc", "ui_dynpro", "ui_frontend", "ui_salv",
];

/**
 * ALE DIRECTION, emitted ALONGSIDE `remote_idoc` (never instead of it, so every existing pattern keeps
 * matching unchanged). `remote_idoc` collapsed IDOC_INPUT_* and IDOC_OUTPUT_* into one token, and the
 * independent review found the consequence in the blueprint: a projection group the judge had labelled
 * PRJ_ALE_INBOUND_MESSAGE contained two outbound objects. Nothing in the fact stream could have told it
 * otherwise. The direction is the difference between an event the system CONSUMES and one it RAISES, and
 * it decides which objects belong to the same integration.
 *
 * Direction-NEUTRAL ALE helpers (EDI_* document processing, IDOC_ERROR_*) match neither: they are used on
 * both sides, and guessing a direction from them would be the same fabricated confidence in a new place.
 */
const IDOC_DIRECTIONS = [
  ["remote_idoc_inbound", /^IDOC_INPUT_|^IDOC_INBOUND/],
  ["remote_idoc_outbound", /^IDOC_OUTPUT_|^MASTER_IDOC_/],
];

// Construct-name → consumption fact, ordered by specificity (IDoc before BAPI before RFC so a
// MASTER_IDOC_* / *_IDOC_* name is never mis-read as a bare RFC). Applied to the UPPER-CASED target.
const CONSTRUCT_PATTERNS = [
  ["ui_salv", /(^|\.)CL_GUI_ALV_GRID\b|(^|\.)CL_SALV|(^|\b)REUSE_ALV|ALV_GRID_DISPLAY/],
  ["ui_frontend", /(^|\.)CL_GUI_FRONTEND(_SERVICES)?\b|(^|\b)GUI_(UPLOAD|DOWNLOAD)\b|(^|\b)WS_(UPLOAD|DOWNLOAD)\b/],
  ["ui_dynpro", /(^|\.)CL_GUI_DYNP|(^|\.)CL_GUI_CONTAINER\b|CALL_SCREEN/],
  // F-1: anchored at the START of the callee name, so it matches SAP's ALE API surface and not a customer
  // object that merely CONTAINS "IDOC". The old form was /(^|_)IDOC(_|$)/, which matched ZBC_FG_IDOC_FW,
  // ZCL_IDOC_BASE and LZBC_IDOC_CFGF00 — i.e. it fired on the corpus's own naming convention. In an IDoc
  // framework, where every object is named Z*_IDOC_*, the detector triggered on itself. Anchoring keeps all
  // ten real calls in the corpus (IDOC_INPUT_*, IDOC_INBOUND_*, IDOC_OUTPUT_*, IDOC_ERROR_*, EDI_*) and
  // drops VIEWPROC_ZBC_V_IDOC_OPT, which is SAP's generated SM30 view maintenance, not ALE.
  ["remote_idoc", /^(?:MASTER_)?IDOC_|^EDI_|^INBOUND_IDOC/],
  ["remote_bapi", /(^|\.)BAPI_/],
  ["remote_rfc", /(^|_)RFC(_|$)|^RFC_|_RFC$/],
];

// Node kinds that are themselves a consumption surface (independent of any outbound call).
const NODE_KIND_FACT = { report: "batch_report", program: "batch_report", executable: "batch_report", screen: "ui_dynpro", dynpro: "ui_dynpro" };

/**
 * @param {{graph?: {nodes?: Array<{id?: string, object?: string, kind?: string}>, edges?: Array<{source?: string, target?: string, kind?: string, destination?: string}>}}} doc analyser-findings.json (read-only, P8)
 * @returns {Record<string, string[]>} object id → its sorted, distinct consumption-fact subset
 */
/** The absence marker, named once. Must stay a member of CONSUMPTION_FACTS (P8 closure). */
export const NO_EVIDENCE = "no_surface_evidence";

/**
 * Every object's OWN facts — the surfaces it touches directly, with no propagation.
 * @returns {Map<string, Set<string>>}
 */
function directFacts(doc) {
  const byObject = new Map();
  const add = (owner, fact) => {
    if (!owner || !fact) return;
    if (!byObject.has(owner)) byObject.set(owner, new Set());
    byObject.get(owner).add(fact);
  };
  for (const n of doc?.graph?.nodes ?? []) {
    const fact = NODE_KIND_FACT[String(n.kind ?? "").toLowerCase()];
    if (fact) add(ownerOfNode(n), fact);
  }
  for (const e of doc?.graph?.edges ?? []) {
    const owner = ownerOf(e.source);
    if (!isConsumptionEdge(e, owner)) continue;
    for (const fact of classifyConstruct(e.target, e)) add(owner, fact);
  }
  return byObject;
}

/** owner → the distinct owners it CALLS (structural edges and self-calls excluded, as above). */
function calleeMap(doc) {
  const out = new Map();
  for (const e of doc?.graph?.edges ?? []) {
    const owner = ownerOf(e.source);
    if (!isConsumptionEdge(e, owner)) continue;
    const callee = ownerOf(e.target);
    if (!owner || !callee) continue;
    if (!out.has(owner)) out.set(owner, new Set());
    out.get(owner).add(callee);
  }
  return out;
}

/**
 * Surface facts with PROVENANCE: what each object touches itself, and what it reaches through the corpus's
 * own wrappers.
 *
 * A corpus that wraps its UI was previously invisible: TALV holds 493 ALV/SALV references and exactly three
 * objects touch an SAP GUI class directly — the other fourteen reach the grid through `ZCL_GUI_ALV_GRID` /
 * `ZCL_TALV_PARENT`, whose names no anchored SAP pattern can match. So `ui_*` measured "objects one hop from
 * SAP", a property of the detector rather than of the corpus, and because `rap_bo_headless` fires on the
 * ABSENCE of ui_* or remote_*, every blind spot became a confident shape.
 *
 * `direct` and `reached` stay separate because they are different claims that imply different dispositions:
 * the wrapper that IS the grid retires, while the callers that USE it re-architect to Fiori. `via` names the
 * immediate callee a reached fact came through, so the path is auditable rather than asserted.
 *
 * Memoised depth-first with an in-progress guard, so mutually recursive wrappers terminate and the walk is
 * O(V+E) amortised rather than a BFS per object — the 100K+ LOC NFR makes the quadratic form untenable.
 *
 * @param {object} doc analyser-findings.json (read-only, P8)
 * @returns {Record<string, {direct: string[], reached: Array<{fact: string, via: string}>}>}
 */
export function consumptionEvidence(doc) {
  const direct = directFacts(doc);
  const callees = calleeMap(doc);
  const memo = new Map();
  const walking = new Set();

  const factsOf = (owner) => {
    if (memo.has(owner)) return memo.get(owner);
    if (walking.has(owner)) return new Set(); // cycle: this object's own facts are added by its caller
    walking.add(owner);
    const all = new Set(direct.get(owner) ?? []);
    for (const callee of callees.get(owner) ?? []) for (const f of factsOf(callee)) all.add(f);
    walking.delete(owner);
    memo.set(owner, all);
    return all;
  };

  // Every object the CPG contains is an object the detector READ, and a read object owes an answer. Building
  // this set from the fact and callee maps alone left out precisely the objects with nothing to say: a
  // function group whose only edges are its own INCLUDEs entered neither map, so it had no entry, so
  // `consumptionFacts` never marked it `no_surface_evidence` — and `rap_bo_headless`'s `none` guard passed
  // vacuously on the empty list. That is the silent headless BO the marker was added to stop, one level
  // further down. TALV's ZFUNG_TALV and ZTALVTAB003 escaped through it. Presence in `graph.nodes` is the
  // evidence of a read; absence from the output now means only "not in the graph".
  const owners = new Set((doc?.graph?.nodes ?? []).map(ownerOfNode).filter(Boolean));
  for (const key of direct.keys()) owners.add(key);
  for (const key of callees.keys()) owners.add(key);
  for (const set of callees.values()) for (const c of set) owners.add(c);

  const out = {};
  for (const owner of [...owners].sort()) {
    const own = direct.get(owner) ?? new Set();
    const reached = [];
    for (const callee of [...(callees.get(owner) ?? [])].sort()) {
      for (const fact of [...factsOf(callee)].sort()) {
        if (own.has(fact) || reached.some((r) => r.fact === fact)) continue;
        reached.push({ fact, via: callee });
      }
    }
    out[owner] = { direct: [...own].sort(), reached };
  }
  return out;
}

/**
 * The flat per-object fact set the shape matcher keys on: direct and reached facts merged, because an
 * object that reaches a grid is not headless however many hops away the grid is.
 *
 * An object with NO surface evidence at all is marked `no_surface_evidence` rather than left empty. That
 * distinction is the point: `rap_bo_headless` matches on the ABSENCE of ui_* or remote_*, so an object the
 * detector merely could not read used to score identically to one proven to have no surface. On TALV that
 * silence produced 23 headless nodes for an interactive table-maintenance framework, 20 of them never
 * judged at all. Silence now says so out loud, and a shape rule can require evidence instead of quiet.
 */
export function consumptionFacts(doc) {
  const out = {};
  for (const [owner, ev] of Object.entries(consumptionEvidence(doc))) {
    const facts = [...new Set([...ev.direct, ...ev.reached.map((r) => r.fact)])].sort();
    out[owner] = facts.length > 0 ? facts : [NO_EVIDENCE];
  }
  return out;
}

/**
 * Edge kinds that describe an object's own STRUCTURE rather than anything it consumes. A function group's
 * INCLUDEs and a class's superclass are parts of the object, not an external surface it talks to.
 *
 * F-1: without this, `ZBC_FG_IDOC_FW --includes--> LZBC_FG_IDOC_FWTOP` and
 * `ZCL_IDOC_INPUT --inherits--> ZCL_IDOC_BASE` both registered as consumption. On the equalize-idoc corpus
 * that was 19 of the 107 spurious matches; the intra-object call below accounted for most of the rest.
 */
const STRUCTURAL_EDGE_KINDS = new Set(["includes", "contains"]);

/**
 * Does this edge describe something the object CONSUMES? Structural edges never do, and neither does a call
 * an object makes to itself — `ZCL_IDOC_DB_BUFFER.LOOKUP_KNA1 → ZCL_IDOC_DB_BUFFER.RETURN_FIELDVALUE_…` is
 * a private helper call, not a consumption surface, however the callee happens to be named.
 */
function isConsumptionEdge(edge, owner) {
  if (STRUCTURAL_EDGE_KINDS.has(String(edge?.kind ?? "").toLowerCase())) return false;
  return ownerOf(edge?.target) !== owner;
}

/** The owning object of a construct: the id segment before the first dot (`OWNER.form`/`OWNER.method` → OWNER). */
function ownerOf(id) {
  return String(id ?? "").split(".")[0];
}

/** A CPG node's owner: its explicit `object`, else the id's owner segment. */
function ownerOfNode(n) {
  return n.object || ownerOf(n.id);
}

/**
 * Map a CPG construct target → a closed consumption fact, or null. An explicit CALL-FUNCTION DESTINATION is
 * a remote RFC.
 *
 * The ORACLE NET runs last. Six hand-written patterns cannot keep up with SAP's classic surface —
 * CL_DD_DOCUMENT, CL_GUI_SPLITTER_CONTAINER, CL_DEMO_OUTPUT, CL_GUI_CFW and CL_GUI_TIMER all appear in the
 * TALV corpus and match none of them — and a list that lags is a detector that reports silence. The harness
 * already ships a SHA-pinned registry that answers "is this a classic SAP API with no Cloud successor?", so
 * an unrecognised callee is asked rather than dropped.
 *
 * It is deliberately a NET and not a replacement: the registry returns `classicAPI` for CL_GUI_ALV_GRID and
 * CL_GUI_FRONTEND_SERVICES alike, so it cannot tell a grid from a file dialog, and that distinction is what
 * selects rap_bo_fiori. The specific patterns therefore keep precedence, and the net contributes only the
 * coarser `classic_api_surface` for what falls through. Measured: 5 recoveries on TALV, 0 on equalize-idoc.
 */
function classifyConstruct(target, edge) {
  const T = String(target ?? "").toUpperCase();
  for (const [fact, re] of CONSTRUCT_PATTERNS) {
    if (!re.test(T)) continue;
    // An ALE call additionally states its DIRECTION where the API name carries one. Both facts are emitted:
    // the direction refines `remote_idoc`, it never replaces it.
    if (fact !== "remote_idoc") return [fact];
    const direction = IDOC_DIRECTIONS.find(([, re2]) => re2.test(T));
    return direction ? [fact, direction[0]] : [fact];
  }
  if (edge && edge.destination) return ["remote_rfc"]; // a DESTINATION on any CALL FUNCTION is a remote call
  const classic = classicApiSurface(T);
  return classic ? [classic] : [];
}

/**
 * The oracle net: an SAP-owned classic API that no pattern named. Customer code (Z- or Y-named) is absent from the
 * registry and returns nothing, so this never fires on the corpus's own objects.
 *
 * The registry lookup is deterministic and offline (engine-direct per docs/OFFLINE_PIPELINE.md), so this
 * module stays reproducible from the frozen doc — but it is no longer free of module state, and the fact
 * hash covers its output, so a registry bump is a fact-stream change by design.
 */
function classicApiSurface(upperTarget) {
  const bare = upperTarget.split(".")[0];
  if (!bare) return null;
  const verdict = classifyName(bare);
  return verdict && verdict.state === "classicAPI" ? "classic_api_surface" : null;
}
