import { esc, num, round, bar } from "./html-util.js";

/**
 * §3.E HTML report — the overview / planning tab renderers (summary,
 * recommendations, modernization plan, code health). Detail/data-heavy tabs live
 * in html-tabs-detail.js. Deterministic, pure, all doc text P8-escaped.
 */

// ── Business recommendations: findings -> plain-language themes ──────────────
const THEME = {
  "released-api": { t: "Uses SAP objects not released for ABAP Cloud", why: "Your code depends on SAP APIs/tables that are not released for ABAP Cloud — some are deprecated or removed in S/4HANA, others are classic APIs that still run on S/4 on-prem but block the move to ABAP Cloud.", act: "Switch each to its released successor (released API / CDS view / RAP).", impact: "High — blocks ABAP Cloud (deprecated/removed also block S/4)" },
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
export function planTab(doc) {
  const p = doc.modernization_plan ?? { objects: [], summary: {} };
  const s = p.summary ?? {};
  const eff = s.by_effort ?? {};
  const pri = s.by_priority ?? {};
  const cards = [
    ["Objects", s.total_objects ?? 0, false], ["Waves", s.wave_count ?? 0, false],
    ["XL effort", eff.XL ?? 0, true], ["L", eff.L ?? 0, false], ["M", eff.M ?? 0, false], ["S", eff.S ?? 0, false],
    ["P1 priority", pri.P1 ?? 0, true], ["P2", pri.P2 ?? 0, false], ["P3", pri.P3 ?? 0, false],
  ].map(([l, v, hot]) => card(l, v, hot)).join("");
  const byWave = new Map();
  for (const o of p.objects ?? []) {
    if (!byWave.has(o.wave ?? 0)) byWave.set(o.wave ?? 0, []);
    byWave.get(o.wave ?? 0).push(o);
  }
  const waves = [...byWave.keys()].sort((a, b) => a - b)
    .map((w) => `<h3>Wave ${w} <span class="muted">— ${w === 0 ? "no dependencies, build first" : "depends on earlier waves"} (${byWave.get(w).length})</span></h3>${byWave.get(w).map(planObject).join("")}`)
    .join("");
  return `<h2>Modernization Plan <span class="muted">(${s.total_objects ?? 0} customer objects · ${s.wave_count ?? 0} waves · transport-ordered)</span></h2>
<p class="muted">Per customer object: target artifact, effort (debt + size), priority (importance), migration complexity (0–5), and its modernization steps. Grouped into dependency waves — build wave 0 first; within a wave, transport-safe order (CDS → interfaces → classes → behaviour → the rest). Click an object for its steps.</p>
<div class="cards">${cards}</div>
${waves || "<i>no customer objects to modernize</i>"}`;
}

/** One plan object as an expandable row: summary line + dependencies + transformation steps. */
function planObject(o) {
  const deps = (o.dependencies ?? []).length
    ? `<div class="muted small">Depends on: ${o.dependencies.map((d) => `<span class="tag">${esc(d)}</span>`).join("")}</div>`
    : `<div class="muted small">No customer dependencies.</div>`;
  const steps = (o.transformations ?? []).map((t) => `<tr><td class="muted small">${esc(t.kind)}</td><td>${esc(t.why ?? "")}</td><td class="fix">${esc(t.released_successor ?? t.fix ?? "")}</td></tr>`).join("");
  const stepsTable = (o.transformations ?? []).length
    ? `<table><thead><tr><th>Kind</th><th>Why</th><th>Fix / successor</th></tr></thead><tbody>${steps}</tbody></table>`
    : `<p class="muted small">No modernization steps flagged — review for target-model fit.</p>`;
  return `<details class="planobj"><summary><b>${esc(o.object)}</b> <span class="muted small">${esc(o.kind)}</span> → ${esc(o.modernization_target)} · <span class="pill">${esc(o.effort_tier)}</span> · <span class="pill">${esc(o.priority_rank)}</span> · cx ${num(o.migration_complexity)}/5 · ${num(o.transformation_count)} steps</summary><div class="pbody">${deps}${stepsTable}</div></details>`;
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
