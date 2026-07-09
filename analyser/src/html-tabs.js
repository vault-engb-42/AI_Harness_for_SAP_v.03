import { toSarif } from "./sarif.js";
import { esc, num, round, bar, jsonIsland, layerColumns } from "./html-util.js";

/**
 * §3.E HTML report — per-tab renderers (split from html-report.js). Each function
 * is a deterministic, pure transform of the analyser document into a tab body;
 * all document-derived text passes through esc() (P8). renderHtml (html-report.js)
 * composes these into the tabbed page.
 */

// ── Business recommendations: findings -> plain-language themes ──────────────
const THEME = {
  "released-api": { t: "Uses SAP objects retired in S/4HANA", why: "Your code directly reads SAP tables / calls APIs that SAP is replacing in S/4HANA — they stop working after migration.", act: "Switch each to its released successor (CDS view / released API).", impact: "High — blocks S/4HANA & Cloud" },
  deprecation: { t: "Deprecated SAP objects in use", why: "Objects SAP has flagged for removal are still used.", act: "Move to the released replacement before it is withdrawn.", impact: "High — future breakage" },
  "clean-core": { t: "Not Clean-Core compliant", why: "Uses patterns forbidden in ABAP Cloud (classic function calls, classic ALV/Dynpro UI).", act: "Rebuild on released APIs + RAP/Fiori.", impact: "High — blocks ABAP Cloud" },
  performance: { t: "Performance risks on HANA", why: "Query/loop patterns (SELECT *, DB access in loops) that are slow or unsafe on the HANA database.", act: "Use explicit field lists, set-based operations, and CDS pushdown.", impact: "Medium — slowness / timeouts" },
  modification: { t: "Modifications to SAP standard", why: "Changes to SAP-delivered objects that conflict during upgrades.", act: "Move to a released extension point (BAdI / enhancement).", impact: "High — upgrade conflicts" },
  invariant: { t: "Authorization / security review", why: "Authorization checks or commit handling that need review.", act: "Confirm AUTHORITY-CHECK coverage and transactional integrity.", impact: "High — compliance risk" },
  "anti-pattern": { t: "Maintainability risks", why: "Duplication, missing tests and structural smells that make change slow and error-prone.", act: "Refactor the hotspots and add ABAP Unit tests.", impact: "Medium — higher change cost" },
  "rap-odata": { t: "API / service modernization", why: "OData / RAP service patterns to modernize.", act: "Adopt RAP behaviour + OData V4.", impact: "Medium" },
};
const THEME_ORDER = ["released-api", "clean-core", "deprecation", "modification", "invariant", "performance", "rap-odata", "anti-pattern"];

function themes(doc) {
  const by = new Map();
  for (const f of doc.findings ?? []) {
    const key = THEME[f.family] ? f.family : "anti-pattern";
    if (!by.has(key)) by.set(key, { count: 0, objs: new Set(), examples: [] });
    const g = by.get(key);
    g.count++;
    if (f.object) g.objs.add(f.object);
    if (g.examples.length < 3 && f.suggestion) g.examples.push(f.suggestion);
  }
  return [...by.entries()].sort((a, b) => (THEME_ORDER.indexOf(a[0]) - THEME_ORDER.indexOf(b[0])) || b[1].count - a[1].count);
}

export function recommendationsTab(doc) {
  const cards = themes(doc).map(([fam, g]) => {
    const m = THEME[fam];
    const objs = [...g.objs].sort().slice(0, 8).map((o) => `<span class="tag">${esc(o)}</span>`).join("");
    const ex = g.examples.map((e) => `<li>${esc(e)}</li>`).join("");
    return `<div class="rec impact-${m.impact[0]}"><div class="rt">${esc(m.t)} <span class="pill">${g.count} findings · ${g.objs.size} objects</span></div><div class="ri">${esc(m.impact)}</div><p>${esc(m.why)}</p><p class="act"><b>What to do:</b> ${esc(m.act)}</p>${ex ? `<ul class="ex">${ex}</ul>` : ""}<div class="tags">${objs}</div></div>`;
  }).join("");
  return `<h2>Recommendations</h2><p class="muted">Plain-language, prioritised by business impact. Technical detail is in the Findings tab.</p>${cards || "<i>No findings — nothing to remediate.</i>"}`;
}

