import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadRegistry } from "./abaplint-loader.js";
import { analyzeRegistry } from "./semantic.js";
import { runAbaplintRules } from "./abaplint-rules.js";
import { runRules } from "./rule-engine.js";
import { ALL_RULES } from "../rules/index.js";
import * as cloud from "./cloudification.js";
import { enrichNodes } from "./enrich.js";
import { computeReadiness } from "./s4-readiness.js";
import { collectBlastRadius } from "./blast-radius-report.js";

/**
 * Top-level analyser orchestration: parse -> CPG -> rules (abaplint + harness)
 * -> node enrichment -> readiness + blast-radius -> assemble the
 * analyser-findings document. The rule set (abaplint's 185 + ALL_RULES) is
 * whatever is registered; ported TALOS rules flow through automatically.
 *
 * @param {Array<{filename: string, source: string}>} files
 * @param {{source_system?: string, package?: string, generated_at?: string, coverage_note?: string, depth?: number}} [opts]
 * @returns {object} analyser-findings document
 */
export function analyzePackage(files, opts = {}) {
  const reg = loadRegistry(files);
  const graph = analyzeRegistry(reg);

  const findings = [
    ...runAbaplintRules(reg),
    ...runRules(ALL_RULES, { graph, reg, cloud }),
  ];

  enrichNodes(graph, cloud); // mutates node records in place
  const s4_readiness = computeReadiness(graph, cloud);
  const blast_radius = collectBlastRadius(graph, cloud, opts.depth ?? 3);
  const g = graph.toGraphJSON();

  const doc = {
    source_system: opts.source_system ?? "unknown",
    package: opts.package ?? "unknown",
    generated_at: opts.generated_at ?? new Date().toISOString(),
    findings,
    s4_readiness,
    graph: g,
    blast_radius,
    namespace_summary: buildNamespaceSummary(g.nodes),
  };
  if (opts.coverage_note) doc.coverage_note = opts.coverage_note;
  return doc;
}

/**
 * @param {object[]} nodes
 * @returns {object} namespace breakdown
 */
function buildNamespaceSummary(nodes) {
  const counts = { Z: 0, Y: 0, registered: 0, sap: 0 };
  for (const n of nodes) {
    if (counts[n.namespace] !== undefined) counts[n.namespace]++;
  }
  return {
    ...counts,
    customer_total: counts.Z + counts.Y,
    sap_total: counts.sap,
  };
}

/**
 * Write a findings document to disk as pretty JSON (creates parent dirs).
 * @param {object} doc
 * @param {string} outPath
 * @returns {string} the path written
 */
export function writeReport(doc, outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(doc, null, 2), "utf8");
  return outPath;
}
