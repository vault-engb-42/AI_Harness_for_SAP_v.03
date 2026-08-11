import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fitToStandardAdvisory, standardTablesByObject, standardCapabilitiesByObject, STANDARD_DOMAINS } from "../src/plan/fit-to-standard.js";
import { planHash } from "../src/sched/plan.js";

// B3.5 seam 6 (BUILD_PLAN S13): the fit-to-standard fork, OFFLINE-ADVISORY only. Offline,
// `released_standard_exists` is finding-underivable, so this NEVER auto-selects replace/retire — it flags
// "a released SAP standard MAY deliver this; verify via live /fit-to-standard" when the object reads
// recognizable standard business tables, and fails closed (bespoke build) when it does not. An operator
// override to replace/retire re-opens gate 1 → replan → a NEW plan_hash (deterministic, not a resample).

test("STANDARD_DOMAINS maps common standard business tables to a domain (closed, extensible map)", () => {
  assert.equal(STANDARD_DOMAINS.EKKO, "Purchasing");
  assert.equal(STANDARD_DOMAINS.EKPO, "Purchasing");
  assert.equal(STANDARD_DOMAINS.VBAK, "Sales");
  assert.equal(STANDARD_DOMAINS.BKPF, "Accounting");
  assert.equal(STANDARD_DOMAINS.SKA1, "G/L Account");
});

test("standardTablesByObject: uses-table edges to standard tables → {owner: [{table, domain}]}; Z tables excluded", () => {
  const doc = { graph: { edges: [
    { source: "ZPO_REPORT", target: "EKKO", kind: "uses-table" },
    { source: "ZPO_REPORT.FORM1", target: "EKPO", kind: "uses-table" },
    { source: "ZPO_REPORT", target: "ZCUSTOM_TAB", kind: "uses-table" }, // Z table → not standard
    { source: "ZPO_REPORT", target: "POPUP_TO_INFORM", kind: "call-function" }, // not a table edge
  ] } };
  const out = standardTablesByObject(doc);
  const domains = out.ZPO_REPORT.map((t) => t.domain);
  assert.ok(out.ZPO_REPORT.some((t) => t.table === "EKKO" && t.domain === "Purchasing"));
  assert.ok(out.ZPO_REPORT.some((t) => t.table === "EKPO"));
  assert.ok(!out.ZPO_REPORT.some((t) => t.table === "ZCUSTOM_TAB"), "Z tables are not standard-domain");
  assert.ok(domains.every((d) => typeof d === "string"));
});

test("fitToStandardAdvisory: a node reading EKKO/EKPO → advisory (verify_live), NEVER an auto disposition", () => {
  const node = { object: "ZPO_REPORT", members: ["ZPO_REPORT"] };
  const std = { ZPO_REPORT: [{ table: "EKKO", domain: "Purchasing" }, { table: "EKPO", domain: "Purchasing" }] };
  const adv = fitToStandardAdvisory(node, std);
  assert.equal(adv.advisory, true);
  assert.deepEqual(adv.domains, ["Purchasing"]);
  assert.deepEqual(adv.tables, ["EKKO", "EKPO"]);
  assert.equal(adv.action, "verify_live");
  assert.match(adv.note, /verify.*live|\/fit-to-standard/i);
  // the advisory is metadata only — it must carry NO disposition and never say replace/retire
  assert.ok(!("disposition" in adv), "advisory carries no disposition");
  assert.ok(!/\breplace\b|\bretire\b/.test(JSON.stringify(adv.action)), "action is never replace/retire offline");
});

test("fitToStandardAdvisory: no standard-domain table → advisory false, fail-closed to the bespoke build path", () => {
  const adv = fitToStandardAdvisory({ object: "ZUTIL", members: ["ZUTIL"] }, { ZUTIL: [] });
  assert.equal(adv.advisory, false);
  assert.equal(adv.action, "build");
  assert.deepEqual(adv.domains, []);
});

