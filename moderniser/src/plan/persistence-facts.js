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
 * OWNERSHIP IS WRITING (R3a). The first version of this module could not distinguish a reader from a writer,
 * because the analyser emitted `uses-table` for SELECT only — INSERT/UPDATE/MODIFY/DELETE produced no edge at
 * all, so every object read and none could ever be seen to write. `owns_customer_table` was therefore
 * inferred from READING your own table, and the independent review failed four recommendations on the
 * consequence: `bdef_managed` + `draft_enabled` on objects that never write. A managed RAP Business Object
 * exists to OWN AND MUTATE data; writing your own table is that claim, reading it is not.
 *
 * The analyser now stamps `access` on the edge, so the four facts are distinct evidence rather than one
 * inference. An edge with NO access is read — the conservative reading, so an older findings doc can never
 * manufacture ownership it never demonstrated.
 *
 * The ABSENCE remains conclusive: an object that touches no table at all owns no persistent root. Shapes use
 * that as a NECESSARY condition (they refuse `no_persistence_evidence`) and never as a sufficient one.
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
import { readFileSync } from "node:fs";
import { sapNamespaces } from "../../../oracle/src/oracle.js";
import { reachableFacts } from "./reach.js";

/** Landscape-supplied namespace→owner registry. See `namespaceOwners`. */
const OWNERS_PATH = new URL("./patterns/namespace-owners.json", import.meta.url);

/** The closed, sorted persistence enum. `no_persistence_evidence` is a MEMBER, not an escape hatch. */
export const PERSISTENCE_FACTS = [
  "no_persistence_evidence", "owns_customer_table", "reads_customer_table", "reads_sap_table",
  "writes_sap_table", "writes_via_sap_api",
];

/**
 * SAP's SANCTIONED write path. R3a taught this module to see direct DML — and in Clean-Core ABAP direct DML
 * on an SAP table is the ANTI-pattern, while the BAPI is how correct code writes. So the detector learned
 * the rare case and stayed blind to the normal one, and the independent review found the consequence by
 * reading source: ZCREATE_ASSET, a mass-CREATE utility calling BAPI_FIXEDASSET_CREATE1 in a loop, was handed
 * `fiori_list_report`, whose `readonly_query` invariant "would structurally FORBID the create the object
 * exists to perform". Measured across the corpora: SIX objects write only this way (four in equalize-idoc,
 * two in abap_fico), and every one of them was a failed review.
 *
 * The ACTION VERB separates a write from a read, so BAPI_*_GETLIST and BAPI_*_GETDETAIL are deliberately
 * absent. BAPI_TRANSACTION_COMMIT stands on its own: an object that commits an LUW is transactional whatever
 * API did the work. POSTING_INTERFACE_* is the FI batch-input posting surface and IDOC_INPUT_* the ALE
 * inbound handlers, both of which create business documents.
 *
 * This is evidence of WRITING, never of OWNERSHIP: the object mutates SAP's data through SAP's API and owns
 * no persistent root of its own — which is exactly what the reviewers said of all six.
 */
const WRITING_SAP_API = new RegExp(
  "^(BAPI_.*_(CREATE|CREATEFROM|CHANGE|POST|CANCEL|REVERSE|DELETE|CONFIRM|SETSTATUS|SAVE)"
  + "|BAPI_TRANSACTION_COMMIT"
  + "|POSTING_INTERFACE_"
  + "|IDOC_INPUT_"
  // F-2: ALE/EDI is the OTHER sanctioned write surface, and recognising only the BAPI family left six of
  // the ten integration APIs in the equalize-idoc corpus invisible — ZCL_IDOC_OUTPUT calls
  // EDI_DOCUMENT_STATUS_SET and IDOC_INBOUND_ASYNCHRONOUS and still read as `reads_sap_table`.
  + "|IDOC_OUTPUT_"      // builds and dispatches an outbound IDoc — a created document
  + "|IDOC_INBOUND_"     // posts an inbound IDoc (tRFC/queued ALE entry points)
  + "|MASTER_IDOC_"      // distributes master data as IDocs
  // The IDoc STATUS write triple. Scoped to these three verbs, not all of EDI_DOCUMENT_*, so the
  // readers in the same family (EDI_DOCUMENT_GET_DATA, EDI_SEGMENTS_GET_ALL) stay reads.
  + "|EDI_DOCUMENT_(STATUS_SET|OPEN_FOR_PROCESS|CLOSE_PROCESS)"
  + ")",
);

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
/** Unambiguous customer prefixes. The oracle has no entry for customer code by construction. */
const CUSTOMER_PREFIX = /^[ZY]/;
/** A registered `/NS/` namespace. Says nothing about WHO owns it — see `ownsName`. */
const REGISTERED_NAMESPACE = /^\/[A-Z0-9_]+\//;

