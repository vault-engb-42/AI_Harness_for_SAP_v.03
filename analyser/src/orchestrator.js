import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { validateFindings } from "./validate-findings.js";
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
  const notes = opts.coverage_note ? [opts.coverage_note] : [];
  const admitted = applyFileByteCap(files, notes);

  // ABAPLINT_TIMEOUT_MS is a SOFT budget: abaplint's parse() is synchronous
  // and cannot be preempted without worker isolation, so an overrun is
  // recorded in coverage_note rather than aborted. The hard runaway guards
  // are the per-file byte cap above and the graph-node cap below.
  const budget = Number(process.env.ABAPLINT_TIMEOUT_MS);
  const started = Date.now();
  const reg = loadRegistry(admitted);
  const maxNodes = Number(process.env.MAX_GRAPH_NODES);
  const graph = analyzeRegistry(reg, { maxNodes: Number.isFinite(maxNodes) ? maxNodes : undefined });
  const elapsed = Date.now() - started;
  if (Number.isFinite(budget) && budget > 0 && elapsed > budget) {
    notes.push(`parse+graph took ${elapsed}ms, exceeding the ABAPLINT_TIMEOUT_MS soft budget of ${budget}ms`);
  }
  if (graph.truncated) {
    notes.push(`graph truncated at MAX_GRAPH_NODES=${maxNodes}; dependency coverage is partial — raise the cap or narrow the package`);
  }

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
  if (notes.length) doc.coverage_note = notes.join(" | ");
  return doc;
}

/**
 * Skip files above ANALYSER_MAX_FILE_BYTES (default 2 MB), naming each skip
 * in the coverage notes — a runaway input degrades loudly, never silently.
 * @param {Array<{filename: string, source: string}>} files
 * @param {string[]} notes
 * @returns {Array<{filename: string, source: string}>}
 */
function applyFileByteCap(files, notes) {
  const cap = Number(process.env.ANALYSER_MAX_FILE_BYTES) || 2_000_000;
  const admitted = [];
  const skipped = [];
  for (const f of files) {
    if (Buffer.byteLength(f.source, "utf8") > cap) skipped.push(f.filename);
    else admitted.push(f);
  }
  if (skipped.length) {
    notes.push(`files skipped over ANALYSER_MAX_FILE_BYTES=${cap}: ${skipped.join(", ")}`);
  }
  return admitted;
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
 * Fail-closed: the document is schema-validated first (arch doc §10.3) so a
 * malformed report can never reach the track consumers' file.
 * @param {object} doc
 * @param {string} outPath
 * @returns {string} the path written
 */
export function writeReport(doc, outPath) {
  const { valid, errors } = validateFindings(doc);
  if (!valid) {
    throw new Error(`refusing to write a schema-invalid findings document: ${errors.slice(0, 5).join("; ")}`);
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(doc, null, 2), "utf8");
  return outPath;
}
