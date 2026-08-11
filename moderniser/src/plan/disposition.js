/**
 * The disposition classifier (MODERNISER_DESIGN §6.11, BUILD_PLAN B2/S3). PURE over (node, grounding cache):
 * maps the analyser signal-set + `modernization_target` + grounding verdict to a disposition + confidence +
 * autonomy. It classifies; it never mutates the FSM, never does I/O, and never reads `doc.findings` (the
 * signals ride the node from B1). Grounding is a separate I/O pre-pass (`ground-candidates.js`).
 */

/** Auto-apply threshold (S3): a disposition is `auto` only if reversible ∧ confidence ≥ θ ∧ refactor. */
export const DISPOSITION_AUTO_THRESHOLD = 0.9;

// B2-generalisation (operator 2026-07-29): the classifier reasons on disposition HINTS
// (`node.disposition_hints`, derived from the analyser's OWN description of each finding in
// `node/disposition-hints.js`) — NOT a hand-picked list of rule_ids. So any legacy archetype the analyser
// recognises (dynpro / ALV / SmartForms / Web Dynpro / IDoc) classifies correctly without per-fixture tuning.
// `ui_rearch` + `os_exec` are the hard re-architect blockers (no in-stack ABAP-Cloud equivalent).
const RE_ARCH_TARGET = /\b(RAP|CDS|OData|Fiori)\b/i;

/**
 * @param {{object: string, kind?: string, finding_families?: string[], driving_rule_ids?: string[], modernization_target?: string|null, dynamic_seal?: string}} node a plan node (B1-enriched)
 * @param {Record<string, {released_clean?: boolean, released_standard_exists?: boolean, grounding_certainty?: number}>} cache grounding cache (ground-candidates.js)
 * @returns {{disposition: string, disposition_rationale: string, disposition_target: string|null, disposition_confidence: number, disposition_reversible: boolean, disposition_autonomy: string}}
 */
export function classifyDisposition(node, cache = {}, structure = null) {
  const g = cache[node.object] ?? {};
  const hints = new Set(node.disposition_hints ?? []);
  const target = node.modernization_target ?? null;

  const pick = decide(node, g, hints, target, structure);
  const reversible = pick.disposition === "refactor";
  const autonomy = pick.disposition === "refactor" && pick.confidence >= DISPOSITION_AUTO_THRESHOLD ? "auto" : "prompt";

  return {
    disposition: pick.disposition,
    disposition_rationale: pick.rationale,
    disposition_target: pick.target ?? null,
    disposition_confidence: pick.confidence,
    disposition_reversible: reversible,
    disposition_autonomy: autonomy,
    // P1: the grounded basis behind the OPTIONS the human chooses from — which referenced SAP APIs have no
    // released successor (the basis a `retire` is specified to rest on) and which standard business domains
    // the object reads (the basis for a `replace`). It rides the node so the disposition gate can show the
    // operator what a choice would rest on. It deliberately does NOT change the recommendation above:
    // "no forward path as built" still admits re-architecting rather than dropping, and whether a capability
    // is still wanted is a business call no registry can make.
    // Unioned across EVERY member (R6): a super-node is a condensed SCC that ships as one unit, and its id
    // is only the smallest member's sig — so reading the representative alone hid a dead API that any other
    // member reached. The decision inputs above stay representative-keyed; this is the EVIDENCE the human
    // reads, and it must describe the whole node.
    disposition_evidence: {
      no_successor_refs: unionEvidence(node, cache, "no_successor_refs"),
      standard_domains: unionEvidence(node, cache, "standard_domains"),
    },
  };
}

/** Union a grounding-cache evidence field over the node's in-plan members (sorted, deduped). */
function unionEvidence(node, cache, field) {
  const members = node.members?.length ? node.members : [node.object];
  const s = new Set();
  for (const m of members) for (const v of cache[m]?.[field] ?? []) s.add(v);
  return [...s].sort();
}

/**
 * Ordered signal match → {disposition, rationale, target, confidence}. First HARD signal wins; the
 * `modernization_target` is the fallback so an analysed-but-empty-signal object (e.g. an FM whose findings
 * are attributed to its function group) still routes to re_architect, never to refactor by mere absence.
 */
