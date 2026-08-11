/**
 * The fit-to-standard fork — OFFLINE-ADVISORY only (BUILD_PLAN S13). The prototype's highest-value move
 * (build-vs-adopt) is invisible to token-matching: an object that reads standard business tables (EKKO/EKPO
 * → a Purchase Order) may be delivered by a released S/4 app already, so a bespoke RAP build would be waste.
 *
 * BUT offline, `released_standard_exists` is finding-underivable (the registry maps name→state, not
 * semantics→released-CDS), so this fork **never auto-selects replace/retire**. It emits an ADVISORY when the
 * object reads recognizable standard-domain tables — "a released SAP standard MAY deliver this; verify via
 * live /fit-to-standard" — and fails closed to the bespoke build path otherwise (absence ≠ evidence). An
 * operator who acts on the advisory (override to replace/retire) re-opens gate 1 → replan → new plan_hash.
 *
 * The fuller offline domain→released-CDS index (to let `replace` fire offline) is out of scope v1 (§5.2);
 * this closed map is the extensible seed. Pure. P8: reads the resolved CPG symbols only.
 *
 * RC-3 (2026-08-11 ARCH_REVIEW). The hand map is 26 names, and the reviewers found both ways that is too few:
 *
 *   "fit_to_standard claims 'no standard-domain tables detected', but the source types v_mblnr/v_mjahr off
 *    MKPF — MKPF/MSEG are notToBeReleased with successors I_MaterialDocumentHeader_2 / _Item_2 — so 'build'
 *    was chosen on a fact the source contradicts."
 *   "CL_BALI_LOG/IF_BALI_LOG released (Application Log is SAP standard, so fit_to_standard 'build' is wrong)."
 *
 * Both channels now read the ORACLE REGISTRY, which knows 34,000+ names, rather than growing the list by the
 * five the reviewers happened to hit — that would have fixed two corpora, not the class:
 *
 *   DATA — a table the registry marks `notToBeReleased` WITH a released successor is SAP's data with a view
 *   already shipped for it. The curated labels win where they exist, because "Purchasing" reads better than
 *   a successor name; the registry supplies the rest.
 *
 *   CAPABILITY — an object that already DELEGATES to a RELEASED SAP API is telling us the standard exists.
 *   A `classicAPI` is deliberately NOT this: it is the thing being replaced, not a standard to adopt.
 */
import { classifyName } from "../../../oracle/src/oracle.js";

/** Standard SAP business tables → a human domain label (the extensible fit-to-standard seed, §5.2). */
export const STANDARD_DOMAINS = Object.freeze({
  EKKO: "Purchasing", EKPO: "Purchasing", EBAN: "Purchasing", EKBE: "Purchasing",
  VBAK: "Sales", VBAP: "Sales", LIKP: "Delivery", LIPS: "Delivery", VBRK: "Billing", VBRP: "Billing",
  BKPF: "Accounting", BSEG: "Accounting", BSID: "Accounting", BSIK: "Accounting", ACDOCA: "Accounting",
  SKA1: "G/L Account", SKB1: "G/L Account",
  MARA: "Material", MARC: "Material", MARD: "Material", MBEW: "Material",
  KNA1: "Customer", KNB1: "Customer", LFA1: "Vendor", LFB1: "Vendor",
});

/**
 * @param {{graph?: {edges?: Array<{source?: string, target?: string, kind?: string}>}}} doc analyser-findings.json
 * @returns {Record<string, Array<{table: string, domain: string}>>} object id → its standard-domain tables
 */
export function standardTablesByObject(doc) {
  const byObject = new Map();
  for (const e of doc?.graph?.edges ?? []) {
    if (e.kind !== "uses-table") continue;
    const table = String(e.target ?? "").toUpperCase();
    const domain = STANDARD_DOMAINS[table] ?? registryDomain(table);
    if (!domain) continue;
    const owner = String(e.source ?? "").split(".")[0];
    if (!byObject.has(owner)) byObject.set(owner, new Map());
    byObject.get(owner).set(table, domain); // dedupe by table
  }
  const out = {};
  for (const [owner, tables] of byObject) {
    out[owner] = [...tables.entries()].map(([table, domain]) => ({ table, domain })).sort((a, b) => (a.table < b.table ? -1 : 1));
  }
  return out;
}

// The case-folded view of the by-object map, cached per map INSTANCE. The advisory is called once per plan
// node with the SAME map, so rebuilding the index inside made the pass O(nodes × objects) — invisible on a
// toy fixture, quadratic at the 100K+ LOC scale this must hold (M6). Weakly keyed, so this stays a pure
// function of its input and never retains a map the caller has dropped. Assumes the map is NOT mutated after
// first use — it is a pure derivation of the frozen, content-hashed findings doc (standardTablesByObject).
const _upperIndexCache = new WeakMap();
function upperIndex(map) {
  if (map === null || typeof map !== "object") return {};
  const hit = _upperIndexCache.get(map);
  if (hit) return hit;
  const out = {};
  for (const k of Object.keys(map)) out[k.toUpperCase()] = map[k];
  _upperIndexCache.set(map, out);
  return out;
}

