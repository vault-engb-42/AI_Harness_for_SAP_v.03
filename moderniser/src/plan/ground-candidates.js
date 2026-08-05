/**
 * The grounding pre-pass (BUILD_PLAN S3): emits a deterministic per-object grounding cache that the PURE
 * disposition classifier consumes, keeping the classifier free of I/O. v1 is FINDING-DERIVED — the analyser's
 * clean-core / deprecation findings already encode its released-API grounding, so `released_clean` = the
 * object was analysed (has findings) AND has ZERO P1 blockers in the clean-core / deprecation families.
 * Absence of findings is NOT cleanliness (an FM whose findings are attributed to its function group must not
 * read as clean). Source-level greenfield grounding (harvestRefs → groundReleasedApis) is a later enhancement
 * that raises `grounding_certainty` to the source-grounded 1.0 and populates `released_standard_exists`.
 */

import { classify } from "../../../analyser/src/cloudification.js";
import { STANDARD_DOMAINS } from "./fit-to-standard.js";

const BLOCKER_FAMILIES = new Set(["clean-core", "deprecation"]);
// Below the source-grounded 1.0 — keeps a finding-derived refactor at PROMPT until real source grounding (θ=0.9).
const FINDING_DERIVED_CERTAINTY = 0.8;

// Registry states that mean "this API is not coming to the cloud as-is".
const NO_FORWARD_PATH = new Set(["deprecated", "notToBeReleased"]);

/**
 * @param {{findings?: Array<{object: string, family?: string, atc_priority?: string}>, modernization_plan?: {objects?: Array<{object: string}>}}} doc analyser-findings.json
 * @returns {Record<string, {released_clean: boolean, released_standard_exists: boolean, grounding_certainty: number}>}
 */
export function groundCandidates(doc) {
  const byObject = new Map();
  for (const f of doc.findings ?? []) {
    if (!byObject.has(f.object)) byObject.set(f.object, []);
    byObject.get(f.object).push(f);
  }
  const registry = groundRegistryRefs(doc);
  const cache = {};
  for (const o of doc.modernization_plan?.objects ?? []) {
    const fs = byObject.get(o.object) ?? [];
    const analysed = fs.length > 0;
    const p1Blockers = fs.filter((f) => f.atc_priority === "P1" && BLOCKER_FAMILIES.has(f.family));
    const ev = registry.get(o.object) ?? { no_successor_refs: [], deprecated_refs: [], standard_domains: [] };
    cache[o.object] = {
      released_clean: analysed && p1Blockers.length === 0,
      // The registry answers "is this SAP API released, and what replaces it?" — it CANNOT answer "does a
      // released SAP standard already deliver this CUSTOM object's capability", which is a semantic bridge
      // (why fit-to-standard is advisory). So this stays false and the standard-domain reads below are
      // offered as EVIDENCE for the human's replace decision, never as an automatic classification.
      released_standard_exists: false,
      grounding_certainty: FINDING_DERIVED_CERTAINTY,
      ...ev,
    };
  }
  return cache;
}

/**
 * Registry-grounded evidence per object (P1). The design deferred `retire`/`replace` to "source grounding"
 * that did not exist; it does now — the bundled SAP cloudification registry, already loaded by the analyser.
 *
 * For each object we classify the SAP objects it REFERENCES (resolved CPG edge targets — P8: symbol names,
 * never source text) and keep two grounded facts:
 *   - `no_successor_refs` — refs the registry marks deprecated / notToBeReleased with NO named successor.
 *     That is exactly the "grounded no-released-successor basis" a `retire` is specified to rest on: there is
 *     no released forward path for the object AS BUILT. It is evidence for a human decision, not the decision
 *     — "no forward path as built" still admits re-architecting the capability instead of dropping it.
 *   - `standard_domains` — recognised standard business domains the object reads (EKKO → Purchasing …), the
 *     evidence behind a `replace` choice, which remains a live verification rather than a claim.
 */
function groundRegistryRefs(doc) {
  const byObject = new Map();
  const ensure = (owner) => {
    if (!byObject.has(owner)) byObject.set(owner, { noSucc: new Set(), deprecated: new Set(), domains: new Set() });
    return byObject.get(owner);
  };
  for (const e of doc?.graph?.edges ?? []) {
    const owner = String(e.source ?? "").split(".")[0];
    const ref = String(e.target ?? "").toUpperCase();
    if (!owner || !ref) continue;
    const bucket = ensure(owner);

    const domain = STANDARD_DOMAINS[ref];
    if (domain) bucket.domains.add(domain);

    const info = classify(ref);
    if (!NO_FORWARD_PATH.has(info?.release_state)) continue;
    bucket.deprecated.add(ref);
    if ((info.successors ?? []).length === 0) bucket.noSucc.add(ref);
  }
  const out = new Map();
  for (const [owner, b] of byObject) {
    out.set(owner, {
      no_successor_refs: [...b.noSucc].sort(),
      deprecated_refs: [...b.deprecated].sort(),
      standard_domains: [...b.domains].sort(),
    });
  }
  return out;
}
