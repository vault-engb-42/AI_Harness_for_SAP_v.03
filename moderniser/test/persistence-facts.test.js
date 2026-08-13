import { test } from "node:test";
import assert from "node:assert/strict";
import { persistenceFacts, PERSISTENCE_FACTS, NO_PERSISTENCE } from "../src/plan/persistence-facts.js";

// RC-1 (root-cause analysis of the 2026-08-11 ARCH_REVIEW: 13 of 15 recommendations FAILED). Every reviewer
// wrote the same sentence differently — "no entity to manage, so bdef_managed / draft_enabled /
// commit_entities_only have no referent". A managed RAP Business Object IS an object that owns a persistent
// root, and NOTHING in the fact stream said whether one existed. TALV carries 14 `uses-table` edges and every
// one of them classified to nothing, so a display utility and a business object reached the matcher looking
// identical and were handed the identical nine-artifact contract.
//
// This is a SEPARATE DIMENSION, not another entry in the consumption bag. `consumption` answers "what surface
// does this object present"; persistence answers "what state does it own". Two different questions about the
// same object, and the operator's correction stands behind the split: a recommendation must come from
// structural analysis, not from a widening pile of labels.
//
// The claim is weak positively and strong negatively, deliberately. A `uses-table` edge proves the object
// TOUCHES a table, not that it owns the root entity — the CPG carries no access mode, so read-vs-write is not
// available (logged as an analyser gap). Its ABSENCE is conclusive: an object that touches no table at all
// owns no persistent root. The shapes therefore use it as a NECESSARY condition and never a sufficient one.

const graph = (edges, nodes = []) => ({ graph: { nodes, edges } });

test("a customer table is the object's own persistence; an SAP table is someone else's data", () => {
  const mine = persistenceFacts(graph([{ source: "ZCL_X", target: "ZTALV_LAYOUT_SET", kind: "uses-table", access: "write" }]));
  assert.deepEqual(mine.ZCL_X, ["owns_customer_table"], `writing a Z table is customer-owned persistence`);
  const theirs = persistenceFacts(graph([{ source: "ZCL_Y", target: "EKPO", kind: "uses-table" }]));
  assert.deepEqual(theirs.ZCL_Y, ["reads_sap_table"], "EKPO is SAP's data, not a root this object can own");
});

test("an object that touches no table at all says so — the absence is the conclusive half", () => {
  const out = persistenceFacts(graph([{ source: "ZCL_X", target: "CL_GUI_ALV_GRID", kind: "call-method" }]));
  assert.deepEqual(out.ZCL_X, [NO_PERSISTENCE], `a grid wrapper owns nothing: ${JSON.stringify(out)}`);
});

test("every object the CPG contains gets an answer, including one with no edges at all", () => {
  const out = persistenceFacts(graph([], [{ id: "ZTAB_X", kind: "table", object: "ZTAB_X" }]));
  assert.deepEqual(out.ZTAB_X, [NO_PERSISTENCE], "read, and found to touch nothing");
});

// OWNERSHIP DOES NOT PROPAGATE — the mirror of the surface rule, not an exception to it. A surface is
// transitive through delegation (an object that reaches a grid presents a grid); owning is not (the owner is
// the object holding the table, and its caller is a consumer of it).
//
// The first version of this module DID propagate, and measuring it against the reviewers' findings settled
// the question: every false positive was a reached fact. ZCL_TALV owns nothing itself and inherited the
// claim via ZCL_TALV_PARENT, ZCL_IDOC_INPUT_GM via ZCL_IDOC_BASE, ZAESOP_TALV_DEMO_07 via
// ZCL_TALV_FACTORY — exactly the objects the independent reviewer failed for owning no persistence. Had it
// propagated, the managed BO would have been re-admitted for the very rows this fix exists to stop.
test("ownership does NOT propagate — calling a DAO is consuming its table, not owning it", () => {
  const out = persistenceFacts(graph([
    { source: "ZCL_DAO", target: "ZTAB_ORDERS", kind: "uses-table", access: "write" },
    { source: "ZCL_SERVICE.RUN", target: "ZCL_DAO.READ", kind: "call-method" },
  ]));
  assert.deepEqual(out.ZCL_DAO, ["owns_customer_table"], "the object holding the table owns it");
  assert.deepEqual(out.ZCL_SERVICE, [NO_PERSISTENCE], `its caller owns nothing: ${JSON.stringify(out)}`);
});

