/**
 * S/4HANA readiness summary — aggregates cloudification classification over the
 * CPG's outbound API dependencies into the schema's `s4_readiness` block.
 *
 * Counts each classifiable dependency edge (call-function / uses-table /
 * consumes-cds / inherits) whose target the registry can classify. `unknown`
 * targets (customer code, not SAP APIs) are excluded from the denominator so
 * readiness reflects SAP-API usage only.
 */

const CLASSIFIABLE_EDGE_KINDS = new Set([
  "call-function",
  "uses-table",
  "consumes-cds",
  "inherits",
]);

/**
 * @param {import("./cpg.js").DependencyGraph} graph
 * @param {{classify: (name: string) => {release_state: string}}} cloud
 * @returns {{s4_readiness_pct: number, cloud_readiness_pct: number, released_hits: number, deprecated_hits: number, not_released_hits: number, total_api_calls: number}}
 */
export function computeReadiness(graph, cloud) {
  let released = 0;
  let deprecated = 0;
  let removed = 0;

  for (const edge of graph.toGraphJSON().edges) {
    if (!CLASSIFIABLE_EDGE_KINDS.has(edge.kind)) continue;
    const state = cloud.classify(edge.target).release_state;
    if (state === "released") released++;
    else if (state === "deprecated") deprecated++;
    else if (state === "removed") removed++;
    // unknown -> excluded (customer / unclassified)
  }

  const total = released + deprecated + removed;
  const pct = total > 0 ? Math.round((released / total) * 100) : 100;
  return {
    s4_readiness_pct: pct,
    cloud_readiness_pct: pct,
    released_hits: released,
    deprecated_hits: deprecated,
    not_released_hits: removed,
    total_api_calls: total,
  };
}
