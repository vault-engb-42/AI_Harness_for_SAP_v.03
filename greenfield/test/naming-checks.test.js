import { test } from "node:test";
import assert from "node:assert/strict";
import { cdsNamingFindings, bdefImplClassNamingFindings } from "../src/naming-checks.js";
import { lintAbapCloud } from "../src/cloud-linter.js";

// G8 — RAP object-naming convention lint: the interface/data-model CDS view is ZI_*, the
// consumption/projection view is ZC_*, and the behaviour implementation class (pool) is ZBP_*.
// All WARNING severity (style/consistency, not an activation or Clean-Core failure). Reuses the
// real CDS + BDEF parsers, real source, no mocks.

const ve = (name, body) => ({ filename: `${name.toLowerCase()}.ddls.asddls`, source: body });
const bdef = (name, body) => ({ filename: `${name.toLowerCase()}.bdef.asbdef`, source: body });
const finding = (res, id) => res.findings.find((f) => f.rule_id === id);

// --- CDS view-entity naming (ZI_ interface / ZC_ consumption) ---

test("G8 gf-x-naming-cds-interface: a non-projection (interface) view entity not prefixed ZI_ is a warning", () => {
  const files = [ve("Z_Travel", "define view entity Z_Travel as select from ztravel {\n  key travel_id as TravelId\n}")];
  const f = cdsNamingFindings(files).find((x) => x.rule_id === "gf-x-naming-cds-interface");
  assert.ok(f, "an interface data-model view should be named ZI_*");
  assert.equal(f.severity, "warning");
  assert.match(f.message, /ZI_/);
});

test("G8 gf-x-naming-cds-projection: a projection view entity not prefixed ZC_ is a warning", () => {
  const files = [ve("ZI_TravelP", "define view entity ZI_TravelP as projection on ZI_Travel {\n  key TravelId\n}")];
  const f = cdsNamingFindings(files).find((x) => x.rule_id === "gf-x-naming-cds-projection");
  assert.ok(f, "a consumption/projection view should be named ZC_*");
  assert.equal(f.severity, "warning");
  assert.match(f.message, /ZC_/);
});

test("G8: a conforming ZI_ interface + ZC_ projection pair is clean", () => {
  const files = [
    ve("ZI_Travel", "define view entity ZI_Travel as select from ztravel {\n  key travel_id as TravelId\n}"),
    ve("ZC_Travel", "define view entity ZC_Travel as projection on ZI_Travel {\n  key TravelId\n}"),
  ];
  assert.deepEqual(cdsNamingFindings(files), []);
});

test("G8: a name outside the customer namespace is not judged (namespace hygiene is a separate rule)", () => {
  const files = [ve("I_Travel", "define view entity I_Travel as select from ztravel {\n  key travel_id as TravelId\n}")];
  assert.deepEqual(cdsNamingFindings(files), []);
});

test("G8: a classic `define view` (no entity) is not a view-entity definition and is skipped", () => {
  const files = [ve("Z_Old", "define view Z_Old as select from ztravel { key travel_id as TravelId }")];
  assert.deepEqual(cdsNamingFindings(files), []);
});

// --- Behaviour-pool class naming (ZBP_) ---

test("G8 gf-x-naming-behavior-pool: an implementation class not prefixed ZBP_ is a warning", () => {
  const src = "managed implementation in class zcl_travel_bp unique;\ndefine behavior for ZI_Travel alias Travel\n{ create; update; }";
  const f = bdefImplClassNamingFindings([bdef("zi_travel", src)]).find((x) => x.rule_id === "gf-x-naming-behavior-pool");
  assert.ok(f, "a behaviour pool class should be named ZBP_*");
  assert.equal(f.severity, "warning");
  assert.match(f.message, /ZBP_/);
});

test("G8: a ZBP_ behaviour pool class is clean", () => {
  const src = "managed implementation in class zbp_i_travel unique;\ndefine behavior for ZI_Travel alias Travel\n{ create; }";
  assert.deepEqual(bdefImplClassNamingFindings([bdef("zi_travel", src)]), []);
});

test("G8: a projection BDEF with no implementation class is not judged", () => {
  const src = "projection;\ndefine behavior for ZC_Travel alias TravelProj\nuse draft\n{ use create; }";
  assert.deepEqual(bdefImplClassNamingFindings([bdef("zc_travel", src)]), []);
});

// --- wiring into lintAbapCloud ---

test("G8: both naming rules are wired into lintAbapCloud", () => {
  const view = ve("Z_Travel", "define view entity Z_Travel as select from ztravel {\n  key travel_id as TravelId\n}");
  assert.ok(finding(lintAbapCloud([view]), "gf-x-naming-cds-interface"), "cds naming wired");
  const b = bdef("zi_travel", "managed implementation in class zcl_travel_bp unique;\ndefine behavior for ZI_Travel alias Travel\n{ create; }");
  assert.ok(finding(lintAbapCloud([b]), "gf-x-naming-behavior-pool"), "bdef naming wired");
});
