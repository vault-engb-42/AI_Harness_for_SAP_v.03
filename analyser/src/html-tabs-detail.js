import { toSarif } from "./sarif.js";
import { esc, num, round, bar, jsonIsland, layerColumns } from "./html-util.js";

/**
 * §3.E HTML report — the detail / data-heavy tab renderers (graph, boundaries,
 * layers, tech-debt, findings, cloud readiness, SARIF), split from html-tabs.js to
 * keep both modules under the 300-line limit. Deterministic, pure, P8-escaped.
 */

// Interactive dependency graph. The server renders a DETERMINISTIC 3-column layered
// layout (entry -> internal -> data, rows by importance) as inline SVG — the no-JS
// fallback, the "Layered" mode, AND the seed for the client-side FORCE simulation
// (html-assets GRAPH_JS): a seeded, no-random spring model that animates the nodes
// into a clustered layout, with drag / zoom buttons / click-highlight. The motion is
// client-side, so emitted bytes stay byte-identical (§3.A). No vendored library.
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
  const w = 1080, h = Math.max(600, 40 + rows * 26 + 20);
  const lines = edges.map((e) => { const a = pos.get(e.source), b = pos.get(e.target); return a && b ? `<line class="ge" data-src="${esc(e.source)}" data-tgt="${esc(e.target)}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>` : ""; }).join("");
  const dots = nodes.map((n) => { const p = pos.get(n.id); const r = 5 + Math.round(num(n.rank) * 9); return `<g class="gn" data-id="${esc(n.id)}" data-x="${p.x}" data-y="${p.y}" transform="translate(${p.x} ${p.y})"><circle r="${r}" fill="${GRAPH_NS_COLOR[n.namespace] ?? "#64748b"}"><title>${esc(n.id)} (${esc(n.kind)} · rank ${round(n.rank)})</title></circle><text x="${r + 3}" y="3">${esc(String(n.object).slice(0, 16))}</text></g>`; }).join("");
  const note = truncated ? `<b>Showing the top ${nodes.length} of ${all.length} nodes by importance.</b> ` : "";
  return `<h2>Dependency Graph — ${all.length} nodes / ${totalEdges} edges</h2>
<p class="muted">${note}Node size = importance (PageRank). Teal = customer · grey = SAP · amber = vendor. Drag nodes; click one to highlight its neighbours.</p>
<div class="gbar"><b>Layout</b> <button type="button" onclick="gLayout('force')">Force</button> <button type="button" onclick="gLayout('layered')">Layered</button> <span class="sep">·</span> <b>Zoom</b> <button type="button" onclick="gZoom(1.25)">+</button> <button type="button" onclick="gZoom(0.8)">−</button> <button type="button" onclick="gFit()">Fit</button> <button type="button" onclick="gReset()">Reset</button></div>
<div class="gwrap"><svg id="gsvg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet"><g id="gv">${lines}${dots}</g></svg></div>`;
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

// Findings tab: a triage view (honest headline + breakdowns) over a virtualized
// browser. The findings ship ONCE as a compact inert JSON island; the client
// (html-assets FINDINGS_JS) filters + paginates (50/page) into #recs via DOM APIs,
// so the file stays small at 100K-LOC scale (the §3.C NFR).
const isModernization = (f) => Boolean(f?.family) && f.family !== "abaplint";
export function findingsTab(doc) {
  const findings = doc.findings ?? [];
  const fams = [...new Set(findings.map((f) => f.family ?? ""))].sort();
  const island = jsonIsland(
    "fdata",
    findings.map((f) => ({ rule_id: f.rule_id, severity: f.severity, family: f.family ?? "", message: f.message, object: f.object, file: f.file ?? "", line: num(f.line), suggestion: f.suggestion ?? "" })),
  );
  const opt = (v, label) => `<option value="${esc(v)}">${esc(label)}</option>`;
  return `<h2>Findings (${findings.length})</h2>
${triage(findings)}
<h3>Browse</h3>
<div class="filters"><select id="fFam">${["", ...fams].map((v) => opt(v, v || "all families")).join("")}</select><select id="fSev">${["", "priority-1", "priority-2", "priority-3", "info"].map((s) => opt(s, s || "all severities")).join("")}</select><span class="muted" id="fInfo"></span></div>
<div id="recs"></div>
<div class="pager"><button type="button" id="fPrev">‹ Prev</button><button type="button" id="fNext">Next ›</button></div>
${island}`;
}