// ── Modernization Plan (§3.D): what to modernize, in what order, at what cost ──
const EFFORT_LABEL = { XL: "extra-large", L: "large", M: "medium", S: "small" };
export function planTab(doc) {
  const p = doc.modernization_plan ?? { objects: [], summary: {} };
  const s = p.summary ?? {};
  const eff = s.by_effort ?? {};
  const pri = s.by_priority ?? {};
  const cards = [
    ["Objects", s.total_objects ?? 0, false],
    ["XL effort", eff.XL ?? 0, true], ["L", eff.L ?? 0, false], ["M", eff.M ?? 0, false], ["S", eff.S ?? 0, false],
    ["P1 priority", pri.P1 ?? 0, true], ["P2", pri.P2 ?? 0, false], ["P3", pri.P3 ?? 0, false],
  ].map(([l, v, hot]) => `<div class="card"><b class="${hot && v ? "hot" : ""}">${esc(String(v))}</b><span>${esc(l)}</span></div>`).join("");
  const rows = (p.objects ?? []).map((o, i) => `<tr><td class="muted">${i + 1}</td><td>${esc(o.object)}</td><td class="muted small">${esc(o.kind)}</td><td>${esc(o.modernization_target)}</td><td><span class="pill" title="${esc(EFFORT_LABEL[o.effort_tier] ?? "")}">${esc(o.effort_tier)}</span></td><td><span class="pill">${esc(o.priority_rank)}</span></td><td>${num(o.migration_complexity)}/5</td><td>${num(o.transformation_count)}</td></tr>`).join("");
  return `<h2>Modernization Plan <span class="muted">(${s.total_objects ?? 0} customer objects, transport-ordered)</span></h2>
<p class="muted">Per customer object: the target artifact, effort (by debt + size), priority (by importance/PageRank), migration complexity (0–5), and the number of modernization steps. Rows are in safe transport-release order (CDS → interfaces → classes → behaviour → the rest).</p>
<div class="cards">${cards}</div>
<table><thead><tr><th>#</th><th>Object</th><th>Kind</th><th>Target</th><th>Effort</th><th>Priority</th><th>Complexity</th><th>Steps</th></tr></thead><tbody>${rows || "<tr><td colspan=8><i>no customer objects to modernize</i></td></tr>"}</tbody></table>`;
}

const card = (label, value, hot) => `<div class="card"><b class="${hot && value ? "hot" : ""}">${esc(String(value))}</b><span>${esc(label)}</span></div>`;

export function summaryTab(doc) {
  const ch = doc.code_health ?? {};
  const ns = doc.namespace_summary ?? {};
  const nodes = doc.graph?.nodes ?? [];
  const p1 = (doc.findings ?? []).filter((f) => f.severity === "priority-1").length;
  const cards = [
    ["Objects", nodes.filter((n) => !["table", "method", "form"].includes(n.kind)).length, false],
    ["Findings", (doc.findings ?? []).length, false], ["Priority-1", p1, true], ["Debt hotspots", doc.debt?.hotspot_count ?? 0, false],
    ["Customer objects", num(ns.customer_total), false], ["Clean-core grade", ch.clean_core_grade ?? "?", false],
  ].map(([l, v, hot]) => card(l, v, hot)).join("");
  const top = themes(doc).slice(0, 3).map(([fam, g]) => `<li><b>${esc(THEME[fam].t)}</b> — ${g.count} findings across ${g.objs.size} objects (${esc(THEME[fam].impact)})</li>`).join("");
  return `<h2>Executive Summary — ${esc(doc.package ?? "")}</h2><div class="cards">${cards}</div>
${codebaseSection(doc.metrics)}
<h3>Readiness</h3>${bar("S/4HANA", doc.s4_readiness?.s4_readiness_pct)}${bar("Cloud", doc.s4_readiness?.cloud_readiness_pct)}
<h3>Code health (${esc(ch.clean_core_grade ?? "?")})</h3>${bar("Clarity", ch.clarity)}${bar("Stability", ch.stability)}${bar("Performance", ch.performance)}${bar("Compound", ch.compound)}
<h3>Top risks</h3><ol class="risks">${top || "<li>none</li>"}</ol>`;
}

