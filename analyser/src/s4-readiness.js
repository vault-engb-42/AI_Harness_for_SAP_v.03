/**
 * S/4HANA + Cloud readiness summary — aggregates the oracle clean-core Level over
 * the CPG's outbound API dependencies into the schema's `s4_readiness` block.
 *
 * Each classifiable dependency edge (call-function / uses-table / consumes-cds /
 * inherits) is classified by oracle Level (§3.F weakest-wins). `unknown` targets
 * (customer code, not SAP APIs) are excluded from the denominator so readiness
 * reflects SAP-API usage only.
 *
 * S/4 and Cloud readiness are DISTINCT (they must not collapse to one number):
 * cloud-ready = released (A) only; S/4-ready = released + classicAPI (A + B),
 * since a classicAPI runs on S/4 on-prem but is NOT cloud-released. deprecated (C)
 * and removed/notToBeReleased (D) are the S/4 migration concerns. Empty-package
 * sentinels also differ: nothing to migrate is trivially S/4-ready (100%), but
 * nothing is cloud-released (0%).
 */

const CLASSIFIABLE_EDGE_KINDS = new Set([
  "call-function",
  "uses-table",
  "consumes-cds",
  "inherits",
]);

/**
 * @param {import("./cpg.js").DependencyGraph} graph
 * @param {{level: (name: string) => string}} cloud oracle-Level classifier
 * @returns {{s4_readiness_pct: number, cloud_readiness_pct: number, released_hits: number, classic_api_hits: number, deprecated_hits: number, not_released_hits: number, total_api_calls: number}}
 */
export function computeReadiness(graph, cloud) {
  let a = 0; // A: released
  let b = 0; // B: classicAPI (runs on S/4, not cloud-released)
  let c = 0; // C: deprecated
  let d = 0; // D: removed / notToBeReleased

  for (const edge of graph.toGraphJSON().edges) {
    if (!CLASSIFIABLE_EDGE_KINDS.has(edge.kind)) continue;
    const lvl = cloud.level(edge.target);
    if (lvl === "A") a++;
    else if (lvl === "B") b++;
    else if (lvl === "C") c++;
    else if (lvl === "D") d++;
    // unknown -> excluded (customer / unclassified)
  }

  const total = a + b + c + d;
  return {
    s4_readiness_pct: total > 0 ? Math.round(((a + b) / total) * 100) : 100,
    cloud_readiness_pct: total > 0 ? Math.round((a / total) * 100) : 0,
    released_hits: a,
    classic_api_hits: b,
    deprecated_hits: c,
    not_released_hits: d,
    total_api_calls: total,
  };
}