test("fitToStandardAdvisory action is only ever 'verify_live' or 'build' (advisory can NEVER auto-adopt offline)", () => {
  const yes = fitToStandardAdvisory({ object: "Z", members: ["Z"] }, { Z: [{ table: "VBAK", domain: "Sales" }] });
  const no = fitToStandardAdvisory({ object: "Z", members: ["Z"] }, {});
  assert.ok(["verify_live", "build"].includes(yes.action));
  assert.ok(["verify_live", "build"].includes(no.action));
});

test("flow-back: an operator override to replace re-freezes under a DIFFERENT plan_hash (replan, not silent mutation)", () => {
  const base = [{ id: "sigA", wave: 0, disposition: "re_architect" }];
  const overridden = [{ id: "sigA", wave: 0, disposition: "replace" }];
  assert.notEqual(planHash(base), planHash(overridden), "a disposition override changes the frozen plan_hash → a REPLAN gate");
});

test("INTEGRATION abap_fico: the G/L program reads SKA1/SKB1 → a 'G/L Account' fit-to-standard advisory (verify live, disposition unchanged)", () => {
  const doc = JSON.parse(readFileSync("moderniser/test/fixtures/analyser-findings.json", "utf8"));
  const std = standardTablesByObject(doc);
  const adv = fitToStandardAdvisory({ object: "ZFICO_BTC_CSV_GL", members: ["ZFICO_BTC_CSV_GL"] }, std);
  assert.equal(adv.advisory, true);
  assert.ok(adv.domains.includes("G/L Account"));
  assert.equal(adv.action, "verify_live");
});

// M6 (Rule-11 review): same memoised case-fold index as arch-facts — per map instance, no bleed, stable.
test("M6 the memoised case-fold index is per-map and never bleeds between standard-table maps", () => {
  const n = { object: "ZFOO", members: ["ZFOO"] };
  assert.deepEqual(fitToStandardAdvisory(n, { zfoo: [{ table: "EKKO", domain: "Purchasing" }] }).domains, ["Purchasing"]);
  assert.deepEqual(fitToStandardAdvisory(n, { ZFOO: [{ table: "SKA1", domain: "G/L Account" }] }).domains, ["G/L Account"], "a DIFFERENT map is indexed independently");
  const shared = { ZfOo: [{ table: "MARA", domain: "Material" }] };
  assert.deepEqual(fitToStandardAdvisory(n, shared).tables, fitToStandardAdvisory(n, shared).tables, "repeat calls on one map are stable");
  assert.deepEqual(fitToStandardAdvisory(n, shared).tables, ["MARA"], "mixed-case key still resolves via the cached index");
});

// RC-3 (root-cause analysis of the 2026-08-11 ARCH_REVIEW). The advisory reasoned from a 26-entry hand list
// of standard tables, and the reviewers found both halves of what that misses:
//
//   "fit_to_standard claims 'no standard-domain tables detected', but the source types v_mblnr/v_mjahr off
//    MKPF — grounding returns MKPF/MSEG notToBeReleased, successors I_MaterialDocumentHeader_2 /
//    I_MaterialDocumentItem_2 — so 'build' was chosen on a fact the source contradicts."
//
//   "CL_BALI_LOG/IF_BALI_LOG released (Application Log is SAP standard, so fit_to_standard 'build' is wrong)."
//
// Both channels are now read from the ORACLE REGISTRY rather than a hand list, which is the difference
// between fixing these two corpora and generalising: the registry knows 34,000+ names, the list knew 26.
// Adding the five names the reviewers happened to hit would have been the overfit.

test("RC-3 a standard table the hand list never knew is still standard-domain evidence", () => {
  // MKPF/MSEG are absent from STANDARD_DOMAINS; the registry has them as notToBeReleased WITH a released
  // CDS successor, which is exactly what "SAP owns this data and already ships a view for it" means.
  const doc = { graph: { edges: [
    { source: "ZCL_GM", target: "MKPF", kind: "uses-table" },
    { source: "ZCL_GM", target: "MSEG", kind: "uses-table" },
  ] } };
  const std = standardTablesByObject(doc);
  const tables = (std.ZCL_GM ?? []).map((t) => t.table).sort();
  assert.deepEqual(tables, ["MKPF", "MSEG"], `the registry knows these: ${JSON.stringify(std)}`);
  const adv = fitToStandardAdvisory({ object: "ZCL_GM", members: ["ZCL_GM"] }, std);
  assert.equal(adv.advisory, true);
  assert.equal(adv.action, "verify_live", "not 'build' — the source contradicts that");
});

