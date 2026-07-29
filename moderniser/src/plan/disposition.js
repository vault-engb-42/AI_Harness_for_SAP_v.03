/**
 * The disposition classifier (MODERNISER_DESIGN §6.11, BUILD_PLAN B2/S3). PURE over (node, grounding cache):
 * maps the analyser signal-set + `modernization_target` + grounding verdict to a disposition + confidence +
 * autonomy. It classifies; it never mutates the FSM, never does I/O, and never reads `doc.findings` (the
 * signals ride the node from B1). Grounding is a separate I/O pre-pass (`ground-candidates.js`).
 */

/** Auto-apply threshold (S3): a disposition is `auto` only if reversible ∧ confidence ≥ θ ∧ refactor. */
export const DISPOSITION_AUTO_THRESHOLD = 0.9;

// S3 seed signal sets (tune with fixtures). Classic-UI and OS-exec are the hard re-architect blockers —
// neither has an in-stack ABAP-Cloud equivalent, so the object cannot merely be refactored in place.
const UI_RULES = new Set(["talos-cloud-006-write", "talos-legacy-ui-rollup", "talos-s4-003-classic-list-output"]);
const OSEXEC_RULES = new Set(["talos-sec-002-open-dataset-var", "talos-cloud-005-call-system", "talos-sec-001-sxpg"]);
const UI_FAMILIES = new Set(["dynpro"]);
const RE_ARCH_TARGET = /\b(RAP|CDS|OData|Fiori)\b/i;

/**
 * @param {{object: string, kind?: string, finding_families?: string[], driving_rule_ids?: string[], modernization_target?: string|null, dynamic_seal?: string}} node a plan node (B1-enriched)
 * @param {Record<string, {released_clean?: boolean, released_standard_exists?: boolean, grounding_certainty?: number}>} cache grounding cache (ground-candidates.js)
 * @returns {{disposition: string, disposition_rationale: string, disposition_target: string|null, disposition_confidence: number, disposition_reversible: boolean, disposition_autonomy: string}}
 */
export function classifyDisposition(node, cache = {}) {
  const g = cache[node.object] ?? {};
  const rules = new Set(node.driving_rule_ids ?? []);
  const families = new Set(node.finding_families ?? []);
  const target = node.modernization_target ?? null;

  const pick = decide(node, g, rules, families, target);
  const reversible = pick.disposition === "refactor";
  const autonomy = pick.disposition === "refactor" && pick.confidence >= DISPOSITION_AUTO_THRESHOLD ? "auto" : "prompt";

  return {
    disposition: pick.disposition,
    disposition_rationale: pick.rationale,
    disposition_target: pick.target ?? null,
    disposition_confidence: pick.confidence,
    disposition_reversible: reversible,
    disposition_autonomy: autonomy,
  };
}

/**
 * Ordered signal match → {disposition, rationale, target, confidence}. First HARD signal wins; the
 * `modernization_target` is the fallback so an analysed-but-empty-signal object (e.g. an FM whose findings
 * are attributed to its function group) still routes to re_architect, never to refactor by mere absence.
 */
function decide(node, g, rules, families, target) {
  if (node.dynamic_seal === "NEEDS_MANUAL_SEAM") {
    return { disposition: "seal", rationale: "dynamic dispatch sealed the node (NEEDS_MANUAL_SEAM)", target: null, confidence: 0.95 };
  }
  if (hasAny(rules, UI_RULES) || hasAny(families, UI_FAMILIES)) {
    return { disposition: "re_architect", rationale: "classic UI (WRITE/dynpro/list) — no in-stack Cloud UI; target RAP+Fiori", target, confidence: 0.85 };
  }
  if (hasAny(rules, OSEXEC_RULES)) {
    return { disposition: "re_architect", rationale: "OS/file operation — no released in-stack equivalent; arch design decides re-arch/retire", target, confidence: 0.85 };
  }
  if (g.released_standard_exists) {
    return { disposition: "replace", rationale: "a released SAP standard exists (fit-to-standard hit) — adopt, don't build", target: target ?? "released SAP standard", confidence: g.grounding_certainty ?? 0.8 };
  }
  if (g.released_clean) {
    return { disposition: "refactor", rationale: "released-API-clean (analysed, 0 P1 blockers) — in-stack Clean-Core refactor", target: target ?? "in-stack Clean-Core", confidence: g.grounding_certainty ?? 0.8 };
  }
  if (target && RE_ARCH_TARGET.test(target)) {
    return { disposition: "re_architect", rationale: `analyser target "${target}" — re-architect to Cloud`, target, confidence: 0.7 };
  }
  return { disposition: "seal", rationale: "no clear disposition signal — manual review", target: null, confidence: 0.3 };
}

function hasAny(set, candidates) {
  for (const x of candidates) if (set.has(x)) return true;
  return false;
}
