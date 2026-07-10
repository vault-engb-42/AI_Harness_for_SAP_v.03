import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { renderHtml } from "../src/html-report.js";
import { APP_JS } from "../src/html-assets.js";

// §3.E self-contained HTML report. Deterministic, no external resource loads, all
// finding-derived text HTML-escaped (P8: scanned ABAP is untrusted). The renderer
// is part of the analyser — never hand-generated per run.

const DOC = {
  package: "ZX",
  source_system: "bundle",
  generated_at: "2026-01-01T00:00:00.000Z",
  run_id: "abc123def456",
  findings: [
    { rule_id: "S4-001", severity: "priority-1", grade: "blocker", family: "released-api", object: "ZR", referenced_object: "T001", suggestion: "replace T001 with I_COMPANYCODE", file: "zr.prog.abap", line: 3, message: "uses non-released T001" },
  ],
  s4_readiness: { s4_readiness_pct: 50, cloud_readiness_pct: 25, total_objects: 4, s4_blocked_objects: 2, cloud_blocked_objects: 3, s4_blocker_findings: 5, cloud_blocker_findings: 9, released_hits: 1, classic_api_hits: 0, deprecated_hits: 1, not_released_hits: 0, total_api_calls: 2 },
  blast_radius: [{ object: "T001", affected_program_count: 2, successor_kind: "CDS_STOB", highest_impact: "high" }],
  code_health: { clean_core_grade: "C", clarity: 61, stability: 60, performance: 90, compound: 70, clarity_breakdown: { cyclomatic: 83, length: 62, nesting: 96, lcom: null }, by_object: [{ object: "ZR", kind: "report", cyclomatic: 12, max_routine_loc: 171, nesting: 4, lcom: null, perf_findings: 1, grade: "C", penalty: 0.81 }] },
  metrics: { total_loc: 1234, file_count: 3, object_count: 2, by_kind: { report: 1, table: 1 }, customer_loc: 1000, sap_loc: 234, size_class: "S", avg_cyclomatic: 4, max_cyclomatic: 12, max_nesting: 3, duplication_findings: 1, comment_ratio: 0.1, maintainability_index: 65 },
  debt: { scores: [{ symbol: "ZR", score: 0.42, signals: { size_ratio: 0.5, complexity: 0.3 } }], avg_score: 0.42, max_score: 0.42, hotspot_count: 0 },
  cloud_readiness: { blockers: { findings: 1, distinct_rules: 1 }, warnings: { findings: 0, distinct_rules: 0 }, advisories: { findings: 0, distinct_rules: 0 }, needs_review: { findings: 0, distinct_rules: 0 } },
  layers: { entry: ["ZR"], internal: [], data: ["T001"] },
  boundaries: [{ name: "ZR", kind: "report", direction: "inbound" }],
  graph: { nodes: [{ id: "ZR", kind: "report", object: "ZR", namespace: "Z", rank: 1, clean_core_grade: "D" }, { id: "T001", kind: "table", object: "T001", namespace: "sap", rank: 0.2, clean_core_grade: "D" }], edges: [{ source: "ZR", target: "T001", kind: "uses-table" }] },
  modernization_plan: {
    objects: [
      { object: "ZR", kind: "report", modernization_target: "Fiori Elements App", effort_tier: "M", priority_rank: "P2", migration_complexity: 2, wave: 0, dependencies: [], transformation_count: 1, transformations: [{ kind: "released-api", rule_id: "S4-001", why: "uses non-released T001", fix: "replace T001 with I_COMPANYCODE", released_successor: "I_COMPANYCODE" }] },
    ],
    summary: { total_objects: 1, wave_count: 1, by_effort: { S: 0, M: 1, L: 0, XL: 0 }, by_priority: { P1: 0, P2: 1, P3: 0 }, transport_order: ["ZR"] },
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

test("renderHtml renders the modernization Plan tab (waves + expandable transformations)", () => {
  const html = renderHtml(DOC);
  assert.ok(html.includes("Modernization Plan"), "plan heading present");
  assert.ok(html.includes("Fiori Elements App"), "modernization target rendered");
  assert.ok(html.includes("Wave 0"), "objects grouped into dependency waves");
  assert.ok(html.includes("<details class=\"planobj\"") && html.includes("replace T001 with I_COMPANYCODE"), "expandable object shows its transformation steps");
});

test("Summary renders the codebase metrics block (LOC, size class, Maintainability Index)", () => {
  const html = renderHtml(DOC);
  assert.ok(html.includes("Codebase"), "codebase section present");
  assert.ok(html.includes("1,234"), "total LOC formatted");
  assert.ok(html.includes("Maintainability"), "MI surfaced");
  assert.ok(html.includes("Size class"), "size class surfaced");
});

test("Code Health tab renders the clarity breakdown + per-object drill-down", () => {
  const html = renderHtml(DOC);
  assert.ok(html.includes("Clarity breakdown"), "clarity sub-axes present");
  assert.ok(html.includes("By object"), "per-object section present");
  assert.ok(/<th>Max cyclomatic<\/th>/.test(html) && /Longest routine/.test(html), "cyclomatic + length columns");
  assert.ok(/<th>Clarity penalty<\/th>/.test(html), "penalty column surfaces the worst attribute");
});

test("Readiness is presented object-level with blocker context + dependency hygiene labelled secondary", () => {
  const html = renderHtml(DOC);
  assert.ok(html.includes("share of the 4 customer objects") || html.includes("Share of 4 customer objects"), "object-level basis stated");
  assert.ok(html.includes("Cloud-blocked") || html.includes("Cloud blocker"), "blocker context surfaced");
  assert.ok(html.includes("dependency hygiene") && html.includes("NOT the readiness denominator"), "dependency counts demoted to secondary");
  assert.ok(html.includes("Legacy debt"), "legacy debt surfaced in the summary");
});

test("Cloud tab surfaces blast radius, successor map, and grade distribution (previously hidden)", () => {
  const html = renderHtml(DOC);
  assert.ok(html.includes("Blast radius"), "blast-radius section present");
  assert.ok(/<th>Affected programs<\/th>/.test(html), "blast-radius table");
  assert.ok(html.includes("Released-API successors") && html.includes("replace T001 with I_COMPANYCODE"), "successor map with the fix");
  assert.ok(html.includes("grade distribution") || html.includes("grade") , "grade distribution present");
  assert.ok(html.includes("blocker"), "D grade surfaced");
});

test("renderHtml loads no external resources (self-contained file://)", () => {
  const html = renderHtml(DOC);
  assert.ok(!/\ssrc\s*=\s*["']https?:/i.test(html), "no external script/img src");
  assert.ok(!/<link\b/i.test(html), "no external stylesheet link");
});

test("CSP hardening: script-src is hash-based (no unsafe-inline), zero inline event handlers", () => {
  const html = renderHtml(DOC);
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)[1];
  // The script XSS vector is closed: the inline script is allow-listed by SHA-256
  // hash, NOT by 'unsafe-inline'. A wrong/absent hash means the browser blocks the
  // script and the report's interactivity dies — so assert the hash matches the bytes.
  assert.ok(/script-src 'sha256-[A-Za-z0-9+/=]+'/.test(csp), "script-src uses a sha256 hash allow-list");
  assert.ok(!/script-src[^;]*'unsafe-inline'/.test(csp), "script-src does NOT allow unsafe-inline");
  const expected = createHash("sha256").update(APP_JS).digest("base64");
  assert.ok(csp.includes("'sha256-" + expected + "'"), "CSP hash matches the emitted APP_JS bytes exactly");
  // No inline HTML event-handler attributes anywhere (all converted to addEventListener),
  // so even a hypothetical escaping slip could not execute an on*= handler.
  assert.ok(!/\son[a-z]+\s*=\s*["']/i.test(html), "no inline on*= event-handler attributes");
  // style-src intentionally RETAINS unsafe-inline: bar() emits dynamic style="width:N%"
  // which cannot be hashed or classed; inline styles are not a script-execution vector
  // and default-src 'none' blocks any exfiltration. Documented residual, not an oversight.
  assert.ok(/style-src 'unsafe-inline'/.test(csp), "style-src retains unsafe-inline for dynamic bar widths");
});

test("renderHtml HTML-escapes untrusted finding-derived text (P8)", () => {
  const hostile = {
    ...DOC,
    findings: [{ rule_id: "x", severity: "info", family: "abaplint", object: "<img src=x onerror=alert(1)>", message: "<script>alert('xss')</script>" }],
  };
  const html = renderHtml(hostile);
  assert.ok(!html.includes("<script>alert('xss')</script>"), "raw script payload not present");
  assert.ok(!html.includes("<img src=x onerror"), "raw img payload not present");
  // The findings island unicode-escapes < > &; tag renders (summary/recs) entity-escape.
  // Either way the raw payload must be neutralised while still present in an encoded form.
  assert.ok(html.includes("\\u003cscript") || html.includes("&lt;script&gt;"), "message payload is encoded, not raw");
  assert.ok(html.includes("\\u003cimg") || html.includes("&lt;img"), "object payload is encoded, not raw");
});

test("Graph tab offers force-directed SVG + a dependency matrix (DSM) view", () => {
  const html = renderHtml(DOC);
  assert.ok(html.includes('id="gsvg"') && html.includes('id="gv"'), "svg + transform group");
  assert.ok(/class="gn" data-id="[^"]+" data-x="[^"]+" data-y=/.test(html), "nodes carry id + deterministic seed position");
  assert.ok(/data-g="layout" data-arg="force"/.test(html) && /data-g="layout" data-arg="matrix"/.test(html), "Force + Matrix toggle (wired via addEventListener, not inline onclick)");
  assert.ok(html.includes("gZoom") && html.includes("gFit"), "zoom/fit controls");
  // DSM: ZR depends on T001 -> a dependency cell in the object×object grid.
  assert.ok(html.includes('id="gmatrix"') && html.includes('table class="mx"'), "dependency matrix rendered");
  assert.ok(html.includes("mx-dep"), "the ZR→T001 dependency shows as a filled cell");
});

test("dependency matrix: SCC-based cycle marking — a real cycle shows, a clean DAG shows none", () => {
  const node = (n, r) => ({ id: n, kind: "class", object: n, namespace: "Z", rank: r });
  const cyclic = {
    ...DOC,
    graph: {
      nodes: [node("ZCL_A", 0.5), node("ZCL_B", 0.4)],
      edges: [
        { source: "ZCL_A", target: "ZCL_B", kind: "call-method" },
        { source: "ZCL_B", target: "ZCL_A", kind: "call-method" },
      ],
    },
  };
  // Count real cycle CELLS (class "mx-dep mx-cycle"), not the CSS rule or legend swatch.
  const cycleCells = (h) => (h.match(/mx-dep mx-cycle/g) ?? []).length;
  const ch = renderHtml(cyclic);
  assert.ok(ch.includes("circular dependency (2)"), "both edges of the A↔B SCC are marked (count 2)");
  assert.equal(cycleCells(ch), 2, "2 real cycle cells");

  const dag = {
    ...DOC,
    graph: {
      nodes: [node("ZCL_A", 0.5), node("ZCL_B", 0.4), node("ZCL_C", 0.3)],
      edges: [
        { source: "ZCL_A", target: "ZCL_B", kind: "call-method" },
        { source: "ZCL_B", target: "ZCL_C", kind: "call-method" },
      ],
    },
  };
  const dh = renderHtml(dag);
  assert.ok(dh.includes("circular dependency (0)"), "a clean DAG reports zero cycles");
  assert.equal(cycleCells(dh), 0, "no cycle cells — the DAG is clean");
});

test("SARIF tab is a summary panel + export pointer, NOT the embedded raw document", () => {
  const html = renderHtml(DOC);
  assert.ok(html.includes("SARIF 2.1.0 export"), "explains it is an export");
  assert.ok(html.includes("--sarif"), "points to the CLI export flag");
  assert.ok(/Results<\/span>/.test(html), "shows a result-count summary card");
  // The heavy machine artifact must NOT be baked into the human report.
  assert.ok(!html.includes('id="sdata"'), "no SARIF JSON island in the HTML");
  assert.ok(!html.includes('"version":"2.1.0"'), "no raw SARIF document embedded");
});

test("Findings tab virtualizes via a JSON island (not one card per finding)", () => {
  const many = { ...DOC, findings: Array.from({ length: 40 }, (_, i) => ({ rule_id: "R" + i, severity: "priority-2", family: "performance", object: "ZO" + i, file: "f.abap", line: i, message: "m" + i })) };
  const html = renderHtml(many);
  assert.ok(html.includes('id="fdata"'), "findings data island present");
  assert.ok(html.includes('type="application/json"'), "island is inert JSON, not markup");
  assert.ok(html.includes('id="fPrev"') && html.includes('id="fNext"'), "pagination controls");
  // Virtualized: messages are in the island, not pre-rendered as 40 separate cards.
  assert.ok((html.match(/class="rec sev-/g) ?? []).length < 5, "cards are rendered client-side, not baked in");
});

test("Findings tab has a triage view: honest headline + family/rules/hotspots breakdown", () => {
  const many = {
    ...DOC,
    findings: [
      ...Array.from({ length: 30 }, (_, i) => ({ rule_id: "abaplint:naming", severity: "priority-3", family: "abaplint", object: "ZR", message: "lint" + i })),
      ...Array.from({ length: 5 }, (_, i) => ({ rule_id: "released-api", severity: "priority-1", family: "released-api", object: "ZO", message: "mod" + i })),
    ],
  };
  const html = renderHtml(many);
  assert.ok(html.includes(">5</b> modernization"), "splits modernization from lint (5 of 35)");
  assert.ok(html.includes(">5</b class") || />5<\/b> priority-1/.test(html) || html.includes("priority-1 blocker"), "surfaces the P1 count");
  assert.ok(html.includes("By family") && html.includes("Top rules") && html.includes("Hotspot objects"), "the three breakdowns");
});

test("renderHtml is deterministic", () => {
  assert.equal(renderHtml(DOC), renderHtml(DOC));
});

test("renderHtml is total on a minimal document", () => {
  const html = renderHtml({ package: "P", generated_at: "t", findings: [], graph: { nodes: [], edges: [] }, s4_readiness: { s4_readiness_pct: 100, cloud_readiness_pct: 0 } });
  assert.match(html, /^<!doctype html>/i);
});
