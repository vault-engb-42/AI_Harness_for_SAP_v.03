import { toSarif } from "./sarif.js";

/**
 * §3.E self-contained HTML report — the analyser's OWN renderer (never
 * hand-generated per run). A deterministic, pure transform of an analyser
 * findings document into a single interactive `file://` HTML page: no external
 * resource loads, all finding-derived text HTML-entity-escaped (P8 — scanned
 * ABAP is untrusted). One tab per dimension, plus an executive Summary and a
 * business-readable Recommendations tab. Cytoscape + finding virtualization are
 * the Phase-3 polish; v1 uses a deterministic-grid SVG graph + full tables.
 *
 * @param {object} doc analyser-findings document
 * @param {{fragment?: boolean}} [opts] fragment=true -> body-embeddable content
 *   (host supplies skeleton + CSP); default = a full standalone document.
 * @returns {string} HTML
 */
export function renderHtml(doc, opts = {}) {
  const tabs = [
    ["summary", "Summary", summaryTab(doc)],
    ["recs", "Recommendations", recommendationsTab(doc)],
    ["health", "Code Health", codeHealthTab(doc)],
    ["debt", "Tech Debt", debtTab(doc)],
    ["cloud", "Cloud Readiness", cloudTab(doc)],
    ["graph", "Graph", graphTab(doc)],
    ["boundaries", "Boundaries", boundariesTab(doc)],
    ["layers", "Layers", layersTab(doc)],
    ["findings", "Findings", findingsTab(doc)],
    ["sarif", "SARIF", sarifTab(doc)],
  ];
  const nav = tabs.map(([id, label], i) => `<button class="tab${i ? "" : " on"}" data-t="${id}">${esc(label)}</button>`).join("");
  const panels = tabs.map(([id, , body], i) => `<section class="panel${i ? "" : " on"}" id="p-${id}">${body}</section>`).join("");
  const inner = `<style>${CSS}</style>
<header><h1>Analyse — ${esc(doc.package ?? "package")}</h1><span class="chip">${(doc.graph?.nodes?.length ?? 0)} nodes · ${(doc.graph?.edges?.length ?? 0)} edges · ${(doc.findings ?? []).length} findings · S/4 ${num(doc.s4_readiness?.s4_readiness_pct)}% · run ${esc(String(doc.run_id ?? "").slice(0, 10))}</span></header>
<nav class="tabs">${nav}</nav>${panels}<script>${JS}</script>`;
  if (opts.fragment) return inner;
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><title>Analyse — ${esc(doc.package ?? "package")}</title></head><body>${inner}</body></html>`;
}

/** HTML-entity escape — the single P8 defence for all doc-derived text. */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const num = (v) => (typeof v === "number" ? v : 0);
const round = (v) => (typeof v === "number" ? Math.round(v * 1000) / 1000 : 0);
const sortedByJson = (arr) => [...arr].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));

function bar(label, pct) {
  const p = Math.max(0, Math.min(100, num(pct)));
  const cls = p >= 80 ? "g" : p >= 50 ? "a" : "r";
  return `<div class="bar"><span>${esc(label)}</span><div class="track"><i class="${cls}" style="width:${p}%"></i></div><b>${p}%</b></div>`;
}

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

function recommendationsTab(doc) {
  const cards = themes(doc).map(([fam, g]) => {
    const m = THEME[fam];
    const objs = [...g.objs].sort().slice(0, 8).map((o) => `<span class="tag">${esc(o)}</span>`).join("");
    const ex = g.examples.map((e) => `<li>${esc(e)}</li>`).join("");
    return `<div class="rec impact-${m.impact[0]}"><div class="rt">${esc(m.t)} <span class="pill">${g.count} findings · ${g.objs.size} objects</span></div><div class="ri">${esc(m.impact)}</div><p>${esc(m.why)}</p><p class="act"><b>What to do:</b> ${esc(m.act)}</p>${ex ? `<ul class="ex">${ex}</ul>` : ""}<div class="tags">${objs}</div></div>`;
  }).join("");
  return `<h2>Recommendations</h2><p class="muted">Plain-language, prioritised by business impact. Technical detail is in the Findings tab.</p>${cards || "<i>No findings — nothing to remediate.</i>"}`;
}

function summaryTab(doc) {
  const ch = doc.code_health ?? {};
  const ns = doc.namespace_summary ?? {};
  const nodes = doc.graph?.nodes ?? [];
  const p1 = (doc.findings ?? []).filter((f) => f.severity === "priority-1").length;
  const cards = [
    ["Objects", nodes.filter((n) => !["table", "method", "form"].includes(n.kind)).length],
    ["Findings", (doc.findings ?? []).length], ["Priority-1", p1], ["Debt hotspots", doc.debt?.hotspot_count ?? 0],
    ["Customer objects", num(ns.customer_total)], ["Clean-core grade", ch.clean_core_grade ?? "?"],
  ].map(([l, v]) => `<div class="card"><b class="${l === "Priority-1" && v ? "hot" : ""}">${esc(String(v))}</b><span>${esc(l)}</span></div>`).join("");
  const top = themes(doc).slice(0, 3).map(([fam, g]) => `<li><b>${esc(THEME[fam].t)}</b> — ${g.count} findings across ${g.objs.size} objects (${esc(THEME[fam].impact)})</li>`).join("");
  return `<h2>Executive Summary — ${esc(doc.package ?? "")}</h2><div class="cards">${cards}</div>
<h3>Readiness</h3>${bar("S/4HANA", doc.s4_readiness?.s4_readiness_pct)}${bar("Cloud", doc.s4_readiness?.cloud_readiness_pct)}
<h3>Code health (${esc(ch.clean_core_grade ?? "?")})</h3>${bar("Clarity", ch.clarity)}${bar("Stability", ch.stability)}${bar("Performance", ch.performance)}${bar("Compound", ch.compound)}
<h3>Top risks</h3><ol class="risks">${top || "<li>none</li>"}</ol>`;
}

function codeHealthTab(doc) {
  const ch = doc.code_health ?? {};
  const note = {
    Clarity: "Method complexity (cyclomatic) + class cohesion (LCOM). Higher = clearer.",
    Stability: "Distance from Robert Martin's main sequence over the dependency core. Higher = better-placed.",
    Performance: "Share of objects free of performance findings.",
    Compound: "Mean of the three above.",
  };
  const rows = ["Clarity", "Stability", "Performance", "Compound"].map((k) => `${bar(k, ch[k.toLowerCase()])}<p class="muted small">${esc(note[k])}</p>`).join("");
  return `<h2>Code Health — grade ${esc(ch.clean_core_grade ?? "?")}</h2>${rows}`;
}

function graphTab(doc) {
  const nodes = sortedByJson(doc.graph?.nodes ?? []);
  const edges = doc.graph?.edges ?? [];
  const cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length || 1)));
  const gap = 150;
  const pos = new Map();
  nodes.forEach((n, i) => pos.set(n.id, { x: 40 + (i % cols) * gap, y: 50 + Math.floor(i / cols) * 70 }));
  const color = { Z: "#0ea5a4", Y: "#0ea5a4", sap: "#94a3b8", registered: "#d97706" };
  const w = 40 + cols * gap, h = 90 + Math.ceil((nodes.length || 1) / cols) * 70;
  const lines = edges.map((e) => { const a = pos.get(e.source), b = pos.get(e.target); return a && b ? `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#cbd5e1"/>` : ""; }).join("");
  const dots = nodes.map((n) => { const p = pos.get(n.id); return `<g><circle cx="${p.x}" cy="${p.y}" r="${n.kind === "table" ? 10 : 8}" fill="${color[n.namespace] ?? "#64748b"}"><title>${esc(n.id)} (${esc(n.kind)})</title></circle><text x="${p.x}" y="${p.y - 12}" font-size="9" text-anchor="middle">${esc(String(n.object).slice(0, 16))}</text></g>`; }).join("");
  return `<h2>Dependency Graph — ${nodes.length} nodes / ${edges.length} edges</h2><p class="muted">Deterministic grid layout (Cytoscape is the Phase-3 upgrade). Teal = customer · grey = SAP · amber = vendor.</p><div class="scroll"><svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${lines}${dots}</svg></div>`;
}

