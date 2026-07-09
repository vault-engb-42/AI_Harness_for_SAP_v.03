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
import { canonicalizeFiles } from "./modes.js";
import { sourceHash, configHash, runId, SCHEMA_VERSION } from "./run-identity.js";
import { attachFindingIdentity, sortFindings } from "./finding-identity.js";
import { curateFindings } from "./curation.js";
import { cloudReadiness } from "./cloud-readiness.js";
import { layers, boundaries } from "./graph-dimensions.js";
import { codeHealth } from "./code-health.js";

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
  // Canonicalize at the pure-function boundary (arch spec §3.A/A1): line-ending
  // normalize + stable-sort by filename so the report is byte-identical
  // regardless of how the caller acquired or ordered the files.
  const canon = canonicalizeFiles(files);
  const admitted = applyFileByteCap(canon, notes);

  // ABAPLINT_TIMEOUT_MS is a SOFT budget: abaplint's parse() is synchronous
  // and cannot be preempted without worker isolation, so an overrun is
  // recorded in coverage_note rather than aborted. The hard runaway guards
  // are the per-file byte cap above and the graph-node cap below.
  const budget = Number(process.env.ABAPLINT_TIMEOUT_MS);
  const started = Date.now();
  const reg = loadRegistry(admitted);
  if (reg.droppedFiles?.length) {
    notes.push(`files abaplint could not parse (malformed DDIC/XML), skipped: ${reg.droppedFiles.join(", ")}`);
  }
  const maxNodes = Number(process.env.MAX_GRAPH_NODES);
  const graph = analyzeRegistry(reg, { maxNodes: Number.isFinite(maxNodes) ? maxNodes : undefined });
  const elapsed = Date.now() - started;
  if (Number.isFinite(budget) && budget > 0 && elapsed > budget) {
    // A4: no volatile timing in the note — the exact ms is run-dependent and
    // would break the determinism contract; the budget (config) is enough.
    notes.push(`parse+graph exceeded the ABAPLINT_TIMEOUT_MS soft budget of ${budget}ms`);
  }
  if (graph.truncated) {
    notes.push(`graph truncated at MAX_GRAPH_NODES=${maxNodes}; dependency coverage is partial — raise the cap or narrow the package`);
  }

  // Curate (§3.B, conv #17: source_category + family-routed grade + atc_priority
  // + atcCheckId) -> attach AST-unit identity (finding_id, conv #10/#11) -> stable
  // total-order sort (A2). Static-first: no usage-reachability drop yet.
  const findings = sortFindings(
    curateFindings(
      attachFindingIdentity(
        [...runAbaplintRules(reg), ...runRules(ALL_RULES, { graph, reg, cloud })],
        canon,
      ),
    ),
  );

  enrichNodes(graph, cloud); // mutates node records in place
  const s4_readiness = computeReadiness(graph, cloud);
  const blast_radius = collectBlastRadius(graph, cloud, opts.depth ?? 3);
  const g = graph.toGraphJSON();
  // A5: stable total-order sort of every graph emit (nodes/edges come from Maps
  // in insertion order) so the emitted graph is byte-identical regardless of
  // processing order. Runs after enrich/readiness/blast, which use `graph` (not
  // `g`), so reordering the emit does not affect any computation.
  const byJson = (a, b) => {
    const sa = JSON.stringify(a), sb = JSON.stringify(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  };
  g.nodes.sort(byJson);
  g.edges.sort(byJson);

  // Run identity (§7): source_hash over the canonical source, config_hash over
  // the pinned config, run_id = hash(both). Deterministic — same input yields
  // the same run_id in every process (the offline provenance + cache key).
  const source_hash = sourceHash(canon);
  const config_hash = configHash({ target_release: opts.target_release });
  const doc = {
    schema_version: SCHEMA_VERSION,
    source_system: opts.source_system ?? "unknown",
    package: opts.package ?? "unknown",
    generated_at: opts.generated_at ?? new Date().toISOString(),
    source_hash,
    config_hash,
    run_id: runId(source_hash, config_hash),
    findings,
    s4_readiness,
    cloud_readiness: cloudReadiness(findings),
    code_health: codeHealth(g, findings, reg),
    layers: layers(g),
    boundaries: boundaries(g),
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

// Intra-object member nodes (a class's methods, a program's forms) carry their
// owner's namespace but are not distinct repository objects — excluded so the
// customer-vs-SAP breakdown counts objects, not members.
const MEMBER_NODE_KINDS = new Set(["method", "form"]);

/**
 * @param {object[]} nodes
 * @returns {object} namespace breakdown
 */
function buildNamespaceSummary(nodes) {
  const counts = { Z: 0, Y: 0, registered: 0, sap: 0 };
  for (const n of nodes) {
    if (MEMBER_NODE_KINDS.has(n.kind)) continue;
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
