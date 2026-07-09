/**
 * S/4HANA + Cloud readiness — measured at the OBJECT level over ALL the analyser's
 * checks, not just registry-classifiable API dependencies. An object is "ready" for
 * a target when it carries NO blocking finding for that target; readiness_pct = the
 * share of customer objects that are ready. This is the honest basis: the real
 * blockers are code PATTERNS (CALL FUNCTION, kernel calls, classic ALV, dynamic code
 * gen) + non-released dependencies, spread across the whole codebase — not the tiny
 * set of registry-known dependency edges (which the old metric divided by, giving a
 * misleading 100% over a denominator of ~2).
 *
 * S/4HANA vs Cloud are DISTINCT and Cloud is stricter:
 *  - S/4HANA on-prem blockers: deprecated/removed SAP objects + modifications to SAP
 *    standard. Classic patterns (CALL FUNCTION, classic ALV, OPEN DATASET) still RUN
 *    on S/4 on-prem, so they are NOT S/4 blockers.
 *  - ABAP Cloud blockers: all of the above PLUS every non-cloud code pattern
 *    (clean-core violations, kernel/security patterns) and non-released APIs
 *    (classicAPI included — runs on S/4, blocks Cloud).
 *
 * The registry API-dependency counts (released/classicAPI/deprecated/removed) are
 * retained as SECONDARY dependency-hygiene detail, not the headline.
 */

/** Compilation-unit node kinds + customer namespaces = the assessed object population. */
const COMPILATION_UNIT_KINDS = new Set(["class", "interface", "function", "report", "cds", "behavior", "form"]);
const CUSTOMER_NS = new Set(["Z", "Y"]);

/** Families whose findings block ABAP Cloud (non-released APIs + non-cloud patterns). */
const CLOUD_BLOCKER_FAMILIES = new Set(["released-api", "deprecation", "clean-core", "modification", "security"]);
/** Families whose findings break S/4HANA on-prem (classic patterns still run there). */
const S4_BLOCKER_FAMILIES = new Set(["deprecation", "modification"]);
/** A released-api finding blocks S/4 only when the SAP object is deprecated(C)/removed(D), not classicAPI(B, runs on S/4). */
const S4_BLOCKING_GRADES = new Set(["blocker", "warning"]);

/** Dependency edge kinds whose target the oracle can classify (dependency-hygiene detail). */
const CLASSIFIABLE_EDGE_KINDS = new Set(["call-function", "uses-table", "consumes-cds", "inherits"]);

/** @param {object} f a finding @returns {boolean} does it block S/4HANA on-prem? */
function isS4Blocker(f) {
  return S4_BLOCKER_FAMILIES.has(f.family) || (f.family === "released-api" && S4_BLOCKING_GRADES.has(f.grade));
}

/** @param {object} f a finding @returns {boolean} does it block ABAP Cloud? */
function isCloudBlocker(f) {
  return CLOUD_BLOCKER_FAMILIES.has(f.family);
}

/**
 * @param {import("./cpg.js").DependencyGraph} graph
 * @param {object[]} findings curated findings
 * @param {{level: (name: string) => string}} cloud oracle-Level classifier
 * @returns {object} the s4_readiness block
 */
export function computeReadiness(graph, findings, cloud) {
  const g = graph.toGraphJSON();
  const objects = new Set();
  for (const n of g.nodes) if (CUSTOMER_NS.has(n.namespace) && COMPILATION_UNIT_KINDS.has(n.kind)) objects.add(n.object);
  const total = objects.size;

  const s4Blocked = new Set();
  const cloudBlocked = new Set();
  let s4BlockerFindings = 0;
  let cloudBlockerFindings = 0;
  for (const f of findings ?? []) {
    if (!f?.object || !objects.has(f.object)) continue; // assess customer objects only
    if (isS4Blocker(f)) {
      s4Blocked.add(f.object);
      s4BlockerFindings += 1;
    }
    if (isCloudBlocker(f)) {
      cloudBlocked.add(f.object);
      cloudBlockerFindings += 1;
    }
  }

  const pct = (blocked) => (total > 0 ? Math.round((100 * (total - blocked)) / total) : 100);
  return {
    s4_readiness_pct: pct(s4Blocked.size),
    cloud_readiness_pct: pct(cloudBlocked.size),
    total_objects: total,
    s4_blocked_objects: s4Blocked.size,
    cloud_blocked_objects: cloudBlocked.size,
    s4_blocker_findings: s4BlockerFindings,
    cloud_blocker_findings: cloudBlockerFindings,
    ...apiDependencyHygiene(g, cloud),
  };
}

/**
 * Secondary detail: how many of the object's classifiable SAP API DEPENDENCIES sit
 * at each oracle Level (released A / classicAPI B / deprecated C / removed D). This
 * is dependency hygiene, NOT the readiness headline.
 * @param {{edges?: object[]}} g graph JSON
 * @param {{level: (name: string) => string}} cloud
 * @returns {{released_hits: number, classic_api_hits: number, deprecated_hits: number, not_released_hits: number, total_api_calls: number}}
 */
function apiDependencyHygiene(g, cloud) {
  let a = 0;
  let b = 0;
  let c = 0;
  let d = 0;
  for (const edge of g.edges ?? []) {
    if (!CLASSIFIABLE_EDGE_KINDS.has(edge.kind)) continue;
    const lvl = cloud.level(edge.target);
    if (lvl === "A") a += 1;
    else if (lvl === "B") b += 1;
    else if (lvl === "C") c += 1;
    else if (lvl === "D") d += 1;
  }
  return { released_hits: a, classic_api_hits: b, deprecated_hits: c, not_released_hits: d, total_api_calls: a + b + c + d };
}
