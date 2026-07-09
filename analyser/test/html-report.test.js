import { test } from "node:test";
import assert from "node:assert/strict";
import { renderHtml } from "../src/html-report.js";

// §3.E self-contained HTML report. Deterministic, no external resource loads, all
// finding-derived text HTML-escaped (P8: scanned ABAP is untrusted). The renderer
// is part of the analyser — never hand-generated per run.

const DOC = {
  package: "ZX",
  source_system: "bundle",
  generated_at: "2026-01-01T00:00:00.000Z",
  run_id: "abc123def456",
  findings: [
    { rule_id: "S4-001", severity: "priority-1", grade: "blocker", family: "released-api", object: "ZR", file: "zr.prog.abap", line: 3, message: "uses non-released T001" },
  ],
  s4_readiness: { s4_readiness_pct: 40, cloud_readiness_pct: 20, released_hits: 1, deprecated_hits: 1, not_released_hits: 0, total_api_calls: 2 },
  code_health: { clean_core_grade: "C", clarity: 77, stability: 60, performance: 90, compound: 74 },
  debt: { scores: [{ symbol: "ZR", score: 0.42, signals: { size_ratio: 0.5, complexity: 0.3 } }], avg_score: 0.42, max_score: 0.42, hotspot_count: 0 },
  cloud_readiness: { blockers: { findings: 1, distinct_rules: 1 }, warnings: { findings: 0, distinct_rules: 0 }, advisories: { findings: 0, distinct_rules: 0 }, needs_review: { findings: 0, distinct_rules: 0 } },
  layers: { entry: ["ZR"], internal: [], data: ["T001"] },
  boundaries: [{ name: "ZR", kind: "report", direction: "inbound" }],
  graph: { nodes: [{ id: "ZR", kind: "report", object: "ZR", namespace: "Z", rank: 1 }, { id: "T001", kind: "table", object: "T001", namespace: "sap", rank: 0.2 }], edges: [{ source: "ZR", target: "T001", kind: "uses-table" }] },
  modernization_plan: {
    objects: [
      { object: "ZR", kind: "report", modernization_target: "Fiori Elements App", effort_tier: "M", priority_rank: "P2", migration_complexity: 2, transformation_count: 1, transformations: [{ kind: "released-api", rule_id: "S4-001", why: "uses non-released T001", fix: "replace T001 with I_COMPANYCODE", released_successor: "I_COMPANYCODE" }] },
    ],
    summary: { total_objects: 1, by_effort: { S: 0, M: 1, L: 0, XL: 0 }, by_priority: { P1: 0, P2: 1, P3: 0 }, transport_order: ["ZR"] },
  },
  namespace_summary: { Z: 1, Y: 0, registered: 0, sap: 1, customer_total: 1, sap_total: 1 },
};

const TABS = ["Summary", "Recommendations", "Plan", "Code Health", "Tech Debt", "Cloud Readiness", "Graph", "Boundaries", "Layers", "Findings", "SARIF"];

test("renderHtml emits a self-contained document with all tabs", () => {
  const html = renderHtml(DOC);
  assert.match(html, /^<!doctype html>/i);
  for (const tab of TABS) assert.ok(html.includes(tab), `tab present: ${tab}`);
  assert.ok(html.includes("77") && html.includes("ZR"), "code_health + object data rendered");
});

test("renderHtml renders the modernization Plan tab (target + transport order)", () => {
  const html = renderHtml(DOC);
  assert.ok(html.includes("Modernization Plan"), "plan heading present");
  assert.ok(html.includes("Fiori Elements App"), "modernization target rendered");
});

test("renderHtml loads no external resources (self-contained file://)", () => {
  const html = renderHtml(DOC);
  assert.ok(!/\ssrc\s*=\s*["']https?:/i.test(html), "no external script/img src");
  assert.ok(!/<link\b/i.test(html), "no external stylesheet link");
});

test("renderHtml HTML-escapes untrusted finding-derived text (P8)", () => {
  const hostile = {
    ...DOC,
    findings: [{ rule_id: "x", severity: "info", object: "<img src=x onerror=alert(1)>", message: "<script>alert('xss')</script>" }],
  };
  const html = renderHtml(hostile);
  assert.ok(!html.includes("<script>alert('xss')</script>"), "raw script payload not present");
  assert.ok(!html.includes("<img src=x onerror"), "raw img payload not present");
  assert.ok(html.includes("&lt;script&gt;"), "payload is entity-escaped");
});

test("renderHtml is deterministic", () => {
  assert.equal(renderHtml(DOC), renderHtml(DOC));
});

test("renderHtml is total on a minimal document", () => {
  const html = renderHtml({ package: "P", generated_at: "t", findings: [], graph: { nodes: [], edges: [] }, s4_readiness: { s4_readiness_pct: 100, cloud_readiness_pct: 0 } });
  assert.match(html, /^<!doctype html>/i);
});
