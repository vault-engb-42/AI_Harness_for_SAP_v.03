/**
 * The CPG PERSISTENCE detector — what an object OWNS, as distinct from what surface it presents.
 *
 * RC-1, from the root-cause analysis of the 2026-08-11 ARCH_REVIEW in which 13 of 15 recommendations were
 * failed by the independent reviewer. Every one of them wrote the same sentence differently: "no entity to
 * manage, so `bdef_managed` / `draft_enabled` / `commit_entities_only` have no referent". A managed RAP
 * Business Object IS, by definition, an object that owns a persistent root — and nothing in the fact stream
 * said whether one existed. The TALV corpus carries 14 `uses-table` edges and every one classified to
 * NOTHING, so a display utility and a business object arrived at the matcher indistinguishable and were
 * handed the identical nine-artifact contract.
 *
 * This is a SEPARATE DIMENSION and deliberately not another entry in the consumption bag. `consumption`
 * answers "what surface does this object present"; this answers "what state does it own". They are different
 * questions, they are silent independently, and a recommendation that reasons over a widening flat pile of
 * labels is the failure mode being corrected here — not a thing to add one more label to.
 *
 * The claim is WEAK positively and STRONG negatively, on purpose. A `uses-table` edge proves the object
 * TOUCHES a table, never that it owns the root entity: the CPG carries no access mode, so read-vs-write is
 * not available offline today (logged with the analyser-coverage gaps in MODERNISER_DESIGN.md). The ABSENCE
 * is conclusive, though — an object that touches no table at all owns no persistent root. Shapes therefore
 * use this as a NECESSARY condition (they refuse `no_persistence_evidence`) and never as a sufficient one.
 *
 * OWNERSHIP DOES NOT PROPAGATE, and that is the mirror image of the surface rule rather than an exception to
 * it. A surface IS transitive through delegation — an object that reaches a grid presents a grid, however
 * many wrappers away it is — because presenting is something the whole call chain does together. Owning is
 * not: the owner is the object that holds the table, and a caller of that object is a consumer of it.
 *
 * Measured, after the first version of this module propagated: EVERY false positive was a reached fact.
 * ZCL_TALV owns nothing itself and inherited `owns_customer_table` via ZCL_TALV_PARENT; ZCL_IDOC_INPUT_GM
 * via ZCL_IDOC_BASE; ZAESOP_TALV_DEMO_07 via ZCL_TALV_FACTORY. Those are precisely the objects the
 * independent reviewer failed for owning no persistence, so propagation would have re-admitted the managed
 * BO for exactly the rows this fix exists to stop.
 *
 * P8: the source is the resolved CPG symbol graph, and every emitted value is a member of the closed enum
 * below — no free-form string escapes this module, exactly as in `consumption-facts.js`.
 */
import { reachableFacts } from "./reach.js";

/** The closed, sorted persistence enum. `no_persistence_evidence` is a MEMBER, not an escape hatch. */
export const PERSISTENCE_FACTS = ["no_persistence_evidence", "owns_customer_table", "reads_sap_table"];

/** The absence marker, named once. */
export const NO_PERSISTENCE = "no_persistence_evidence";

/** Edge kinds that describe an object's relationship to stored data. */
const PERSISTENCE_EDGE_KINDS = new Set(["uses-table"]);

/**
 * A customer namespace table is the object's OWN data — the only kind a RAP root can be. An SAP table is
 * someone else's: reading MARA or EKPO is consumption of standard data, and a managed BO cannot own it.
 *
 * `Z*`/`Y*` is only PART of the customer namespace. SAP also issues REGISTERED namespaces of the form
 * `/VENDOR/OBJECT`, and a partner or large customer ships an entire product inside one — `/ACME/TORDER` is
 * that customer's own table exactly as `ZTORDER` is. Reading it as SAP's data would report that the object
 * owns nothing, which is the very silence this module exists to remove, in a corpus neither demo represents.
 */
const CUSTOMER_NAMESPACE = /^[ZY]|^\/[A-Z0-9_]+\//;

/**
 * @param {object} doc analyser-findings.json (read-only, P8)
 * @returns {Record<string, string[]>} object id → its sorted persistence facts (never empty)
 */
export function persistenceFacts(doc) {
  return reachableFacts(doc, {
    factsOfEdge: (edge) => (PERSISTENCE_EDGE_KINDS.has(String(edge?.kind ?? "").toLowerCase())
      ? [classifyTable(edge.target)].filter(Boolean)
      : []),
    absence: NO_PERSISTENCE,
    propagate: false, // you own what YOU touch — see the header
  });
}

/** A table this object touches: its OWN if customer-namespace, someone else's if SAP's. */
function classifyTable(target) {
  const bare = String(target ?? "").toUpperCase().split(".")[0];
  if (!bare) return null;
  return CUSTOMER_NAMESPACE.test(bare) ? "owns_customer_table" : "reads_sap_table";
}