test("RC-3 the curated domain labels survive — a registry fallback does not lose them", () => {
  const std = standardTablesByObject({ graph: { edges: [{ source: "ZCL_PO", target: "EKPO", kind: "uses-table" }] } });
  assert.deepEqual(std.ZCL_PO, [{ table: "EKPO", domain: "Purchasing" }], "a curated label beats the generic one");
});

test("RC-3 a CUSTOMER table is not standard-domain evidence, however much data it holds", () => {
  const std = standardTablesByObject({ graph: { edges: [{ source: "ZCL_X", target: "ZTORDER", kind: "uses-table" }] } });
  assert.deepEqual(std.ZCL_X ?? [], [], "the customer's own table is not SAP's standard");
});

// The second channel: an object that already DELEGATES to a released SAP API is telling us the standard
// exists. ZAESOP_LOG_DEMO wraps the Application Log and the harness proposed building a bespoke one.
test("RC-3 calling a RELEASED SAP API is fit-to-standard evidence in its own right", () => {
  const doc = { graph: { edges: [{ source: "ZAESOP_LOG_DEMO", target: "CL_BALI_LOG.ADD_ITEM", kind: "call-method" }] } };
  const caps = standardCapabilitiesByObject(doc);
  assert.deepEqual(caps.ZAESOP_LOG_DEMO, ["CL_BALI_LOG"], `the Application Log is SAP standard: ${JSON.stringify(caps)}`);

  const adv = fitToStandardAdvisory({ object: "ZAESOP_LOG_DEMO", members: ["ZAESOP_LOG_DEMO"] }, {}, caps);
  assert.equal(adv.advisory, true, "an object wrapping a released standard must not read as a bespoke build");
  assert.equal(adv.action, "verify_live");
  assert.match(adv.note, /CL_BALI_LOG/, "and the human is told WHICH standard");
});

test("RC-3 a CLASSIC SAP API is not a standard to adopt — it is the thing being replaced", () => {
  const caps = standardCapabilitiesByObject({ graph: { edges: [{ source: "ZCL_X", target: "CL_SALV_TABLE.FACTORY", kind: "call-method" }] } });
  assert.deepEqual(caps.ZCL_X ?? [], [], "CL_SALV_TABLE is classicAPI, not a released standard to fit to");
});

test("RC-3 absence stays fail-closed — no evidence still means the bespoke build path", () => {
  const adv = fitToStandardAdvisory({ object: "ZCL_X", members: ["ZCL_X"] }, {}, {});
  assert.equal(adv.advisory, false);
  assert.equal(adv.action, "build");
});

// Measured on the two corpora the moment the capability channel went live: it surfaced CL_ABAP_TYPEDESCR,
// CL_ABAP_CHAR_UTILITIES, CL_ABAP_STRUCTDESCR, CX_ROOT and CX_STATIC_CHECK. All are genuinely `released`, and
// none is a capability anyone would "adopt instead of building" — they are the ABAP LANGUAGE RUNTIME and its
// exception hierarchy, which every object uses. An advisory that fires on RTTI trains the human to ignore it.
//
// SAP's own naming convention separates them: CL_ABAP_* is the language runtime, CX_* is an exception class.
// Neither is an application capability. That is a convention across all of SAP, not a fact about these two
// corpora, so excluding them generalises rather than overfits.
test("RC-3 the language runtime is not a business capability to fit to", () => {
  const noise = ["CL_ABAP_TYPEDESCR", "CL_ABAP_CHAR_UTILITIES", "CL_ABAP_STRUCTDESCR", "CL_ABAP_ELEMDESCR", "CX_ROOT", "CX_STATIC_CHECK"];
  for (const target of noise) {
    const caps = standardCapabilitiesByObject({ graph: { edges: [{ source: "ZCL_X", target: `${target}.RUN`, kind: "call-method" }] } });
    assert.deepEqual(caps.ZCL_X ?? [], [], `${target} is language infrastructure, not an SAP application capability`);
  }
});

