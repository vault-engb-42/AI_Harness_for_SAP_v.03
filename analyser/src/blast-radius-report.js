import { blastRadius } from "./blast-radius.js";

/**
 * Blast-radius report — for every deprecated/removed SAP object the scanned
 * package depends on, compute how many objects would be affected if it is
 * migrated. Produces the schema's `blast_radius` array, sorted most-impactful
 * first.
 */

const CLASSIFIABLE_EDGE_KINDS = new Set([
  "call-function",
  "uses-table",
  "consumes-cds",
  "inherits",
]);

/**
 * @param {import("./cpg.js").DependencyGraph} graph
 * @param {object} cloud cloudification adapter
 * @param {number} [maxDepth=3]
 * @returns {object[]} schema blast_radius entries
 */
export function collectBlastRadius(graph, cloud, maxDepth = 3) {
  const atRisk = new Map(); // target -> classification
  for (const edge of graph.toGraphJSON().edges) {
    if (!CLASSIFIABLE_EDGE_KINDS.has(edge.kind)) continue;
    const c = cloud.classify(edge.target);
    if (c.release_state === "deprecated" || c.release_state === "removed") {
      atRisk.set(edge.target, c);
    }
  }

  const entries = [];
  for (const [target, c] of atRisk) {
    const br = blastRadius(graph, target, maxDepth);
    entries.push({
      object: target,
      affected_program_count: br.affected_program_count,
      successor_kind: c.successors[0] ?? "none",
      highest_impact: br.highest_impact,
    });
  }
  return entries.sort((a, b) => b.affected_program_count - a.affected_program_count);
}