test("an object touching both keeps both — owning your own table does not unsee SAP's", () => {
  const out = persistenceFacts(graph([
    { source: "ZCL_X", target: "ZTAB_MINE", kind: "uses-table", access: "write" },
    { source: "ZCL_X", target: "MARA", kind: "uses-table", access: "read" },
  ]));
  assert.deepEqual(out.ZCL_X, ["owns_customer_table", "reads_sap_table"]);
});

test("the enum is closed and sorted — it reaches the judge's prompt like every other fact (P8)", () => {
  assert.deepEqual(PERSISTENCE_FACTS, [
    "no_persistence_evidence", "owns_customer_table", "reads_customer_table", "reads_sap_table",
    "writes_sap_table", "writes_via_sap_api",
  ]);
  assert.deepEqual([...PERSISTENCE_FACTS].sort(), PERSISTENCE_FACTS);
});

test("a structural edge is not a persistence path — an INCLUDE is the object's own body", () => {
  const out = persistenceFacts(graph([
    { source: "ZCL_DAO", target: "ZTAB_ORDERS", kind: "uses-table" },
    { source: "ZFUGR_X", target: "ZCL_DAO", kind: "includes" },
  ], [{ id: "ZFUGR_X", kind: "function", object: "ZFUGR_X" }]));
  assert.deepEqual(out.ZFUGR_X, [NO_PERSISTENCE], "an INCLUDE does not inherit the included unit's tables");
});

// GENERALISATION (operator, 2026-08-11). `/^[ZY]/` is only PART of the customer namespace. SAP also issues
// REGISTERED namespaces of the form `/VENDOR/OBJECT`, and a partner or large customer ships its whole product
// in one — `/ACME/TORDER` is that customer's own table every bit as much as `ZTORDER` is. Reading it as SAP's
// data would tell the harness the object owns nothing, which is the exact silence RC-1 exists to remove, in a
// corpus neither demo represents.
// CONTRACT CHANGED 2026-08-13 (F-9.2). This asserted that a registered `/NS/` namespace is customer
// persistence. It is not decidable that way: SAP ships add-ons in registered namespaces (/SAPAPO/, /BEV1/)
// exactly as partners and customers do, so the old rule reported a WRITE TO AN SAP ADD-ON TABLE as
// `owns_customer_table` — a Clean-Core violation recorded as ownership, inverted.
//
// The oracle was consulted as the authority and cannot settle it either: probed 2026-08-13, `classifyName`
// returns `unknown` for `/SAPAPO/MATKEY` and `/ACME/ZTAB` alike. Absence from the registry is therefore not
// evidence of customer ownership.
//
// So unresolved `/NS/` falls to NOT-OWNED. The errors are asymmetric: claiming someone else's table hides a
// violation silently, whereas declining to claim your own costs the object a BO root — which surfaces as an
// unmatched shape and escalates to a human. Same rule as `access ?? "read"`: never manufacture ownership
// from silence.
test("F-9.2: a REGISTERED namespace is NOT proof of customer ownership — SAP ships there too", () => {
  const out = persistenceFacts(graph([{ source: "/ACME/CL_ORDER", target: "/ACME/TORDER", kind: "uses-table", access: "write" }]));
  assert.deepEqual(out["/ACME/CL_ORDER"], ["writes_sap_table"],
    "unproven ownership is not ownership; the write is still recorded, as someone else's data");
});

