/**
 * Node enrichment — annotate CPG nodes with S/4 modernization metadata from the
 * oracle (via the cloudification adapter), mutating the graph's stored nodes.
 *
 * - SAP / registered nodes get clean_core_grade (their own oracle Level), plus
 *   effort_tier + modernization_target (successor) when classified.
 * - Customer (Z/Y) nodes get clean_core_grade = the WEAKEST oracle Level among
 *   their classifiable dependencies (§2 weakest-dependency cap), else unknown.
 * - clean_core_posture is DUAL-EMITTED from the grade via the §15.5 crosswalk
 *   (A->level-a, B/C->brownfield-mixed, D->classic, unknown->unknown) for
 *   back-compat, until consumers cut over to clean_core_grade.
 */
import { classifyName } from "../../oracle/src/oracle.js";

const CLASSIFIABLE_EDGE_KINDS = new Set(["call-function", "uses-table", "consumes-cds", "inherits"]);
/** Weakness rank: lower = weaker (D < C < B < A). */
const LEVEL_RANK = { D: 0, C: 1, B: 2, A: 3 };
/** §15.5 crosswalk: clean_core_grade -> clean_core_posture (the dual-emitted field). */
const GRADE_TO_POSTURE = { A: "level-a", B: "brownfield-mixed", C: "brownfield-mixed", D: "classic", unknown: "unknown" };

/**
 * @param {import("./cpg.js").DependencyGraph} graph
 * @param {object} cloud cloudification adapter (oracle-backed)
 * @returns {object[]} the enriched node list
 */
export function enrichNodes(graph, cloud) {
  const gj = graph.toGraphJSON();
  const weakestDep = weakestDepGradeByObject(gj.edges, graph);

  for (const node of gj.nodes) {
    if (node.namespace === "sap" || node.namespace === "registered") {
      enrichSapNode(node, cloud);
    } else if (node.namespace === "Z" || node.namespace === "Y") {
      setGrade(node, weakestDep.get(node.object) ?? "unknown");
    }
  }
  return gj.nodes;
}

/** Set clean_core_grade and its dual-emitted clean_core_posture (§15.5 crosswalk). */
function setGrade(node, grade) {
  node.clean_core_grade = grade;
  node.clean_core_posture = GRADE_TO_POSTURE[grade];
}

/**
 * @param {object} node
 * @param {object} cloud
 */
function enrichSapNode(node, cloud) {
  const grade = classifyName(node.id).level;
  setGrade(node, grade);
  if (grade === "unknown") return;
  node.effort_tier = cloud.effortTier(node.id);
  const successor = cloud.getSuccessor(node.id);
  if (successor) node.modernization_target = successor;
}

/**
 * Weakest oracle Level among each object's classifiable, non-released (B/C/D)
 * dependencies (§2 weakest-dependency cap). Released/unknown targets are excluded
 * — level-a cannot be asserted from dependencies alone.
 * @param {object[]} edges
 * @param {import("./cpg.js").DependencyGraph} graph
 * @returns {Map<string, string>} owning object -> weakest dep Level (B/C/D)
 */
function weakestDepGradeByObject(edges, graph) {
  const m = new Map();
  for (const e of edges) {
    if (!CLASSIFIABLE_EDGE_KINDS.has(e.kind)) continue;
    const lvl = classifyName(e.target).level;
    if (lvl === "A" || lvl === "unknown") continue;
    const owner = graph.getNode(e.source)?.object ?? e.source;
    const cur = m.get(owner);
    if (cur === undefined || LEVEL_RANK[lvl] < LEVEL_RANK[cur]) m.set(owner, lvl);
  }
  return m;
}
