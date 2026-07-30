import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fitToStandardAdvisory, standardTablesByObject, STANDARD_DOMAINS } from "../src/plan/fit-to-standard.js";
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