test("F-9.2: an unambiguous Z/Y prefix IS ownership — the change narrows the rule, it does not delete it", () => {
  for (const [obj, tab] of [["ZCL_A", "ZMYTAB"], ["YCL_B", "YMYTAB"]]) {
    const out = persistenceFacts(graph([{ source: obj, target: tab, kind: "uses-table", access: "write" }]));
    assert.deepEqual(out[obj], ["owns_customer_table"], `${tab} is unambiguously the customer's`);
  }
});

test("an SAP table is still SAP's, whatever else is in the corpus", () => {
  for (const t of ["MARA", "EKPO", "T001", "BSEG"]) {
    const out = persistenceFacts(graph([{ source: "ZCL_X", target: t, kind: "uses-table" }]));
    assert.deepEqual(out.ZCL_X, ["reads_sap_table"], t);
  }
});

// R3a. Until the analyser emitted an access mode, `uses-table` meant SELECT only — the CPG could not show a
// write, so `owns_customer_table` was inferred from READING your own table. The independent review failed
// four recommendations on the consequence: `bdef_managed` + `draft_enabled` on objects that never write
// ("the contract mandates transactional save and draft for a read-only display").
//
// A managed RAP Business Object exists to OWN AND MUTATE data. Writing your own table is that claim; reading
// it is not. The edge now carries `access`, so the distinction is evidence rather than inference — and an
// edge with no access (an older findings doc) is treated as a read, which is the conservative reading.
test("R3a writing your own table is ownership; merely reading it is not", () => {
  const writes = persistenceFacts(graph([{ source: "ZCL_BO", target: "ZTORDER", kind: "uses-table", access: "write" }]));
  assert.deepEqual(writes.ZCL_BO, ["owns_customer_table"], "a write to a customer table is ownership");

  const readsOnly = persistenceFacts(graph([{ source: "ZCL_RPT", target: "ZTORDER", kind: "uses-table", access: "read" }]));
  assert.deepEqual(readsOnly.ZCL_RPT, ["reads_customer_table"], `reading your own table is not owning it: ${JSON.stringify(readsOnly)}`);
});

test("R3a writing an SAP table is still not ownership — it is someone else's data", () => {
  const out = persistenceFacts(graph([{ source: "ZCL_X", target: "MARA", kind: "uses-table", access: "write" }]));
  assert.deepEqual(out.ZCL_X, ["writes_sap_table"], "mutating standard data is a distinct, and louder, fact");
});

test("R3a an edge with NO access mode is read — an older doc must not manufacture ownership", () => {
  const out = persistenceFacts(graph([{ source: "ZCL_X", target: "ZTORDER", kind: "uses-table" }]));
  assert.deepEqual(out.ZCL_X, ["reads_customer_table"], "absent evidence is the conservative reading");
});

// The blind spot R3a left, found by the independent review reading source (2026-08-12):
//
//   "It is a mass-CREATE utility, not a read-only report ... CALL FUNCTION 'BAPI_FIXEDASSET_CREATE1' inside
//    LOOP AT lt_anla ... fiori_list_report plus readonly_query would structurally FORBID the create the
//    object exists to perform."
//   "It CREATES FI documents - POSTING_INTERFACE_START/_DOCUMENT/_END with FTPOST/BLNTAB and tcode FB01."
//
// R3a taught the detector to see direct DML. But in Clean-Core ABAP direct DML on an SAP table is the
// ANTI-pattern — the sanctioned write path IS the BAPI. So the detector learned to see the rare case and
// stayed blind to the normal one. Measured across the corpora: 6 objects write through an SAP API with no
// direct DML at all (4 in equalize-idoc, 2 in abap_fico), and every one of them was a failed review.
//
// Recognised by SAP's own naming convention, exactly as R5 recognises delegation: the ACTION verb is what
// distinguishes a write from a read, so BAPI_*_GETLIST and BAPI_*_GETDETAIL are deliberately not writes.

test("a BAPI that creates or changes data is write evidence", () => {
  for (const fm of ["BAPI_FIXEDASSET_CREATE1", "BAPI_SALESORDER_CREATEFROMDAT2", "BAPI_OBJCL_CHANGE",
                    "BAPI_BATCH_CREATE", "BAPI_TRANSACTION_COMMIT"]) {
    const out = persistenceFacts(graph([{ source: "ZCL_X", target: fm, kind: "call-function" }]));
    assert.ok(out.ZCL_X.includes("writes_via_sap_api"), `${fm} writes: ${JSON.stringify(out.ZCL_X)}`);
  }
});

