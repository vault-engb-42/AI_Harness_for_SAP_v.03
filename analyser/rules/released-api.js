/**
 * released-api rule (ported TALOS family; P2 grounding).
 *
 * For every dependency edge whose target is an object-name we can classify
 * (call-function / uses-table / consumes-cds / inherits), look the target up
 * in the bundled Cloudification Registry. A target that is NOT released is a
 * Clean-Core problem for the customer object that uses it:
 *   - removed (noAPI/deleted) -> priority-1 (no successor path; must retire usage)
 *   - deprecated (incl. notToBeReleased/classicAPI) -> priority-2 (migrate to successor)
 * `unknown` targets (not in the registry — typically customer code) are never
 * flagged: absence of classification is not evidence of a problem.
 */

/** Edge kinds whose `target` is an object name the registry can classify. */
const CLASSIFIABLE_EDGE_KINDS = new Set([
  "call-function",
  "uses-table",
  "consumes-cds",
  "inherits",
]);

export const releasedApiRule = {
  id: "released-api",
  family: "released-api",
  verdict: "HARD",
  /**
   * @param {import("../src/rule-engine.js").AnalysisContext} ctx
   * @returns {object[]}
   */
  check(ctx) {
    const findings = [];
    const seen = new Set();
    for (const edge of ctx.graph.toGraphJSON().edges) {
      if (!CLASSIFIABLE_EDGE_KINDS.has(edge.kind)) continue;
      const c = ctx.cloud.classify(edge.target);
      if (c.release_state === "released" || c.release_state === "unknown") continue;

      const key = `${edge.source}->${edge.target}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const successor = c.successors[0]?.name;
      findings.push({
        severity: c.release_state === "removed" ? "priority-1" : "priority-2",
        object: edge.source,
        // the referenced SAP object — curation grades this via the oracle (conv #17)
        referenced_object: edge.target,
        message:
          `uses non-released API ${edge.target} (${c.raw_state})` +
          (successor ? `; released successor ${successor}` : "; no released successor"),
        suggestion: successor ? `replace ${edge.target} with ${successor}` : undefined,
        family: "released-api",
      });
    }
    return findings;
  },
};
