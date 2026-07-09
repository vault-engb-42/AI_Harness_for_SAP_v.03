/**
 * Shared pure helpers for the §3.E HTML report renderers (html-tabs.js) — split
 * out of html-report.js to keep every module under the 300-line limit as the tab
 * set grows. No document-derived data is trusted: esc() is the single P8 defence
 * and jsonIsland() unicode-escapes untrusted payloads embedded in inert script
 * islands. All functions are deterministic.
 */

/** HTML-entity escape — the single P8 defence for all doc-derived text. */
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const num = (v) => (typeof v === "number" ? v : 0);
export const round = (v) => (typeof v === "number" ? Math.round(v * 1000) / 1000 : 0);

/** A labelled 0-100 progress bar; colour bands green ≥80 / amber ≥50 / red below. */
export function bar(label, pct) {
  const p = Math.max(0, Math.min(100, num(pct)));
  const cls = p >= 80 ? "g" : p >= 50 ? "a" : "r";
  return `<div class="bar"><span>${esc(label)}</span><div class="track"><i class="${cls}" style="width:${p}%"></i></div><b>${p}%</b></div>`;
}

/**
 * Embed untrusted data as an inert <script type="application/json"> island (P8):
 * < > & are unicode-escaped so the payload can neither close the script tag nor be
 * parsed as HTML; the client reads it with JSON.parse + textContent, never innerHTML.
 */
export const jsonIsland = (id, data) =>
  `<script id="${id}" type="application/json">${JSON.stringify(data).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")}</script>`;

/** node id -> layer column ("entry"/"internal"/"data") from doc.layers (keyed by id). */
export function layerColumns(layers) {
  const m = new Map();
  for (const id of layers?.entry ?? []) m.set(id, "entry");
  for (const id of layers?.internal ?? []) m.set(id, "internal");
  for (const id of layers?.data ?? []) m.set(id, "data");
  return m;
}
