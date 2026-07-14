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
  return `<h2>analyse output for ${esc(doc.package ?? "package")}</h2><div class="cards">${cards}</div>
${codebaseSection(doc.metrics)}
${readinessSection(doc.s4_readiness)}
${legacyDebtSection(doc.debt)}
<h3>Code health (${esc(ch.clean_core_grade ?? "?")})</h3>${bar("Clarity", ch.clarity)}${bar("Stability", ch.stability)}${bar("Performance", ch.performance)}${bar("Compound", ch.compound)}
<h3>Top risks</h3><ol class="risks">${top || "<li>none</li>"}</ol>`;
}

/** S/4HANA + Cloud readiness — object-level, with the blocker context that drives it. */
function readinessSection(s4) {
  if (!s4) return "";
  const t = num(s4.total_objects);
  return `<h3>S/4HANA &amp; ABAP Cloud readiness</h3>${bar("S/4HANA-ready", s4.s4_readiness_pct)}${bar("ABAP Cloud-ready", s4.cloud_readiness_pct)}
<p class="muted small">Share of ${t} customer objects with no blocker. <b class="${num(s4.cloud_blocked_objects) ? "hot" : ""}">${num(s4.cloud_blocked_objects)}/${t}</b> have a Cloud blocker (${num(s4.cloud_blocker_findings)} findings), <b class="${num(s4.s4_blocked_objects) ? "hot" : ""}">${num(s4.s4_blocked_objects)}/${t}</b> an S/4 blocker (${num(s4.s4_blocker_findings)}). Cloud is stricter — classic patterns (CALL FUNCTION, ALV, kernel calls) run on S/4 on-prem but block ABAP Cloud. Dependency hygiene: ${num(s4.released_hits)} released · ${num(s4.classic_api_hits)} classic-API · ${num(s4.deprecated_hits)} deprecated · ${num(s4.not_released_hits)} removed of ${num(s4.total_api_calls)} classifiable SAP deps.</p>`;
}

/** Legacy debt — the tech-debt composite as a headline (higher score = more debt). */
function legacyDebtSection(debt) {
  if (!debt) return "";
  const avg = Math.round(num(debt.avg_score) * 100);
  const max = Math.round(num(debt.max_score) * 100);
  const cards = [
    card("Avg debt", avg + "%", avg >= 50),
    card("Worst object", max + "%", max >= 50),
    card("Hotspots", num(debt.hotspot_count), num(debt.hotspot_count) > 0),
  ].join("");
  return `<h3>Legacy debt <span class="muted">(size · complexity · coupling · duplication · cohesion)</span></h3><div class="cards">${cards}</div>
<p class="muted small">Per-object 0–100% debt composite; a hotspot is an object over 50%. Full breakdown in the Tech Debt tab.</p>`;
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
${clarityBreakdown(ch.clarity_breakdown, ch.clarity_coverage)}
<h3>By object <span class="muted">(worst first)</span></h3>${perObjectHealthTable(ch.by_object)}`;
}

// An axis measured from too few objects is not a trustworthy score — a package with one
// class reports "cohesion" from that one class. Below the floor we render N/A instead of a
// misleading percentage (the vacuous-100 trap). Floor: fewer than 3 objects, or under 20%
// of the clarity population.
const LOW_CONFIDENCE = (n, total) => n < 3 || (total > 0 && n / total < 0.2);

/** The four clarity sub-axes as bars WITH coverage, so the clarity number is explainable. */
function clarityBreakdown(b, cov = {}) {
  if (!b) return "";
  const total = cov.objects ?? 0;
  const KEY = { Cyclomatic: "cyclomatic", "Routine length": "length", Nesting: "nesting", "Cohesion (LCOM*)": "lcom" };
  const rows = [["Cyclomatic", b.cyclomatic], ["Routine length", b.length], ["Nesting", b.nesting], ["Cohesion (LCOM*)", b.lcom]]
    .map(([label, v]) => {
      const n = cov[KEY[label]];
      if (n === undefined) return v == null ? "" : bar(label, v); // no coverage data (legacy doc): fall back
      if (n === 0) return "";
      // denominator is the clarity population (code objects); LCOM* covers only the
      // classes among them, which the h3 note explains.
      const meta = `<span class="muted small">measured from ${n} of ${total} objects</span>`;
      if (LOW_CONFIDENCE(n, total)) {
        return `<div class="axis-na"><b>${esc(label)}</b> — <span class="pill">N/A</span> measured from only ${n} of ${total} objects — insufficient sample</div>`;
      }
      return `${bar(label, v)}${meta}`;
    }).join("");
  return `<h3>Clarity breakdown <span class="muted">(lower axis = the readability fault; LCOM* is defined for classes only)</span></h3>${rows}`;
}

/** Per-object health drill-down — which objects, and why, drag the package scores down. */
function perObjectHealthTable(byObject) {
  const rows = (byObject ?? []).map((o) => {
    const lcom = o.lcom == null ? "—" : round(o.lcom);
    return `<tr><td>${esc(o.object)}</td><td class="muted small">${esc(o.kind)}</td><td class="${num(o.cyclomatic) > 20 ? "hot" : ""}">${num(o.cyclomatic)}</td><td class="${num(o.max_routine_loc) > 150 ? "hot" : ""}">${num(o.max_routine_loc)}</td><td class="${num(o.nesting) > 5 ? "hot" : ""}">${num(o.nesting)}</td><td>${lcom}</td><td class="${num(o.perf_findings) ? "hot" : ""}">${num(o.perf_findings)}</td><td><span class="pill">${esc(o.grade)}</span></td><td><b class="${num(o.penalty) >= 0.5 ? "hot" : ""}">${round(o.penalty)}</b></td></tr>`;
  }).join("");
  return `<table><thead><tr><th>Object</th><th>Kind</th><th>Max cyclomatic</th><th>Longest routine (LOC)</th><th>Nesting</th><th>LCOM*</th><th>Perf</th><th>Grade</th><th>Clarity penalty</th></tr></thead><tbody>${rows || "<tr><td colspan=9><i>no objects</i></td></tr>"}</tbody></table>`;
}
