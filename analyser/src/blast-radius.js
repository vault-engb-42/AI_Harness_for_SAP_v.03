/**
 * Blast-radius analysis: given a CPG and a target object, find which objects
 * are affected if the target changes. Dependencies point dependent -> dependency
 * (A calls B => edge A->B), so "affected by a change to T" = the transitive
 * PREDECESSORS of T's nodes, aggregated to their owning objects.
 *
 * Depth-limited BFS (default 3) with a visited set, so cycles terminate and
 * far-reaching graphs don't explode.
 */

/**
 * @param {import("./cpg.js").DependencyGraph} graph
 * @param {string} targetObject object id whose change is being assessed
 * @param {number} [maxDepth=3] hops of dependents to include
 * @returns {{object: string, affected_program_count: number, highest_impact: string, affected_objects: string[]}}
 */
export function blastRadius(graph, targetObject, maxDepth = 3) {
  const seed = seedNodes(graph, targetObject);
  const visited = new Set(seed);
  let frontier = [...seed];

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next = [];
    for (const id of frontier) {
      for (const pred of graph.predecessors(id)) {
        if (!visited.has(pred)) {
          visited.add(pred);
          next.push(pred);
        }
      }
    }
    frontier = next;
  }

  const affected = new Set();
  for (const id of visited) {
    const owner = graph.getNode(id)?.object ?? id;
    if (owner !== targetObject) affected.add(owner);
  }
  const affected_objects = [...affected].sort();
  return {
    object: targetObject,
    affected_program_count: affected_objects.length,
    highest_impact: impactTier(affected_objects.length),
    affected_objects,
  };
}

/**
 * Seed = every node belonging to the target object (the object node plus its
 * methods). Falls back to the id itself when the object is not in the graph.
 * @param {import("./cpg.js").DependencyGraph} graph
 * @param {string} targetObject
 * @returns {string[]}
 */
function seedNodes(graph, targetObject) {
  const seed = graph.toGraphJSON().nodes
    .filter((n) => n.object === targetObject)
    .map((n) => n.id);
  return seed.length > 0 ? seed : [targetObject];
}

/**
 * Count-based impact tiering (schema highest_impact enum). Thresholds are
 * deliberately coarse; refine against corpus calibration if needed.
 * @param {number} count
 * @returns {"low"|"medium"|"high"|"critical"}
 */
function impactTier(count) {
  if (count >= 50) return "critical";
  if (count >= 20) return "high";
  if (count >= 5) return "medium";
  return "low";
}
