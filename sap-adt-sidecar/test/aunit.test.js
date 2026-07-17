import { test } from "node:test";
import assert from "node:assert/strict";
import { coveragePercent, aunitRunBody } from "../handlers/aunit.js";

// Coverage wiring: run_unit_tests must be able to COLLECT statement coverage so the
// abap-evaluator's Karpathy ratchet (abapunit-baseline.json coverage_floor_pct, only-up)
// has a real data source. The AUnit run request turns coverage on; a pure parser reads the
// coverage node. Both are pure functions asserted offline; the live wiring is validated on
// first DEV run. Coverage node shape grounded on abap-adt-api + SAP ABAP Coverage docs.

test("aunitRunBody requests statement coverage when with_coverage is true", () => {
  assert.match(aunitRunBody("/sap/bc/adt/oo/classes/zx/source/main", true), /<aunit:measurements type="statement"\/>/);
});

test("aunitRunBody requests no measurement by default (with_coverage false)", () => {
  assert.match(aunitRunBody("/sap/bc/adt/oo/classes/zx/source/main", false), /<aunit:measurements type="none"\/>/);
  assert.match(aunitRunBody("/sap/bc/adt/oo/classes/zx/source/main", false), /adtcore:uri="\/sap\/bc\/adt\/oo\/classes\/zx\/source\/main"/);
});

// The real ADT coverage response is HIERARCHICAL (cov:result > nodes > node > coverages >
// coverage): every parent <node> carries its OWN aggregate PLUS its child nodes. Summing every
// coverage node would double-count each statement once per ancestor level, so coveragePercent
// sums only LEAF nodes (a <node> with no child <node>). Fixtures use the real nested shape.
test("coveragePercent sums only leaf nodes on an UNBALANCED tree (no parent-aggregate double-count)", () => {
  // pkg 200/100 -> ZCL_A leaf 100/90 (depth 2) + ZCL_B 100/10 -> N1 50/5 + N2 50/5 (depth 3).
  // Leaves 100/90 + 50/5 + 50/5 = 200/100 = 50%. Flat-summing every node gives 210/500 = 42% (wrong).
  const xml = `<cov:result xmlns:cov="http://www.sap.com/adt/cov"><nodes>
    <node><coverages><coverage type="statement" total="200" executed="100"/></coverages><nodes>
      <node><coverages><coverage type="statement" total="100" executed="90"/></coverages></node>
      <node><coverages><coverage type="statement" total="100" executed="10"/></coverages><nodes>
        <node><coverages><coverage type="statement" total="50" executed="5"/></coverages></node>
        <node><coverages><coverage type="statement" total="50" executed="5"/></coverages></node>
      </nodes></node>
    </nodes></node>
  </nodes></cov:result>`;
  assert.equal(coveragePercent(xml), 50);
});

test("coveragePercent count-weights leaves (not average-of-averages) and ignores non-statement nodes", () => {
  // Leaves 100/50 (50%) + 10/10 (100%). Count-weighted = 60/110 = 55%; average-of-averages = 75%.
  const xml = `<cov:result><nodes>
    <node><coverages><coverage type="statement" total="110" executed="60"/><coverage type="branch" total="40" executed="10"/></coverages><nodes>
      <node><coverages><coverage type="statement" total="100" executed="50"/></coverages></node>
      <node><coverages><coverage type="statement" total="10" executed="10"/></coverages></node>
    </nodes></node>
  </nodes></cov:result>`;
  assert.equal(coveragePercent(xml), 55);
});

test("coveragePercent falls back to a flat coverage response (no node hierarchy)", () => {
  const xml = `<cov:result><coverages><coverage type="statement" total="120" executed="96"/><coverage type="branch" total="40" executed="28"/></coverages></cov:result>`;
  assert.equal(coveragePercent(xml), 80); // 96/120 statement only — never the branch node
});

test("coveragePercent returns null when no statement coverage was measured (not a 0% drop)", () => {
  assert.equal(coveragePercent(`<r><coverage type="branch" total="10" executed="5"/></r>`), null);
  assert.equal(coveragePercent(`<r></r>`), null);
  assert.equal(coveragePercent(`<node><coverages><coverage type="statement" total="0" executed="0"/></coverages></node>`), null);
});