function decide(node, g, hints, target, structure) {
  if (node.dynamic_seal === "NEEDS_MANUAL_SEAM") {
    return { disposition: "seal", rationale: "dynamic dispatch sealed the node (NEEDS_MANUAL_SEAM)", target: null, confidence: 0.95 };
  }
  if (hints.has("ui_rearch")) {
    return { disposition: "re_architect", rationale: "classic UI (dynpro/WRITE/list/ALV/SmartForms/WebDynpro) — no in-stack Cloud UI; target RAP+Fiori", target, confidence: 0.85 };
  }
  if (hints.has("os_exec")) {
    return { disposition: "re_architect", rationale: "OS/file operation — no released in-stack equivalent; arch design decides re-arch/retire", target, confidence: 0.85 };
  }
  if (g.released_standard_exists) {
    return { disposition: "replace", rationale: "a released SAP standard exists (fit-to-standard hit) — adopt, don't build", target: target ?? "released SAP standard", confidence: g.grounding_certainty ?? 0.8 };
  }
  // Role-aware balance (evidence: zapcommander, 2026-07-29). Interfaces + exception classes are STRUCTURALLY
  // never re-architected — retain-and-clean in place, regardless of the coarse target.
  if (isRetainKind(node)) {
    const what = node.kind === "interface" ? "interface" : "exception class";
    return { disposition: "refactor", rationale: `${what} — structurally retained; Clean-Core refactor in place`, target: target ?? "in-stack retain", confidence: g.released_clean ? (g.grounding_certainty ?? 0.8) : 0.7 };
  }
  // Cross-system integration (RFC / CALL FUNCTION DESTINATION / IDoc / ALE): re-architect to a released in-stack
  // communication API (comm scenario / OData client proxy / RAP inbound) — the Clean-Core default. `rebuild`
  // (side-by-side/BTP, §935-gated) is NOT emitted per object from a bare cross-system token; it is the grounded,
  // app-level promotion the app-blueprint (B3.5) makes from this same `rfc_rebuild` hint. Placed BELOW isRetainKind
  // (an integration interface / CX_ exception stays refactor) and ABOVE released_clean + target, so a clean-ish or
  // untargeted integration object still routes to re_architect rather than masquerading as an in-place refactor.
  // Ratified 2026-07-29 (BUILD_PLAN §186) — the generalisation guarantee: every cross-system archetype gets a
  // true-modernisation disposition regardless of whether the analyser populated a target.
  if (hints.has("rfc_rebuild")) {
    return { disposition: "re_architect", rationale: "cross-system integration (RFC/IDoc/ALE) — re-architect to a released in-stack communication API; app-blueprint may promote to side-by-side rebuild", target, confidence: 0.8 };
  }
  // Champion re-architecture where the analyser assigned a Cloud target — even for a currently-clean logic/UI
  // class (a clean business class in a RAP app should BECOME a RAP BO, not be left classic). Target wins over
  // mere cleanliness here; the gate (B3) offers refactor/retire as alternatives, the app-blueprint (B3.5) decides absorption.
  //
  // RC-2: the label may CONFIRM structure, never invent it. NINE of the fifteen recommendations the
  // 2026-08-11 independent review failed rode this exact branch — the analyser calls a demo program a "Fiori
  // Elements App" because it draws a grid, and the object was re-architected on the strength of that string.
  // The patterns corpus already forbids a coarse `modernization_target` dictating the SHAPE; disposition was
  // obeying it unconditionally. An object the CPG shows to have no surface and no data of its own is sealed
  // for manual review instead.
  if (target && RE_ARCH_TARGET.test(target)) {
    if (structure && !hasStructure(structure)) {
      return {
        disposition: "seal",
        rationale: `the analyser named "${target}" but the CPG shows no surface and no data of its own — manual review`,
        target: null,
        confidence: 0.4,
      };
    }
    return { disposition: "re_architect", rationale: `analyser target "${target}" — re-architect to Cloud`, target, confidence: 0.7 };
  }
  // Non-retain, no re-arch target, released-clean → in-stack Clean-Core refactor.
  if (g.released_clean) {
    return { disposition: "refactor", rationale: "released-API-clean (analysed, 0 P1 blockers), no re-arch target — in-stack Clean-Core refactor", target: target ?? "in-stack Clean-Core", confidence: g.grounding_certainty ?? 0.8 };
  }
  return { disposition: "seal", rationale: "no clear disposition signal — manual review", target: null, confidence: 0.3 };
}

/**
 * Did the CPG actually SEE anything — a surface it presents, or data of its own? Both dimensions state their
 * own absence explicitly (`no_surface_evidence` / `no_persistence_evidence`), so this reads real evidence
 * rather than an empty list, and an object that is merely unread is never mistaken for one proven empty.
 *
 * Fail-SAFE by construction: `decide` only consults this when `structure` was supplied at all. A caller that
 * cannot produce CPG evidence gets the old behaviour, not a silent mass re-disposition.
 */
function hasStructure({ consumption = [], persistence = [] }) {
  const real = (facts, absence) => facts.some((f) => f !== absence);
  return real(consumption, "no_surface_evidence") || real(persistence, "no_persistence_evidence");
}

/**
 * Structurally non-re-architectable kinds: interfaces stay interfaces; SAP exception classes stay exception
 * classes. Keyed on `object_kind` (the ABAP kind carried from the scoped node) — NOT `node.kind`, which on a
 * plan node is the graph kind ("object"/"super"). Exception classes match the SAP naming convention `CX_`
 * (incl. `ZCX_`/`YCX_` and registered namespaces `/NS/CX_`). The loose `_ERROR$` suffix was DROPPED
 * (adversarial review 2026-07-29) — it over-matched ordinary business classes like `ZCL_ORDER_ERROR` and
 * under-matched Y-namespace/namespaced exceptions. A fully robust check keys on superclass = CX_ROOT (a
 * scope.js enhancement), not the name.
 */
function isRetainKind(node) {
  if (node.object_kind === "interface") return true;
  if (node.object_kind === "class" && /(^|\/)[YZ]?CX_/i.test(node.object)) return true;
  return false;
}
