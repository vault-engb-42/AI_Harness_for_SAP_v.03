/**
 * Node enrichment — annotate CPG nodes with S/4 modernization metadata from
 * the cloudification registry, mutating the graph's stored nodes in place.
 *
 * - SAP / registered nodes that the registry classifies get effort_tier,
 *   modernization_target (successor), and clean_core_posture
 *   (level-a if released, else classic).
 * - Customer (Z/Y) object nodes get clean_core_posture: brownfield-mixed if the
 *   object has any non-released API dependency, else unknown (level-a cannot be
 *   asserted from dependencies alone).
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
 * @returns {object[]} the enriched node list
 */
export function enrichNodes(graph, cloud) {
  const gj = graph.toGraphJSON();
  const customerObjectsWithBadDeps = findObjectsWithNonReleasedDeps(gj.edges, graph, cloud);

  for (const node of gj.nodes) {
    if (node.namespace === "sap" || node.namespace === "registered") {
      enrichSapNode(node, cloud);
    } else if (node.namespace === "Z" || node.namespace === "Y") {
      node.clean_core_posture = customerObjectsWithBadDeps.has(node.object)
        ? "brownfield-mixed"
        : "unknown";
    }
  }
  return gj.nodes;
}

/**
 * @param {object} node
 * @param {object} cloud
 */
function enrichSapNode(node, cloud) {
  const c = cloud.classify(node.id);
  if (c.release_state === "unknown") return;
  node.effort_tier = cloud.effortTier(node.id);
  const successor = cloud.getSuccessor(node.id);
  if (successor) node.modernization_target = successor;
  node.clean_core_posture = c.release_state === "released" ? "level-a" : "classic";
}

/**
 * @param {object[]} edges
 * @param {import("./cpg.js").DependencyGraph} graph
 * @param {object} cloud
 * @returns {Set<string>} owning-object names that depend on a non-released API
 */
function findObjectsWithNonReleasedDeps(edges, graph, cloud) {
  const bad = new Set();
  for (const e of edges) {
    if (!CLASSIFIABLE_EDGE_KINDS.has(e.kind)) continue;
    const state = cloud.classify(e.target).release_state;
    if (state === "deprecated" || state === "removed") {
      bad.add(graph.getNode(e.source)?.object ?? e.source);
    }
  }
  return bad;
}
