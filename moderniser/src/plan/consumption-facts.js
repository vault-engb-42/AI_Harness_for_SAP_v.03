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

/** The closed, sorted consumption-fact enum. */
export const CONSUMPTION_FACTS = [
  "batch_report", "remote_bapi", "remote_idoc", "remote_rfc", "ui_dynpro", "ui_frontend", "ui_salv",
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
export function consumptionFacts(doc) {
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
    add(owner, classifyConstruct(e.target, e));
  }

  const out = {};
  for (const [owner, facts] of byObject) out[owner] = [...facts].sort();
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
const STRUCTURAL_EDGE_KINDS = new Set(["includes", "inherits", "implements", "contains"]);

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

/** Map a CPG construct target → a closed consumption fact, or null. An explicit CALL-FUNCTION DESTINATION is a remote RFC. */
function classifyConstruct(target, edge) {
  const T = String(target ?? "").toUpperCase();
  for (const [fact, re] of CONSTRUCT_PATTERNS) if (re.test(T)) return fact;
  if (edge && edge.destination) return "remote_rfc"; // a DESTINATION on any CALL FUNCTION is a remote call
  return null;
}