/**
 * The advisory for one node. NEVER returns a disposition — `action` is `"verify_live"` (an opportunity to
 * confirm live) or `"build"` (fail-closed bespoke). The gate surfaces a `verify_live` advisory at
 * ARCH_REVIEW; only an explicit operator override turns it into replace/retire (re-opening gate 1).
 * @param {{object?: string, members?: string[]}} node
 * @param {Record<string, Array<{table: string, domain: string}>>} standardByObject standardTablesByObject(doc)
 * @returns {{advisory: boolean, domains: string[], tables: string[], action: "verify_live"|"build", note: string}}
 */
export function fitToStandardAdvisory(node, standardByObject = {}, capabilityByObject = {}) {
  const byUpper = upperIndex(standardByObject);
  const capUpper = upperIndex(capabilityByObject);
  const members = node.members?.length ? node.members : [node.object];

  const domains = new Set();
  const tables = new Set();
  const capabilities = new Set();
  for (const m of members) {
    for (const t of byUpper[String(m).toUpperCase()] ?? []) {
      domains.add(t.domain);
      tables.add(t.table);
    }
    for (const c of capUpper[String(m).toUpperCase()] ?? []) capabilities.add(c);
  }

  if (tables.size === 0 && capabilities.size === 0) {
    return {
      advisory: false, domains: [], tables: [], released_apis: [], action: "build",
      note: "no standard-domain data and no released SAP API in use — bespoke build path (fail-closed; absence is not evidence of a standard)",
    };
  }
  const domainList = [...domains].sort();
  const tableList = [...tables].sort();
  const capList = [...capabilities].sort();
  // Two independent reasons the standard may already deliver this: the object reads SAP's DATA, or it already
  // calls SAP's CAPABILITY. The second is the stronger claim — an object wrapping CL_BALI_LOG is not a
  // candidate for a bespoke application log — so it is stated first when present.
  const why = [
    capList.length ? `already calls released SAP API(s) ${capList.join(", ")}` : null,
    tableList.length ? `reads standard ${domainList.join(", ")} data (${tableList.join(", ")})` : null,
  ].filter(Boolean).join("; ");
  return {
    advisory: true,
    domains: domainList,
    tables: tableList,
    released_apis: capList,
    action: "verify_live",
    note: `${why} — a released SAP standard MAY deliver this; verify via live /fit-to-standard before committing to a bespoke build`,
  };
}

/**
 * The registry's answer for a table the curated map never listed. `notToBeReleased` WITH a named successor is
 * the precise shape of "SAP owns this data and already ships a released view over it" — which is exactly the
 * fit-to-standard question. A customer table is absent from the registry and returns nothing, so this never
 * fires on the customer's own data.
 */
function registryDomain(table) {
  const verdict = classifyName(table);
  if (!verdict || verdict.state !== "notToBeReleased") return null;
  const successor = (verdict.successors ?? [])[0]?.name;
  return successor ? `SAP standard (successor ${successor})` : null;
}

/**
 * Objects that already DELEGATE to a released SAP API — the second fit-to-standard channel, and the one that
 * catches an object wrapping a capability SAP ships. ZAESOP_LOG_DEMO wraps CL_BALI_LOG (the Application Log)
 * and the harness proposed building a bespoke log for it.
 *
 * Only `released` counts. A `classicAPI` (CL_SALV_TABLE, CL_GUI_ALV_GRID) is what is being modernised AWAY
 * from, not a standard to adopt, and reading it as fit-to-standard evidence would tell the human to keep it.
 *
 * The LANGUAGE RUNTIME is excluded for the same reason in the other direction. Measured when this channel
 * first ran: it surfaced CL_ABAP_TYPEDESCR, CL_ABAP_CHAR_UTILITIES, CL_ABAP_STRUCTDESCR, CX_ROOT and
 * CX_STATIC_CHECK — all genuinely released, none a capability anyone would adopt instead of building. SAP's
 * own naming convention separates them (CL_ABAP_* is the runtime, CX_* an exception class), so this is a
 * convention across all of SAP rather than a fact about two corpora. An advisory that fires on RTTI trains
 * the human to ignore the advisory.
 *
 * @returns {Record<string, string[]>} object id → the released SAP APIs it calls, sorted
 */
/** The ABAP language runtime and its exception hierarchy — SAP-released, never an adoptable capability. */
const LANGUAGE_RUNTIME = /^CL_ABAP_|^CX_/;

export function standardCapabilitiesByObject(doc) {
  const byObject = new Map();
  for (const e of doc?.graph?.edges ?? []) {
    if (e.kind === "uses-table") continue;
    const owner = String(e.source ?? "").split(".")[0];
    const callee = String(e.target ?? "").toUpperCase().split(".")[0];
    if (!owner || !callee || callee === owner.toUpperCase()) continue;
    if (LANGUAGE_RUNTIME.test(callee)) continue;
    if (classifyName(callee)?.state !== "released") continue;
    if (!byObject.has(owner)) byObject.set(owner, new Set());
    byObject.get(owner).add(callee);
  }
  return Object.fromEntries([...byObject].map(([k, v]) => [k, [...v].sort()]));
}
