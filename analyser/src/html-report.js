import { CSS, APP_JS } from "./html-assets.js";
import { esc, num } from "./html-util.js";
import {
  summaryTab,
  recommendationsTab,
  planTab,
  codeHealthTab,
  debtTab,
  cloudTab,
  graphTab,
  boundariesTab,
  layersTab,
  findingsTab,
  sarifTab,
} from "./html-tabs.js";

/**
 * §3.E self-contained HTML report — the analyser's OWN renderer (never
 * hand-generated per run). A deterministic, pure transform of an analyser
 * findings document into a single interactive `file://` HTML page: no external
 * resource loads, all finding-derived text HTML-entity-escaped (P8 — scanned
 * ABAP is untrusted). One tab per dimension, plus an executive Summary and a
 * business-readable Recommendations tab. Renderers live in html-tabs.js; shared
 * helpers in html-util.js; CSS + client JS in html-assets.js.
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
    ["plan", "Plan", planTab(doc)],
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
<nav class="tabs">${nav}</nav>${panels}<script>${APP_JS}</script>`;
  if (opts.fragment) return inner;
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><title>Analyse — ${esc(doc.package ?? "package")}</title></head><body>${inner}</body></html>`;
}
