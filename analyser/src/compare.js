/**
 * Before/after comparison (`analyser compare <before.json> <after.json>`). Two analyser
 * findings docs → a delta report that is HONEST about measurement scope: a clarity axis
 * whose measured population changed (e.g. cohesion going from 1 measured object to 10, when
 * a procedural package is modernised into classes) carries a SCOPE-SHIFT note, so the reader
 * never mistakes "unmeasured → measured" for "good → bad". Pure delta + a self-contained
 * HTML renderer that reuses the analyser's own CSS.
 */
import { CSS } from "./html-assets.js";
import { esc, num } from "./html-util.js";

const GRADE_RANK = { A: 4, B: 3, C: 2, D: 1, unknown: 0 };
const countSeverity = (doc, sev) => (doc.findings ?? []).filter((f) => f.severity === sev).length;

// An axis measured from too few objects is not a trustworthy score (mirrors the report's
// clarity floor): fewer than 3 objects, or under 20% of the clarity population.
const isNa = (n, total) => n == null || n < 3 || (total > 0 && n / total < 0.2);

/**
 * @param {object} before analyser-findings doc
 * @param {object} after analyser-findings doc
 * @returns {{labels: object, readiness: object[], quality: object[], health: object[], clarity_axes: object[], notes: string[]}}
 */
export function compareReports(before, after) {
  const bs = before.s4_readiness ?? {};
  const as = after.s4_readiness ?? {};
  const bh = before.code_health ?? {};
  const ah = after.code_health ?? {};

  const pct = (label, b, a) => ({ label, before: num(b), after: num(a), delta: num(a) - num(b), unit: "%", improved: num(a) >= num(b) });
  const readiness = [
    pct("S/4HANA-ready", bs.s4_readiness_pct, as.s4_readiness_pct),
    pct("ABAP Cloud-ready", bs.cloud_readiness_pct, as.cloud_readiness_pct),
  ];

  const lowerBetter = (label, b, a) => ({ label, before: num(b), after: num(a), delta: num(a) - num(b), improved: num(a) <= num(b) });
  const quality = [
    { label: "Clean-Core grade", before: bh.clean_core_grade ?? "?", after: ah.clean_core_grade ?? "?", kind: "grade",
      improved: (GRADE_RANK[ah.clean_core_grade] ?? 0) >= (GRADE_RANK[bh.clean_core_grade] ?? 0) },
    lowerBetter("Priority-1 findings", countSeverity(before, "priority-1"), countSeverity(after, "priority-1")),
    lowerBetter("S/4 blocker findings", bs.s4_blocker_findings, as.s4_blocker_findings),
    lowerBetter("Cloud blocker findings", bs.cloud_blocker_findings, as.cloud_blocker_findings),
    lowerBetter("Total findings", (before.findings ?? []).length, (after.findings ?? []).length),
  ];

  const health = ["clarity", "stability", "performance", "compound"].map((k) =>
    pct(k[0].toUpperCase() + k.slice(1), bh[k], ah[k]),
  );

  const bcov = bh.clarity_coverage ?? {};
  const acov = ah.clarity_coverage ?? {};
  const bbd = bh.clarity_breakdown ?? {};
  const abd = ah.clarity_breakdown ?? {};
  const AX = [["Cyclomatic", "cyclomatic"], ["Routine length", "length"], ["Nesting", "nesting"], ["Cohesion (LCOM*)", "lcom"]];
  const side = (v, n, total) => ({ value: num(v), n: num(n), total: num(total), na: isNa(n, total) });
  const clarity_axes = AX.map(([label, key]) => ({
    label,
    before: side(bbd[key], bcov[key], bcov.objects),
    after: side(abd[key], acov[key], acov.objects),
  }));

  const notes = [];
  for (const ax of clarity_axes) {
    if (ax.before.na && !ax.after.na) {
      notes.push(`${ax.label}: measured population grew from ${ax.before.n} to ${ax.after.n} objects — the before score was not statistically meaningful (treat as unmeasured), so the ${ax.after.value}% after is the first real reading, not a decline.`);
    } else if (!ax.before.na && ax.after.na) {
      notes.push(`${ax.label}: measured population shrank from ${ax.before.n} to ${ax.after.n} objects — the after score is no longer statistically meaningful.`);
    }
  }

  return { labels: { before: before.package ?? "before", after: after.package ?? "after" }, readiness, quality, health, clarity_axes, notes };
}

/** Self-contained before/after HTML, reusing the analyser's CSS. Pure. */
export function renderCompareHtml(d) {
  const arrow = (delta, improved) => `<span class="pill" style="background:${improved ? "#dcfce7" : "#fee2e2"};color:${improved ? "#166534" : "#991b1b"}">${delta > 0 ? "+" : ""}${delta}</span>`;
  const cell = (r) => `<tr><td>${esc(r.label)}</td><td class="mono">${esc(String(r.before))}</td><td class="mono">${esc(String(r.after))}</td><td>${r.kind === "grade" ? `<span class="pill">${r.improved ? "↑" : "↓"}</span>` : arrow(r.delta, r.improved)}</td></tr>`;
  const section = (title, rows) => `<h2>${esc(title)}</h2><table><thead><tr><th>Metric</th><th>Before</th><th>After</th><th>Δ</th></tr></thead><tbody>${rows.map(cell).join("")}</tbody></table>`;
  const axisRow = (a) => {
    const fmt = (s) => (s.na ? `<span class="pill">N/A</span> <span class="muted small">${s.n}/${s.total} obj</span>` : `${s.value}% <span class="muted small">${s.n}/${s.total} obj</span>`);
    return `<tr><td>${esc(a.label)}</td><td>${fmt(a.before)}</td><td>${fmt(a.after)}</td></tr>`;
  };
  const notes = d.notes.length ? `<div class="rec sev-priority-3"><b>How to read the shifts</b><ul>${d.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></div>` : "";
  const inner = `<style>${CSS}.mono{font-variant-numeric:tabular-nums;text-align:right}</style>
<header><h1>before → after · ${esc(d.labels.before)} → ${esc(d.labels.after)}</h1><span class="chip">analyser comparison</span></header>
<div class="panel on">
${section("Readiness", d.readiness)}
${section("Quality", d.quality)}
${section("Code health", d.health)}
<h2>Clarity breakdown <span class="muted small">(LCOM* is classes-only)</span></h2><table><thead><tr><th>Axis</th><th>Before</th><th>After</th></tr></thead><tbody>${d.clarity_axes.map(axisRow).join("")}</tbody></table>
${notes}
</div>`;
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>before → after · ${esc(d.labels.before)}</title></head><body>${inner}</body></html>`;
}