/** Codebase-scale metrics (§ metrics block): the "how big / how maintainable" view. */
function codebaseSection(m) {
  if (!m) return "";
  const kinds = Object.entries(m.by_kind ?? {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${esc(k)} ${v}`).join(" · ") || "—";
  const cards = [
    card(`Total LOC`, num(m.total_loc).toLocaleString("en-US"), false),
    card(`Files`, num(m.file_count), false),
    card(`Objects`, num(m.object_count), false),
    card(`Size class`, m.size_class ?? "?", false),
    card(`Maintainability`, num(m.maintainability_index), num(m.maintainability_index) < 40),
    card(`Max nesting`, num(m.max_nesting), num(m.max_nesting) > 5),
    card(`Max cyclomatic`, num(m.max_cyclomatic), num(m.max_cyclomatic) > 20),
    card(`Duplication`, num(m.duplication_findings), num(m.duplication_findings) > 0),
  ].join("");
  return `<h3>Codebase</h3><div class="cards">${cards}</div>
<p class="muted small">${num(m.customer_loc).toLocaleString("en-US")} customer LOC · ${num(m.sap_loc).toLocaleString("en-US")} SAP LOC · ${Math.round(num(m.comment_ratio) * 100)}% comments · by kind: ${kinds}. Maintainability Index 0–100 (SEI/Microsoft, higher = easier to change; &lt;40 = hard).</p>`;
}

export function codeHealthTab(doc) {
  const ch = doc.code_health ?? {};
  const note = {
    Clarity: "Readability: each object scored by its WORST attribute — cyclomatic complexity, routine length, nesting, or class cohesion (LCOM*). Higher = clearer.",
    Stability: "Distance from Robert Martin's main sequence over the dependency core. Higher = better-placed.",
    Performance: "Share of objects free of performance findings.",
    Compound: "Mean of the three above.",
  };
  const bars = ["Clarity", "Stability", "Performance", "Compound"].map((k) => `${bar(k, ch[k.toLowerCase()])}<p class="muted small">${esc(note[k])}</p>`).join("");
  return `<h2>Code Health — grade ${esc(ch.clean_core_grade ?? "?")}</h2>${bars}
${clarityBreakdown(ch.clarity_breakdown)}
<h3>By object <span class="muted">(worst first)</span></h3>${perObjectHealthTable(ch.by_object)}`;
}

/** The four clarity sub-axes as bars, so the clarity number is explainable. */
function clarityBreakdown(b) {
  if (!b) return "";
  const rows = [["Cyclomatic", b.cyclomatic], ["Routine length", b.length], ["Nesting", b.nesting], ["Cohesion (LCOM*)", b.lcom]]
    .filter(([, v]) => v != null).map(([l, v]) => bar(l, v)).join("");
  return `<h3>Clarity breakdown <span class="muted">(lower axis = the readability fault)</span></h3>${rows}`;
}

/** Per-object health drill-down — which objects, and why, drag the package scores down. */
function perObjectHealthTable(byObject) {
  const rows = (byObject ?? []).map((o) => {
    const lcom = o.lcom == null ? "—" : round(o.lcom);
    return `<tr><td>${esc(o.object)}</td><td class="muted small">${esc(o.kind)}</td><td class="${num(o.cyclomatic) > 20 ? "hot" : ""}">${num(o.cyclomatic)}</td><td class="${num(o.max_routine_loc) > 150 ? "hot" : ""}">${num(o.max_routine_loc)}</td><td class="${num(o.nesting) > 5 ? "hot" : ""}">${num(o.nesting)}</td><td>${lcom}</td><td class="${num(o.perf_findings) ? "hot" : ""}">${num(o.perf_findings)}</td><td><span class="pill">${esc(o.grade)}</span></td><td><b class="${num(o.penalty) >= 0.5 ? "hot" : ""}">${round(o.penalty)}</b></td></tr>`;
  }).join("");
  return `<table><thead><tr><th>Object</th><th>Kind</th><th>Max cyclomatic</th><th>Longest routine (LOC)</th><th>Nesting</th><th>LCOM*</th><th>Perf</th><th>Grade</th><th>Clarity penalty</th></tr></thead><tbody>${rows || "<tr><td colspan=9><i>no objects</i></td></tr>"}</tbody></table>`;
}

// Interactive dependency graph: a deterministic 3-column layered layout computed
// here (entry -> internal -> data, rows by importance), rendered as inline SVG with
// client-side pan/zoom/click-highlight (html-assets GRAPH_JS). No vendored library;
// positions are a pure function of the sorted nodes + layers, so bytes stay stable.
const GRAPH_NS_COLOR = { Z: "#0ea5a4", Y: "#0ea5a4", sap: "#94a3b8", registered: "#d97706" };
const GRAPH_COL_X = { entry: 170, internal: 520, data: 870 };
const MAX_GRAPH_RENDER = 300;

export function graphTab(doc) {
  const all = doc.graph?.nodes ?? [];
  const totalEdges = (doc.graph?.edges ?? []).length;
  const byRank = (a, b) => num(b.rank) - num(a.rank) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  // Cap large graphs to the most important nodes — never silently (note it).
  const nodes = [...all].sort(byRank).slice(0, MAX_GRAPH_RENDER);
  const shown = new Set(nodes.map((n) => n.id));
  const edges = (doc.graph?.edges ?? []).filter((e) => shown.has(e.source) && shown.has(e.target));
  const truncated = all.length > nodes.length;

  const col = layerColumns(doc.layers ?? {});
  const groups = { entry: [], internal: [], data: [] };
  for (const n of nodes) groups[col.get(n.id) ?? "entry"].push(n);
  const pos = new Map();
  let rows = 1;
  for (const [layer, list] of Object.entries(groups)) {
    list.sort(byRank);
    list.forEach((n, i) => pos.set(n.id, { x: GRAPH_COL_X[layer], y: 40 + i * 26 }));
    rows = Math.max(rows, list.length);
  }
  const w = 1080, h = 40 + rows * 26 + 20;
  const lines = edges.map((e) => { const a = pos.get(e.source), b = pos.get(e.target); return a && b ? `<line class="ge" data-src="${esc(e.source)}" data-tgt="${esc(e.target)}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>` : ""; }).join("");
  const dots = nodes.map((n) => { const p = pos.get(n.id); const r = 5 + Math.round(num(n.rank) * 9); return `<g class="gn" data-id="${esc(n.id)}"><circle cx="${p.x}" cy="${p.y}" r="${r}" fill="${GRAPH_NS_COLOR[n.namespace] ?? "#64748b"}"><title>${esc(n.id)} (${esc(n.kind)} · rank ${round(n.rank)})</title></circle><text x="${p.x + r + 3}" y="${p.y + 3}">${esc(String(n.object).slice(0, 16))}</text></g>`; }).join("");
  const note = truncated ? `<b>Showing the top ${nodes.length} of ${all.length} nodes by importance.</b> ` : "";
  return `<h2>Dependency Graph — ${all.length} nodes / ${totalEdges} edges</h2>
<p class="muted">${note}Columns: entry → internal → data. Node size = importance (PageRank). Teal = customer · grey = SAP · amber = vendor.</p>
<div class="scroll gwrap"><svg id="gsvg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet"><g id="gv">${lines}${dots}</g></svg></div>
<div class="ghint">Scroll to zoom · drag to pan · click a node to highlight its dependencies · <button type="button" onclick="gReset()">reset view</button></div>`;
}

export function boundariesTab(doc) {
  const rows = (doc.boundaries ?? []).map((b) => `<tr><td>${esc(b.name)}</td><td>${esc(b.kind)}</td><td>${esc(b.direction)}</td></tr>`).join("");
  return `<h2>System Boundaries</h2><table><thead><tr><th>Name</th><th>Kind</th><th>Direction</th></tr></thead><tbody>${rows || "<tr><td colspan=3><i>none</i></td></tr>"}</tbody></table>`;
}

export function layersTab(doc) {
  const l = doc.layers ?? {};
  const block = (name, arr) => `<div class="layer"><b>${esc(name)}</b> <span class="muted">${(arr ?? []).length} symbols</span><div class="tags">${(arr ?? []).map((s) => `<span class="tag">${esc(s)}</span>`).join("")}</div></div>`;
  return `<h2>Architectural Layers</h2>${block("entry", l.entry)}${block("internal", l.internal)}${block("data", l.data)}`;
}

export function debtTab(doc) {
  const rows = (doc.debt?.scores ?? []).map((s) => {
    const sig = Object.entries(s.signals ?? {}).map(([k, v]) => `${esc(k)}: ${round(v)}`).join(", ");
    return `<tr><td>${esc(s.symbol)}</td><td><b class="${s.score > 0.5 ? "hot" : ""}">${round(s.score)}</b></td><td class="muted small">${sig}</td></tr>`;
  }).join("");
  return `<h2>Technical Debt <span class="muted">(avg ${round(doc.debt?.avg_score)} · max ${round(doc.debt?.max_score)} · ${doc.debt?.hotspot_count ?? 0} hotspots)</span></h2><table><thead><tr><th>Symbol</th><th>Score</th><th>Signals</th></tr></thead><tbody>${rows || "<tr><td colspan=3><i>none</i></td></tr>"}</tbody></table>`;
}

// Findings virtualization: emit the findings ONCE as a compact inert JSON island;
// the client (html-assets FINDINGS_JS) filters + paginates (50/page) into #recs via
// DOM APIs. Keeps the file small and fast even on 100K-LOC repos (the §3.C NFR).
export function findingsTab(doc) {
  const findings = doc.findings ?? [];
  const fams = [...new Set(findings.map((f) => f.family ?? ""))].sort();
  const island = jsonIsland(
    "fdata",
    findings.map((f) => ({ rule_id: f.rule_id, severity: f.severity, family: f.family ?? "", message: f.message, object: f.object, file: f.file ?? "", line: num(f.line), suggestion: f.suggestion ?? "" })),
  );
  const opt = (v, label) => `<option value="${esc(v)}">${esc(label)}</option>`;
  return `<h2>Findings — technical detail (${findings.length})</h2>
<div class="filters"><select id="fFam">${["", ...fams].map((v) => opt(v, v || "all families")).join("")}</select><select id="fSev">${["", "priority-1", "priority-2", "priority-3", "info"].map((s) => opt(s, s || "all severities")).join("")}</select><span class="muted" id="fInfo"></span></div>
<div id="recs"></div>
<div class="pager"><button type="button" id="fPrev">‹ Prev</button><button type="button" id="fNext">Next ›</button></div>
${island}`;
}

const IMPACT_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
export function cloudTab(doc) {
  const cr = doc.cloud_readiness ?? {};
  const s4 = doc.s4_readiness ?? {};
  return `<h2>Cloud Readiness</h2>${bar("S/4HANA Ready", s4.s4_readiness_pct)}${bar("Cloud Ready", s4.cloud_readiness_pct)}
<p class="muted small">S/4-ready = released + classic-API objects; Cloud-ready = released only. ${num(s4.released_hits)} released · ${num(s4.classic_api_hits)} classic-API · ${num(s4.deprecated_hits)} deprecated · ${num(s4.not_released_hits)} removed, of ${num(s4.total_api_calls)} classifiable API uses.</p>
<h3>Clean-Core grade distribution</h3>${gradeDistribution(doc.graph?.nodes)}
<h3>Findings by clean-core bucket</h3><div class="cards"><div class="card"><b class="hot">${cr.blockers?.findings ?? 0}</b><span>Blockers (D)</span></div><div class="card"><b>${cr.warnings?.findings ?? 0}</b><span>Warnings (C)</span></div><div class="card"><b>${cr.advisories?.findings ?? 0}</b><span>Advisories (B)</span></div><div class="card"><b>${cr.needs_review?.findings ?? 0}</b><span>Needs review</span></div></div>
<h3>Blast radius <span class="muted">(deprecated SAP objects, most-affected first)</span></h3>${blastRadiusTable(doc.blast_radius)}
<h3>Released-API successors <span class="muted">(what to replace, and who uses it)</span></h3>${successorTable(doc.findings)}`;
}

/** A/B/C/D/unknown object counts from the graph (deduped per object, not per member node). */
function gradeDistribution(nodes) {
  const byObject = new Map();
  for (const n of nodes ?? []) if (n.object && !byObject.has(n.object)) byObject.set(n.object, n.clean_core_grade ?? "unknown");
  const tally = { A: 0, B: 0, C: 0, D: 0, unknown: 0 };
  for (const g of byObject.values()) tally[g in tally ? g : "unknown"] += 1;
  const label = { A: "A · cloud-ready", B: "B · classic API", C: "C · deprecated", D: "D · blocker", unknown: "unknown" };
  return `<div class="cards">${["D", "C", "B", "A", "unknown"].map((g) => `<div class="card"><b class="${(g === "D" || g === "C") && tally[g] ? "hot" : ""}">${tally[g]}</b><span>${esc(label[g])}</span></div>`).join("")}</div>`;
}

/** Blast-radius table (doc.blast_radius) — computed today, previously rendered nowhere in the HTML. */
function blastRadiusTable(blast) {
  const rows = [...(blast ?? [])]
    .sort((a, b) => num(b.affected_program_count) - num(a.affected_program_count) || (IMPACT_RANK[a.highest_impact] ?? 9) - (IMPACT_RANK[b.highest_impact] ?? 9))
    .map((b) => `<tr><td>${esc(b.object)}</td><td>${num(b.affected_program_count)}</td><td><span class="pill">${esc(b.highest_impact ?? "—")}</span></td><td class="muted small">${esc(b.successor_kind ?? "—")}</td></tr>`)
    .join("");
  return `<table><thead><tr><th>SAP object</th><th>Affected programs</th><th>Impact</th><th>Successor kind</th></tr></thead><tbody>${rows || "<tr><td colspan=4><i>no at-risk SAP dependencies</i></td></tr>"}</tbody></table>`;
}

/** Released-API successor map from the registry-family findings: SAP object -> fix -> customer users. */
function successorTable(findings) {
  const by = new Map();
  for (const f of findings ?? []) {
    if (!f.referenced_object || !f.suggestion) continue;
    if (!by.has(f.referenced_object)) by.set(f.referenced_object, { fix: f.suggestion, users: new Set(), severity: f.severity });
    if (f.object) by.get(f.referenced_object).users.add(f.object);
  }
  const rows = [...by.entries()]
    .sort((a, b) => b[1].users.size - a[1].users.size || (a[0] < b[0] ? -1 : 1))
    .map(([obj, e]) => `<tr><td>${esc(obj)}</td><td class="fix">${esc(e.fix)}</td><td>${e.users.size}</td><td><span class="pill">${esc(e.severity ?? "")}</span></td></tr>`)
    .join("");
  return `<table><thead><tr><th>SAP object</th><th>Recommended replacement</th><th>Customer objects using it</th><th>Severity</th></tr></thead><tbody>${rows || "<tr><td colspan=4><i>no released-API successors identified</i></td></tr>"}</tbody></table>`;
}

// SARIF tab: a summary panel, NOT the raw document (operator-confirmed 2026-07-09).
// SARIF is a MACHINE interchange format — no human reads raw SARIF JSON, and baking
// it in bloats the human report (it was 51% of the bytes) and duplicates
// analyser-findings.json. The full document is exported standalone via the CLI's
// `--sarif <file>`; here we just surface that it exists + a level breakdown. Humans
// read findings in the Findings tab.
export function sarifTab(doc) {
  let results = [];
  try {
    results = toSarif(doc).runs?.[0]?.results ?? [];
  } catch {
    results = [];
  }
  const byLevel = { error: 0, warning: 0, note: 0 };
  for (const r of results) if (byLevel[r.level] !== undefined) byLevel[r.level] += 1;
  const cards = [["Results", results.length, false], ["Errors", byLevel.error, true], ["Warnings", byLevel.warning, false], ["Notes", byLevel.note, false]]
    .map(([l, v, hot]) => `<div class="card"><b class="${hot && v ? "hot" : ""}">${esc(String(v))}</b><span>${esc(l)}</span></div>`).join("");
  return `<h2>SARIF 2.1.0 export — ${results.length} results</h2>
<p class="muted">SARIF (Static Analysis Results Interchange Format) is the OASIS-standard JSON for static-analysis findings — a <b>machine</b> artifact, consumed by GitHub code scanning, CI, IDE SARIF viewers, and the moderniser, not read by hand. Browse findings in the <b>Findings</b> tab; export the standard file for tools.</p>
<div class="cards">${cards}</div>
<p class="muted small">Export the full document: run the analyser with <code>--sarif &lt;file&gt;.sarif</code>. Each finding becomes a <code>result</code> (ruleId · level · location · message); each distinct rule a <code>reportingDescriptor</code>.</p>`;
}