function boundariesTab(doc) {
  const rows = (doc.boundaries ?? []).map((b) => `<tr><td>${esc(b.name)}</td><td>${esc(b.kind)}</td><td>${esc(b.direction)}</td></tr>`).join("");
  return `<h2>System Boundaries</h2><table><thead><tr><th>Name</th><th>Kind</th><th>Direction</th></tr></thead><tbody>${rows || "<tr><td colspan=3><i>none</i></td></tr>"}</tbody></table>`;
}

function layersTab(doc) {
  const l = doc.layers ?? {};
  const block = (name, arr) => `<div class="layer"><b>${esc(name)}</b> <span class="muted">${(arr ?? []).length} symbols</span><div class="tags">${(arr ?? []).map((s) => `<span class="tag">${esc(s)}</span>`).join("")}</div></div>`;
  return `<h2>Architectural Layers</h2>${block("entry", l.entry)}${block("internal", l.internal)}${block("data", l.data)}`;
}

function debtTab(doc) {
  const rows = (doc.debt?.scores ?? []).map((s) => {
    const sig = Object.entries(s.signals ?? {}).map(([k, v]) => `${esc(k)}: ${round(v)}`).join(", ");
    return `<tr><td>${esc(s.symbol)}</td><td><b class="${s.score > 0.5 ? "hot" : ""}">${round(s.score)}</b></td><td class="muted small">${sig}</td></tr>`;
  }).join("");
  return `<h2>Technical Debt <span class="muted">(avg ${round(doc.debt?.avg_score)} · max ${round(doc.debt?.max_score)} · ${doc.debt?.hotspot_count ?? 0} hotspots)</span></h2><table><thead><tr><th>Symbol</th><th>Score</th><th>Signals</th></tr></thead><tbody>${rows || "<tr><td colspan=3><i>none</i></td></tr>"}</tbody></table>`;
}

