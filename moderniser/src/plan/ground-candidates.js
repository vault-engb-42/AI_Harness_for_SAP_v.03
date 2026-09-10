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
// Reached only on positive ref evidence (see `sourceGrounded` below). At or above the gate's 0.9 threshold,
// so this is the value — and the only value — that lets a refactor node clear the human prompt.
const SOURCE_GROUNDED_CERTAINTY = 1.0;

/**
 * Registry states that mean "this API is not coming to the cloud as-is" — expressed in the vocabulary
 * `classify()` actually RETURNS, which is not the registry's raw vocabulary.
 *
 * The raw dataset says `released | deprecated | notToBeReleased`, but classify() derives release_state from
 * the ORACLE LEVEL (cloudification.js `RELEASE_STATE_FOR_LEVEL`: A→released, B/C→deprecated, D→removed) and
 * can never return `notToBeReleased`. Matching that raw word therefore matched nothing at all, and it was
 * exactly the class P1 was built to find: every one of the 81 zero-successor level-D objects — CL_HTTP_CLIENT
 * among them — carries `raw=notToBeReleased` and classifies as `removed`. Counted over the bundled registry:
 * deprecated 550 (458 with no successor), removed 675 (81 with no successor), released 33,450.
 */
const NO_FORWARD_PATH = new Set(["deprecated", "removed"]);

// A customer prefix (Z or Y) is customer code, not an SAP API — evidence of nothing about released-API
// cleanliness, so such a ref is counted neither for nor against the source-grounded 1.0.
const CUSTOMER_NS = /^[ZY]/;

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
    const { _sapRefCount = 0, _allRefsReleased = false, ...ev } =
      registry.get(o.object) ?? { no_successor_refs: [], standard_domains: [] };
    const released_clean = analysed && p1Blockers.length === 0;
    // GAP 1 — the source-grounded 1.0, and the ONLY thing that opens the disposition gate's `auto` lane.
    // It demands POSITIVE evidence on both axes: finding-derived cleanliness AND at least one classifiable
    // SAP reference with every one of them `released`. An object referencing nothing stays at 0.8 — absence
    // of refs is not cleanliness — and `unknown` never counts as released, because that is what the
    // registry returns for an SAP object it simply does not carry (BAPI_SALESORDER_CREATEFROMDAT2 among
    // them). 1.0 means no human looks at this node again, so it is spent only where something was proved.
    const sourceGrounded = released_clean && _sapRefCount > 0 && _allRefsReleased;
    cache[o.object] = {
      released_clean,
      // The registry answers "is this SAP API released, and what replaces it?" — it CANNOT answer "does a
      // released SAP standard already deliver this CUSTOM object's capability", which is a semantic bridge
      // (why fit-to-standard is advisory). So this stays false and the standard-domain reads below are
      // offered as EVIDENCE for the human's replace decision, never as an automatic classification.
      released_standard_exists: false,
      grounding_certainty: sourceGrounded ? SOURCE_GROUNDED_CERTAINTY : FINDING_DERIVED_CERTAINTY,
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
    if (!byObject.has(owner)) byObject.set(owner, { noSucc: new Set(), domains: new Set(), sapRefs: new Set(), unreleased: new Set() });
    return byObject.get(owner);
  };
  for (const e of doc?.graph?.edges ?? []) {
    const owner = String(e.source ?? "").split(".")[0];
    // The OWNING object, on both sides. A CPG edge names members qualified: `ZCL_FOO.METHOD`. The source was
    // already split; the target was not, so `CL_GUI_FRONTEND_SERVICES.GUI_UPLOAD` — a `call-method` edge, and
    // call-method is how ABAP references SAP classes at all — never matched the registry. The whole channel
    // was silent, including the golden fixture's one deprecated reference. Splitting is a no-op for the
    // already-bare `call-function` and `uses-table` targets.
    const ref = String(e.target ?? "").split(".")[0].toUpperCase();
    if (!owner || !ref) continue;
    const bucket = ensure(owner);

    // Table READS only, matching fit-to-standard.js's sibling filter exactly (they answer the same question
    // and must not diverge): a symbol that merely shares a standard table's name is not a read of it.
    if (e.kind === "uses-table") {
      const domain = STANDARD_DOMAINS[ref];
      if (domain) bucket.domains.add(domain);
    }

    const info = classify(ref);

    // GAP 1 evidence. A CUSTOMER ref (Z*/Y*) is not an SAP API and says nothing about released-API
    // cleanliness, so it is not counted either way. Everything else is: `released` is the positive
    // evidence the source-grounded 1.0 rests on, and ANY other state — including `unknown`, which is what
    // the registry returns for an SAP object it simply does not carry — withholds it.
    if (!CUSTOMER_NS.test(ref)) {
      bucket.sapRefs.add(ref);
      if (info?.release_state !== "released") bucket.unreleased.add(ref);
    }

    if (!NO_FORWARD_PATH.has(info?.release_state)) continue;
    // A named successor means there IS a forward path — that is a re-architect basis, not a retire one.
    if ((info.successors ?? []).length === 0) bucket.noSucc.add(ref);
  }
  const out = new Map();
  for (const [owner, b] of byObject) {
    out.set(owner, {
      no_successor_refs: [...b.noSucc].sort(),
      standard_domains: [...b.domains].sort(),
      _sapRefCount: b.sapRefs.size,
      _allRefsReleased: b.sapRefs.size > 0 && b.unreleased.size === 0,
    });
  }
  return out;
}
