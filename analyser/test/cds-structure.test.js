import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRegistry } from "../src/abaplint-loader.js";
import { cdsStructurePack, analyzeCds } from "../rules/cds-structure.js";

function packFindings(name, source) {
  const reg = loadRegistry([{ filename: `${name}.ddls.asddls`, source }]);
  return cdsStructurePack.check({ reg });
}
const ids = (f) => f.map((x) => x.rule_id);

// --- integration through the pack (real abaplint parse) ---

test("GROUP BY in an interface view is flagged (PERF-92)", () => {
  const f = packFindings("zi_agg", `@AccessControl.authorizationCheck: #CHECK
define view entity ZI_Agg as select from vbak {
  key kunnr as Customer,
  count(*) as OrderCount
} group by kunnr`);
  assert.ok(ids(f).includes("talos-cds-groupby-in-reuse"));
});

test("calculated field in WHERE is flagged (PERF-86)", () => {
  const f = packFindings("zi_calcwhere", `define view entity ZI_CalcWhere as select from vbak {
  key vbeln
} where concat(vbeln, '1') = 'X1'`);
  assert.ok(ids(f).includes("talos-cds-calc-field-in-where"));
});

test("calculated field in JOIN ON is flagged (PERF-87)", () => {
  const f = packFindings("zi_calcjoin", `define view entity ZI_CalcJoin as select from vbak
  inner join vbap on substring(vbap.vbeln, 1, 10) = vbak.vbeln {
  key vbak.vbeln
}`);
  assert.ok(ids(f).includes("talos-cds-calc-field-in-join"));
});

test("3+ CASE expressions in a CDS projection is flagged (PERF-67)", () => {
  const f = packFindings("zi_cases", `define view entity ZI_Cases as select from vbak {
  key vbeln,
  case status when 'A' then 'X' else 'Y' end as S1,
  case erdat  when '1' then 'X' else 'Y' end as S2,
  case ernam  when 'U' then 'X' else 'Y' end as S3
}`);
  assert.ok(ids(f).includes("talos-cds-business-logic"));
});

test("a key field declared after a non-key field is flagged (PERF-61)", () => {
  const f = packFindings("zi_order", `define view entity ZI_Order as select from vbak {
  vbeln,
  key kunnr
}`);
  assert.ok(ids(f).includes("talos-cds-field-order"));
});

test("a clean small view raises no structure findings", () => {
  const f = packFindings("zi_clean", `@AccessControl.authorizationCheck: #CHECK
define view entity ZI_Clean as select from vbak {
  key vbeln,
  kunnr
}`);
  assert.deepEqual(f, [], `unexpected: ${ids(f).join(",")}`);
});

// --- pure-function tests for count thresholds (synthetic parsed data) ---

const mkSources = (n) => Array.from({ length: n }, (_, i) => ({ name: `TAB${i}` }));

test("more than 100 distinct source tables is flagged (PERF-81)", () => {
  const f = analyzeCds("ZI_BIG", "define view entity ZI_Big as select from x { key f }", { sources: mkSources(101), associations: [] });
  assert.ok(f.some((x) => x.rule_id === "talos-cds-too-many-tables"));
});

test("serviceQuality #A with more than 3 tables is flagged (PERF-82)", () => {
  const raw = `@ObjectModel.usageType.serviceQuality: #A
define view entity ZI_Q as select from a { key f }`;
  const f = analyzeCds("ZI_Q", raw, { sources: mkSources(4), associations: [] });
  assert.ok(f.some((x) => x.rule_id === "talos-cds-service-quality-mismatch"));
});

test("serviceQuality #B tolerates 5 tables but flags 6 (PERF-83)", () => {
  const raw = `@ObjectModel.usageType.serviceQuality: #B
define view entity ZI_Q as select from a { key f }`;
  assert.ok(!analyzeCds("ZI_Q", raw, { sources: mkSources(5), associations: [] }).some((x) => x.rule_id === "talos-cds-service-quality-mismatch"));
  assert.ok(analyzeCds("ZI_Q", raw, { sources: mkSources(6), associations: [] }).some((x) => x.rule_id === "talos-cds-service-quality-mismatch"));
});

test("the same table appearing 3+ times in the join graph is flagged (PERF-90)", () => {
  const pd = { sources: [{ name: "VBAK" }, { name: "VBAK" }, { name: "VBAK" }], associations: [] };
  const f = analyzeCds("ZI_CYC", "define view entity ZI_Cyc as select from vbak { key f }", pd);
  assert.ok(f.some((x) => x.rule_id === "talos-cds-cyclic-join"));
});

test("a composite view selecting directly from a DDIC table is flagged (PERF-68)", () => {
  const raw = `@VDM.viewType: #COMPOSITE
define view entity ZC_Comp as select from vbak { key f }`;
  const f = analyzeCds("ZC_COMP", raw, { sources: [{ name: "VBAK" }], associations: [] });
  assert.ok(f.some((x) => x.rule_id === "talos-cds-composite-direct-ddic"));
});

test("a composite view selecting from a basic interface view is NOT flagged", () => {
  const raw = `@VDM.viewType: #COMPOSITE
define view entity ZC_Comp as select from ZI_Base { key f }`;
  const f = analyzeCds("ZC_COMP", raw, { sources: [{ name: "ZI_BASE" }], associations: [] });
  assert.ok(!f.some((x) => x.rule_id === "talos-cds-composite-direct-ddic"));
});
