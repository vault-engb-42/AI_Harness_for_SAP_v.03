import { test } from "node:test";
import assert from "node:assert/strict";
import { compareReports, renderCompareHtml } from "../src/compare.js";

// `analyser compare <before> <after>`: the before/after delta report. Pure delta
// computation + a self-contained HTML renderer. The point of the tool is that it BAKES IN
// the coverage/scope-shift annotations so a reader can never misread a metric that changed
// its measurement population (e.g. cohesion going from 1 measured object to 10).

const doc = (o = {}) => ({
  package: o.package ?? "pkg",
  findings: o.findings ?? [],
  s4_readiness: { s4_readiness_pct: 0, cloud_readiness_pct: 0, s4_blocker_findings: 0, cloud_blocker_findings: 0, ...(o.s4 ?? {}) },
  code_health: {
    clean_core_grade: "D", clarity: 0, stability: 0, performance: 0, compound: 0,
    clarity_breakdown: { cyclomatic: 0, length: 0, nesting: 0, lcom: null },
    clarity_coverage: { cyclomatic: 0, length: 0, nesting: 0, lcom: 0, objects: 0 },
    ...(o.ch ?? {}),
  },
});

const BEFORE = doc({
  package: "abap_fico",
  findings: Array.from({ length: 879 }, (_, i) => ({ severity: i < 42 ? "priority-1" : "priority-2" })),
  s4: { s4_readiness_pct: 36, cloud_readiness_pct: 27, s4_blocker_findings: 28, cloud_blocker_findings: 63 },
  ch: { clean_core_grade: "D", clarity: 61, stability: 5, performance: 53, compound: 40,
    clarity_breakdown: { cyclomatic: 83, length: 62, nesting: 96, lcom: 100 },
    clarity_coverage: { cyclomatic: 11, length: 11, nesting: 11, lcom: 1, objects: 11 } },
});
const AFTER = doc({
  package: "modernised abap_fico",
  findings: Array.from({ length: 646 }, (_, i) => ({ severity: i < 11 ? "priority-1" : "priority-2" })),
  s4: { s4_readiness_pct: 100, cloud_readiness_pct: 82, s4_blocker_findings: 0, cloud_blocker_findings: 5 },
  ch: { clean_core_grade: "A", clarity: 53, stability: 17, performance: 56, compound: 42,
    clarity_breakdown: { cyclomatic: 100, length: 100, nesting: 100, lcom: 44 },
    clarity_coverage: { cyclomatic: 12, length: 12, nesting: 12, lcom: 10, objects: 12 } },
});

test("compareReports computes the readiness + quality deltas with direction", () => {
  const d = compareReports(BEFORE, AFTER);
  assert.deepEqual(d.labels, { before: "abap_fico", after: "modernised abap_fico" });
  const s4 = d.readiness.find((r) => r.label.includes("S/4"));
  assert.deepEqual([s4.before, s4.after, s4.delta], [36, 100, 64]);
  const p1 = d.quality.find((r) => r.label.includes("Priority-1"));
  assert.deepEqual([p1.before, p1.after, p1.improved], [42, 11, true], "fewer priority-1 is an improvement");
  const blk = d.quality.find((r) => r.label.includes("S/4 blocker"));
  assert.deepEqual([blk.before, blk.after], [28, 0]);
});

test("a clarity axis whose measured population shifted carries a SCOPE-SHIFT note (the cohesion trap)", () => {
  const d = compareReports(BEFORE, AFTER);
  const coh = d.clarity_axes.find((a) => a.label.includes("Cohesion"));
  assert.equal(coh.before.na, true, "before cohesion was measured from 1 object → not meaningful");
  assert.equal(coh.after.value, 44);
  assert.ok(d.notes.some((n) => /cohesion/i.test(n) && /1 .*10|population|measured/i.test(n)), "a scope-shift note explains the 1→10 population change");
});

test("renderCompareHtml is a self-contained document naming both sides", () => {
  const html = renderCompareHtml(compareReports(BEFORE, AFTER));
  assert.match(html, /^<!doctype html>/i);
  assert.ok(html.includes("abap_fico") && html.includes("modernised abap_fico"));
  assert.ok(html.includes("100") && html.includes("82") && html.includes("grade"), "headline numbers present");
  assert.ok(!/\ssrc\s*=\s*["']https?:/i.test(html), "no external resources");
});