/** Triage: the honest headline + family/severity breakdown + top rules + object hotspots. */
function triage(findings) {
  const total = findings.length;
  const modern = findings.filter(isModernization).length;
  const p1 = findings.filter((f) => f.severity === "priority-1").length;
  const headline = `<p class="muted"><b>${total}</b> findings — <b>${modern}</b> modernization + <b>${total - modern}</b> code-quality lint; <b class="${p1 ? "hot" : ""}">${p1}</b> priority-1 blocker${p1 === 1 ? "" : "s"}. The modernization findings are the migration work; the lint is cleanup.</p>`;
  return `${headline}
<div class="cols"><div><h3>By family</h3>${tally(findings, (f) => f.family || "unknown", true)}</div>
<div><h3>Top rules</h3>${tally(findings, (f) => f.rule_id || "unknown", false, 8)}</div>
<div><h3>Hotspot objects</h3>${tally(findings, (f) => f.object || "unknown", false, 8)}</div></div>`;
}

/** Count findings by a key -> a compact table (optionally with a priority-1 column), top N by count. */
function tally(findings, keyOf, withP1, top) {
  const by = new Map();
  for (const f of findings) {
    const k = keyOf(f);
    if (!by.has(k)) by.set(k, { count: 0, p1: 0 });
    const e = by.get(k);
    e.count += 1;
    if (f.severity === "priority-1") e.p1 += 1;
  }
  let entries = [...by.entries()].sort((a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : 1));
  if (top) entries = entries.slice(0, top);
  const rows = entries.map(([k, e]) => `<tr><td>${esc(k)}</td><td>${e.count}</td>${withP1 ? `<td class="${e.p1 ? "hot" : ""}">${e.p1}</td>` : ""}</tr>`).join("");
  return `<table><thead><tr><th>${withP1 ? "Family" : "Name"}</th><th>Count</th>${withP1 ? "<th>P1</th>" : ""}</tr></thead><tbody>${rows || `<tr><td colspan=${withP1 ? 3 : 2}><i>none</i></td></tr>`}</tbody></table>`;
}

const IMPACT_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
export function cloudTab(doc) {
  const cr = doc.cloud_readiness ?? {};
  const s4 = doc.s4_readiness ?? {};
  const t = num(s4.total_objects);
  return `<h2>S/4HANA &amp; Cloud Readiness</h2>${bar("S/4HANA-ready", s4.s4_readiness_pct)}${bar("ABAP Cloud-ready", s4.cloud_readiness_pct)}
<p class="muted small"><b>Readiness = share of the ${t} customer objects with no blocking finding</b>, over ALL checks (not just registry dependencies). ${num(s4.cloud_blocked_objects)}/${t} objects are Cloud-blocked by ${num(s4.cloud_blocker_findings)} findings; ${num(s4.s4_blocked_objects)}/${t} S/4-blocked by ${num(s4.s4_blocker_findings)}. Cloud is stricter: deprecated/removed deps + modifications break S/4, and clean-core patterns (CALL FUNCTION, classic ALV/Dynpro) + security patterns (kernel calls, dynamic code gen) additionally block ABAP Cloud though they still run on S/4 on-prem.</p>
<h3>API dependency hygiene <span class="muted">(secondary — which SAP deps you use, by release state)</span></h3>
<p class="muted small">${num(s4.released_hits)} released · ${num(s4.classic_api_hits)} classic-API · ${num(s4.deprecated_hits)} deprecated · ${num(s4.not_released_hits)} removed, of ${num(s4.total_api_calls)} classifiable SAP-API dependency edges. (This is dependency hygiene, NOT the readiness denominator.)</p>
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
