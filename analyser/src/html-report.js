import { createHash } from "node:crypto";
import { CSS, APP_JS } from "./html-assets.js";
import { esc, num } from "./html-util.js";
import { summaryTab, recommendationsTab, planTab, codeHealthTab } from "./html-tabs.js";
import { debtTab, cloudTab, boundariesTab, layersTab, findingsTab, sarifTab } from "./html-tabs-detail.js";
import { graphTab } from "./html-graph.js";

/**
 * §3.E self-contained HTML report — the analyser's OWN renderer (never
 * hand-generated per run). A deterministic, pure transform of an analyser
 * findings document into a single interactive `file://` HTML page: no external
 * resource loads, all finding-derived text HTML-entity-escaped (P8 — scanned
 * ABAP is untrusted). One tab per dimension, plus an executive Summary and a
 * business-readable Recommendations tab. Renderers live in html-tabs.js; shared
 * helpers in html-util.js; CSS + client JS in html-assets.js.
 *
 * Always a FULL standalone document: the former `opts.fragment` mode was removed (review
 * L2, operator-ratified 2026-07-14) — it had no consumer, no test, and silently handed the
 * script-hash CSP obligation to a host with no helper to compute it. Reintroduce it only
 * together with a real embedding host, a test, and an exported hash helper.
 *
 * @param {object} doc analyser-findings document
 * @returns {string} HTML
 */
export function renderHtml(doc) {
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
  // Hash-based CSP: the single inline <script> is allow-listed by the SHA-256 of its
  // exact bytes (deterministic — APP_JS is a constant), so 'unsafe-inline' is dropped
  // from script-src, closing the XSS vector while the self-contained file keeps working.
  // style-src RETAINS 'unsafe-inline': bar() emits dynamic style="width:N%" that cannot
  // be hashed; inline styles execute no script and default-src 'none' blocks exfiltration.
  const scriptHash = createHash("sha256").update(APP_JS).digest("base64");
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${scriptHash}'"><title>Analyse — ${esc(doc.package ?? "package")}</title></head><body>${inner}</body></html>`;
}