function findingsTab(doc) {
  const cards = (doc.findings ?? []).map((f) => `<div class="rec sev-${esc(f.severity)}" data-fam="${esc(f.family ?? "")}" data-sev="${esc(f.severity ?? "")}"><div><code>${esc(f.rule_id)}</code> <span class="pill">${esc(f.severity)}</span> <span class="muted">${esc(f.family ?? "")}</span></div><div>${esc(f.message)}</div>${f.suggestion ? `<div class="fix">Fix: ${esc(f.suggestion)}</div>` : ""}<div class="muted small">${esc(f.object)} · ${esc(f.file ?? "")}:${num(f.line)}</div></div>`).join("");
  const fams = [...new Set((doc.findings ?? []).map((f) => f.family ?? ""))].sort();
  return `<h2>Findings — technical detail (${(doc.findings ?? []).length})</h2><div class="filters"><select id="fFam" onchange="filterRecs()">${["", ...fams].map((v) => `<option value="${esc(v)}">${esc(v || "all families")}</option>`).join("")}</select><select id="fSev" onchange="filterRecs()">${["", "priority-1", "priority-2", "priority-3", "info"].map((s) => `<option value="${s}">${s || "all severities"}</option>`).join("")}</select></div><div id="recs">${cards || "<i>none</i>"}</div>`;
}

function cloudTab(doc) {
  const cr = doc.cloud_readiness ?? {};
  return `<h2>Cloud Readiness</h2>${bar("S/4HANA Ready", doc.s4_readiness?.s4_readiness_pct)}${bar("Cloud Ready", doc.s4_readiness?.cloud_readiness_pct)}
<div class="cards"><div class="card"><b class="hot">${cr.blockers?.findings ?? 0}</b><span>Blockers (D)</span></div><div class="card"><b>${cr.warnings?.findings ?? 0}</b><span>Warnings (C)</span></div><div class="card"><b>${cr.advisories?.findings ?? 0}</b><span>Advisories (B)</span></div><div class="card"><b>${cr.needs_review?.findings ?? 0}</b><span>Needs review</span></div></div>`;
}