test("RC-3 a real released BUSINESS capability still registers", () => {
  const caps = standardCapabilitiesByObject({ graph: { edges: [{ source: "ZCL_X", target: "CL_BALI_LOG.ADD_ITEM", kind: "call-method" }] } });
  assert.deepEqual(caps.ZCL_X, ["CL_BALI_LOG"], "the Application Log is exactly what fit-to-standard means");
});

// R5 (independent ARCH_REVIEW, 2026-08-11). Two flags across the corpora said the same thing: "the only
// bespoke content is status re-labelling around SAP's delivered inbound FM; replace/adopt-standard was never
// weighed", and for ZCREATE_ASSET "I_FixedAsset, I_CostCenter, I_CompanyCode all ground released, so the
// replace fork was never honestly evaluated".
//
// The registry cannot make that link: BAPI_FIXEDASSET_CREATE1, BAPI_SALESORDER_CREATEFROMDAT2,
// BAPI_BATCH_CREATE and BAPI_OBJCL_CHANGE all return null from it. But SAP's NAMING CONVENTION does — BAPI_*
// is the delivered business-API surface and IDOC_INPUT_*/IDOC_OUTPUT_* the delivered ALE handlers. An object
// whose substance is "call BAPI_FIXEDASSET_CREATE1 in a loop" is already delegating to a standard capability,
// and that is precisely the fit-to-standard question, whether or not the registry carries the name.
test("R5 a BAPI call is delegation to an SAP business capability", () => {
  const caps = standardCapabilitiesByObject({ graph: { edges: [
    { source: "ZCREATE_ASSET", target: "BAPI_FIXEDASSET_CREATE1", kind: "call-function" },
  ] } });
  assert.deepEqual(caps.ZCREATE_ASSET, ["BAPI_FIXEDASSET_CREATE1"], `the registry does not know it; the convention does: ${JSON.stringify(caps)}`);
});

test("R5 an SAP-delivered ALE handler is delegation too", () => {
  for (const fm of ["IDOC_INPUT_MBGMCR", "IDOC_INPUT_SALESORDER_CREATEFR", "IDOC_OUTPUT_INVOIC"]) {
    const caps = standardCapabilitiesByObject({ graph: { edges: [{ source: "ZCL_X", target: fm, kind: "call-function" }] } });
    assert.deepEqual(caps.ZCL_X, [fm], `${fm} is SAP's delivered inbound/outbound handler`);
  }
});

test("R5 the advisory names the capability so the human can weigh replace", () => {
  const caps = standardCapabilitiesByObject({ graph: { edges: [{ source: "ZCREATE_ASSET", target: "BAPI_FIXEDASSET_CREATE1", kind: "call-function" }] } });
  const adv = fitToStandardAdvisory({ object: "ZCREATE_ASSET", members: ["ZCREATE_ASSET"] }, {}, caps);
  assert.equal(adv.advisory, true);
  assert.equal(adv.action, "verify_live");
  assert.match(adv.note, /BAPI_FIXEDASSET_CREATE1/);
});

test("R5 a CUSTOMER function is not an SAP capability, whatever it is named", () => {
  const caps = standardCapabilitiesByObject({ graph: { edges: [
    { source: "ZCL_X", target: "Z_BAPI_LOOKALIKE", kind: "call-function" },
    { source: "ZCL_X", target: "ZFM_TALV_DISPLAY", kind: "call-function" },
  ] } });
  assert.deepEqual(caps.ZCL_X ?? [], [], "customer code is not a standard to fit to");
});
