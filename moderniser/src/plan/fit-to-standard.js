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
 * this closed map is the extensible seed. Pure. P8: reads the resolved CPG `uses-table` symbols only.
 */

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
    const domain = STANDARD_DOMAINS[table];
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
export function fitToStandardAdvisory(node, standardByObject = {}) {
  const byUpper = upperIndex(standardByObject);
  const members = node.members?.length ? node.members : [node.object];

  const domains = new Set();
  const tables = new Set();
  for (const m of members) {
    for (const t of byUpper[String(m).toUpperCase()] ?? []) {
      domains.add(t.domain);
      tables.add(t.table);
    }
  }

  if (tables.size === 0) {
    return { advisory: false, domains: [], tables: [], action: "build", note: "no standard-domain tables detected — bespoke build path (fail-closed; absence is not evidence of a standard)" };
  }
  const domainList = [...domains].sort();
  const tableList = [...tables].sort();
  return {
    advisory: true,
    domains: domainList,
    tables: tableList,
    action: "verify_live",
    note: `reads standard ${domainList.join(", ")} tables (${tableList.join(", ")}) — a released SAP standard MAY deliver this; verify via live /fit-to-standard before committing to a bespoke build`,
  };
}