function sarifTab(doc) {
  let sarif;
  try {
    sarif = JSON.stringify(toSarif(doc), null, 2);
  } catch {
    sarif = "(SARIF unavailable)";
  }
  return `<h2>SARIF 2.1.0</h2><pre class="scroll">${esc(sarif)}</pre>`;
}

const CSS = `*{box-sizing:border-box}body{font:14px/1.5 system-ui,sans-serif;margin:0;color:#0f172a;background:#f8fafc}header{padding:16px 24px;background:#fff;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}h1{font-size:18px;margin:0}h2{font-size:16px;margin:16px 0 8px}h3{font-size:13px;text-transform:uppercase;color:#64748b;margin:16px 0 6px}.chip{font-size:12px;color:#64748b}.tabs{display:flex;flex-wrap:wrap;gap:4px;padding:8px 24px;background:#fff;border-bottom:1px solid #e2e8f0;position:sticky;top:0}.tab{border:0;background:0;padding:6px 12px;cursor:pointer;border-radius:6px;font:inherit;color:#475569}.tab.on{background:#0ea5a4;color:#fff}.panel{display:none;padding:16px 24px;max-width:1100px}.panel.on{display:block}.cards{display:flex;flex-wrap:wrap;gap:10px}.card{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:12px 16px;min-width:120px}.card b{font-size:22px;display:block}.card span{font-size:12px;color:#64748b}.bar{display:flex;align-items:center;gap:10px;margin:4px 0}.bar span{width:110px;font-size:12px}.track{flex:1;height:10px;background:#e2e8f0;border-radius:6px;overflow:hidden}.track i{display:block;height:100%}.track .g{background:#16a34a}.track .a{background:#d97706}.track .r{background:#dc2626}.bar b{width:40px;text-align:right;font-size:12px}.tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}.tag{background:#f1f5f9;border:1px solid #e2e8f0;border-radius:14px;padding:2px 10px;font-size:12px}table{border-collapse:collapse;width:100%;background:#fff;font-size:13px}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid #eef2f7;vertical-align:top}.muted{color:#64748b}.small{font-size:11px}.hot{color:#dc2626}.layer{margin:10px 0}.rec{background:#fff;border:1px solid #e2e8f0;border-left:4px solid #94a3b8;border-radius:6px;padding:12px 14px;margin:8px 0}.rec.sev-priority-1,.rec.impact-H{border-left-color:#dc2626}.rec.sev-priority-2{border-left-color:#d97706}.rec.sev-priority-3,.rec.impact-M{border-left-color:#0ea5a4}.rt{font-weight:600;font-size:15px}.ri{font-size:12px;color:#b45309;margin:2px 0 6px}.act{margin:6px 0}.ex{margin:6px 0;font-size:12px;color:#334155}.pill{font-size:11px;background:#f1f5f9;border-radius:10px;padding:1px 8px;font-weight:400}.fix{color:#166534;font-size:12px}.filters{display:flex;gap:8px;margin:8px 0}.filters select{padding:4px 8px;border:1px solid #cbd5e1;border-radius:6px}.risks li,.ex li{margin:4px 0}code{background:#f1f5f9;padding:1px 5px;border-radius:4px;font-size:12px}.scroll{overflow-x:auto}pre{background:#0f172a;color:#e2e8f0;padding:12px;border-radius:8px;font-size:11px}@media(prefers-color-scheme:dark){body{background:#0f172a;color:#e2e8f0}header,.tabs,.card,table,.rec{background:#1e293b;border-color:#334155}.tag,.pill,code{background:#334155;border-color:#475569}}`;

const JS = `document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>{document.querySelectorAll('.tab,.panel').forEach(e=>e.classList.remove('on'));t.classList.add('on');document.getElementById('p-'+t.dataset.t).classList.add('on')});function filterRecs(){var f=document.getElementById('fFam').value,s=document.getElementById('fSev').value;document.querySelectorAll('#recs .rec').forEach(function(r){r.style.display=((!f||r.dataset.fam===f)&&(!s||r.dataset.sev===s))?'':'none'})}`;