test("the SAP posting and ALE-inbound interfaces write too", () => {
  for (const fm of ["POSTING_INTERFACE_DOCUMENT", "POSTING_INTERFACE_START", "IDOC_INPUT_MBGMCR"]) {
    const out = persistenceFacts(graph([{ source: "ZCL_X", target: fm, kind: "call-function" }]));
    assert.ok(out.ZCL_X.includes("writes_via_sap_api"), `${fm} posts data: ${JSON.stringify(out.ZCL_X)}`);
  }
});

test("a READING BAPI is not write evidence — the verb is what distinguishes them", () => {
  for (const fm of ["BAPI_ADDRESSORG_GETDETAIL", "BAPI_MATERIAL_GETLIST", "BAPI_COMPANYCODE_GETDETAIL"]) {
    const out = persistenceFacts(graph([{ source: "ZCL_X", target: fm, kind: "call-function" }]));
    assert.deepEqual(out.ZCL_X, ["no_persistence_evidence"], `${fm} only reads`);
  }
});

test("a CUSTOMER function named like a BAPI is not an SAP write path", () => {
  const out = persistenceFacts(graph([{ source: "ZCL_X", target: "Z_BAPI_ORDER_CREATE", kind: "call-function" }]));
  assert.deepEqual(out.ZCL_X, ["no_persistence_evidence"], "customer code is not SAP's sanctioned API");
});

test("writing through an API is NOT ownership — the object still owns no entity", () => {
  const out = persistenceFacts(graph([{ source: "ZCREATE_ASSET", target: "BAPI_FIXEDASSET_CREATE1", kind: "call-function" }]));
  assert.ok(!out.ZCREATE_ASSET.includes("owns_customer_table"),
    "it mutates SAP's data through SAP's API; it owns no persistent root of its own");
});

// F-2 — R5 recognised the BAPI family and stopped there. ALE/EDI is the OTHER sanctioned write surface,
// and six of the ten integration APIs in the equalize-idoc corpus fell straight through it.

test("F-2: the ALE/EDI status API writes — it mutates the IDoc control record", () => {
  for (const fm of ["EDI_DOCUMENT_STATUS_SET", "EDI_DOCUMENT_OPEN_FOR_PROCESS", "EDI_DOCUMENT_CLOSE_PROCESS"]) {
    const out = persistenceFacts(graph([{ source: "ZCL_X", target: fm, kind: "call-function" }]));
    assert.ok(out.ZCL_X.includes("writes_via_sap_api"), `${fm} mutates IDoc status: ${JSON.stringify(out.ZCL_X)}`);
  }
});

test("F-2: creating an outbound IDoc, posting an inbound one, and distributing master data all write", () => {
  for (const fm of ["IDOC_OUTPUT_INVOIC", "IDOC_INBOUND_ASYNCHRONOUS", "IDOC_INBOUND_SINGLE", "MASTER_IDOC_DISTRIBUTE_DEBMAS"]) {
    const out = persistenceFacts(graph([{ source: "ZCL_X", target: fm, kind: "call-function" }]));
    assert.ok(out.ZCL_X.includes("writes_via_sap_api"), `${fm} creates or posts a document: ${JSON.stringify(out.ZCL_X)}`);
  }
});

test("F-2: reading an IDoc is still not writing it — the verb rule holds across the ALE family too", () => {
  for (const fm of ["EDI_SEGMENTS_GET_ALL", "EDI_DOCUMENT_GET_DATA", "IDOC_READ_COMPLETELY"]) {
    const out = persistenceFacts(graph([{ source: "ZCL_X", target: fm, kind: "call-function" }]));
    assert.deepEqual(out.ZCL_X, ["no_persistence_evidence"], `${fm} only reads`);
  }
});