/**
 * Is this name the CUSTOMER'S own data — the only kind a RAP root can own (F-9.2)?
 *
 * `Z`/`Y` is unambiguous. A registered `/NS/` namespace is NOT: SAP ships add-ons in registered namespaces
 * (`/SAPAPO/`, `/BEV1/`) exactly as partners and customers do, and the previous rule claimed all of them as
 * customer-owned — turning a write to an SAP add-on table into `owns_customer_table`, i.e. reporting a
 * Clean-Core VIOLATION as ownership. Inverted, which is the worst direction to be wrong in.
 *
 * The oracle is consulted because it is the authority on SAP-delivered objects, and a name it knows is
 * SAP's whatever its prefix. It does NOT currently settle the rest: probed 2026-08-13, `classifyName`
 * returns `unknown` for `/SAPAPO/MATKEY` and `/ACME/ZTAB` alike — the registry carries no
 * namespace-ownership data. So absence from it is not evidence of customer ownership.
 *
 * Unresolved `/NS/` therefore falls to NOT-OWNED. The two errors are not symmetric: claiming someone else's
 * table hides a violation silently, while declining to claim your own costs the object a BO root, which
 * shows up as an unmatched shape and escalates to a human. Manufacturing ownership from silence is the
 * worse error — the same rule `access ?? "read"` follows one function below.
 */
function ownsName(name) {
  if (CUSTOMER_PREFIX.test(name)) return true;
  const ns = name.match(REGISTERED_NAMESPACE)?.[0];
  if (!ns) return false; // a bare name is SAP's
  const owners = namespaceOwners();
  if (owners.customer.has(ns)) return true;
  if (owners.sap.has(ns)) return false;
  return owners.unresolvedDefault === "customer";
}

/**
 * The namespace→owner registry (`patterns/namespace-owners.json`), read once.
 *
 * Ownership of a registered namespace is a LANDSCAPE FACT, not a property of the name, so it is data the
 * operator supplies rather than a rule anyone can derive. The file ships EMPTY on purpose: seeding it with a
 * guessed list of SAP namespaces would invert a Clean-Core verdict exactly as the regex it replaces did,
 * just in a different set of cases. Unlisted falls to `unresolved_default`, which is "sap" — the fail-safe
 * direction, because claiming someone else's table hides a violation while declining your own escalates.
 */
let _owners = null;
function namespaceOwners() {
  if (_owners) return _owners;
  const raw = JSON.parse(readFileSync(OWNERS_PATH, "utf8"));
  const norm = (xs) => new Set((xs ?? []).map((s) => String(s).toUpperCase()));
  // SAP's own namespaces are DERIVED from the registry, not listed: an object SAP classified in its own
  // released-API data is SAP-delivered, so its namespace is SAP's. 44 of them at time of writing. The file's
  // `sap_delivered` only ADDS to that, for a landscape running an add-on the shipped registry does not cover.
  const sap = new Set([...sapNamespaces(), ...norm(raw.sap_delivered)]);
  _owners = {
    customer: norm(raw.customer_owned),
    sap,
    unresolvedDefault: raw.unresolved_default === "customer" ? "customer" : "sap",
  };
  return _owners;
}

/**
 * @param {object} doc analyser-findings.json (read-only, P8)
 * @returns {Record<string, string[]>} object id → its sorted persistence facts (never empty)
 */
export function persistenceFacts(doc) {
  return reachableFacts(doc, {
    factsOfEdge: (edge) => (PERSISTENCE_EDGE_KINDS.has(String(edge?.kind ?? "").toLowerCase())
      ? [classifyTable(edge.target, edge.access)].filter(Boolean)
      : [writeThroughApi(edge.target)].filter(Boolean)),
    absence: NO_PERSISTENCE,
    propagate: false, // you own what YOU touch — see the header
  });
}

/** Does this call mutate business data through SAP's own API? See WRITING_SAP_API. */
function writeThroughApi(target) {
  const bare = String(target ?? "").toUpperCase().split(".")[0];
  if (!bare || CUSTOMER_PREFIX.test(bare)) return null; // customer code is not SAP's sanctioned path
  return WRITING_SAP_API.test(bare) ? "writes_via_sap_api" : null;
}

/**
 * A table this object touches, by WHOSE data it is and WHAT it does to it. Only one cell of that matrix is
 * ownership of a persistent root: writing a customer table. Writing an SAP table is a distinct and louder
 * fact — it is mutating standard data, which Clean Core forbids outright — and is deliberately not folded
 * into ownership.
 */
function classifyTable(target, access) {
  const bare = String(target ?? "").toUpperCase().split(".")[0];
  if (!bare) return null;
  const writes = String(access ?? "read").toLowerCase() === "write";
  const mine = ownsName(bare);
  if (mine) return writes ? "owns_customer_table" : "reads_customer_table";
  return writes ? "writes_sap_table" : "reads_sap_table";
}
