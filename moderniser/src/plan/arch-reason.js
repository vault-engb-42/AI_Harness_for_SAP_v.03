/**
 * The PURE arch-reason engine (BUILD_PLAN S14). It sits between the disposition gate and the arch gate
 * and NEVER calls the model (that would break `plan/` purity + determinism). For each re_architect /
 * rebuild node it decides one of four outcomes:
 *   - `skip`          — a non-arch disposition needs no target-shape reasoning;
 *   - `deterministic` — a high-confidence single candidate: take `match.js`'s top shape, NO model;
 *   - `cached`        — an escalated node whose (fact_hash, model_id, prompt_hash) is already frozen
 *                       in the verdict cache: reuse it, NO model, no re-ratify;
 *   - `await_arch`    — an escalated cache MISS: emit the request the FULFILLER acts on (spawns the
 *                       judge). The pure engine surfaces the miss; it never spawns.
 *
 * Mirrors the S8 renderOfflineNodeVerdict → driveOfflineVerdict split (pure producer / imperative
 * fulfiller). P8: the request carries the `factStream` (arch-facts.js) as the ONLY prompt input — the
 * node sig never enters the fact, so the judge prompt is injection-closed.
 */
import { hashFactStream } from "./arch-facts.js";
import { ARCH_GATED_DISPOSITIONS } from "./arch-contract.js";

/** Below this classifier confidence, an arch node is escalated to the judge (Sharpening 5 cost control). */
export const ARCH_REASON_CONFIDENCE_CEILING = 0.9;
/** Above this blast radius (Σ at-risk SAP deps over members), escalate even a single high-confidence candidate. */
export const ARCH_REASON_BLAST_BOUND = 10;

/**
 * The escalation predicate (S14): reason iff the disposition is arch-shaped AND the deterministic
 * classification is not both high-confidence and unambiguous and low-blast.
 * @param {object} node a frozen plan node (disposition / disposition_confidence / member_meta)
 * @param {Array<{id: string}>} candidates match.js candidates
 * @param {{ceiling?: number, blastBound?: number}} [opts]
 * @returns {boolean}
 */
export function needsReasoning(node, candidates, opts = {}) {
  if (!ARCH_GATED_DISPOSITIONS.has(node.disposition)) return false;
  const ceiling = opts.ceiling ?? ARCH_REASON_CONFIDENCE_CEILING;
  const bound = opts.blastBound ?? ARCH_REASON_BLAST_BOUND;
  const confidence = Number(node.disposition_confidence ?? 0);
  if (confidence < ceiling || nodeBlast(node) > bound || (candidates?.length ?? 0) > 1) return true;
  // A settled shape can still owe an APP-LEVEL answer. `mergeShared` builds the blueprint from
  // `recommendation.shared`, and only `freezeJudgeSelection` attaches that field — the deterministic
  // `recommend()` emits none. So a matcher-resolved row could never join a Fiori app or a service group,
  // and on TALV that locked out 24 of 34 rows: every blueprint came back empty not because the answer was
  // empty but because most objects were never asked. A shape that implies cross-object structure therefore
  // escalates even when the matcher settled it. The shape is not reopened — with a single candidate,
  // `validateSelection` admits only that same id, so the judge can add the grouping and nothing else.
  return GROUPING_SHAPES.has(candidates?.[0]?.id);
}

/**
 * Shapes whose value depends on how objects group: one OData service fronting several BOs, one Fiori app
 * over several screens, one analytical model over several reads. A `rap_bo_headless` shares nothing by
 * definition, so asking about it would be a judge round-trip that can only answer "none".
 */
const GROUPING_SHAPES = new Set(["rap_bo_fiori", "rap_bo_odata", "analytical_cds"]);

/** The verdict-cache key: idempotent per (facts, pinned judge model, committed prompt). */
export function entryKey(factHashValue, modelId, promptHash) {
  return `${factHashValue}:${modelId}:${promptHash}`;
}

/**
 * @param {object} node the frozen plan node
 * @param {object} fact the fact stream (arch-facts.js `factStream(node, consumptionCache)`)
 * @param {Array<{id: string, name?: string, score?: number, components?: string[], invariants?: string[]}>} candidates match.js output
 * @param {Record<string, object>} [cache] the verdict cache (entryKey → frozen recommendation)
 * @param {{model_id?: string, prompt_hash?: string, ceiling?: number, blastBound?: number}} [opts]
 * @returns {{status: "skip"|"deterministic"|"cached"|"await_arch", fact_hash?: string, recommendation?: object, request?: object, reason?: string}}
 */
export function reasonArchitecture(node, fact, candidates, cache = {}, opts = {}) {
  if (!ARCH_GATED_DISPOSITIONS.has(node.disposition)) {
    return { status: "skip", reason: `disposition '${node.disposition}' needs no architecture reasoning` };
  }
  const fact_hash = hashFactStream(fact);

  // No candidate at all is NOT a judge question. The request would carry an empty `candidates` list, the
  // judge is bound to select from it, and the only remaining answer — `other` — is refused by
  // `freezeJudgeSelection` ("add it to the patterns corpus first"). So the node used to rest at
  // await_human/arch_ratification offering the human no shape to ratify: a gate nobody could clear.
  //
  // It became reachable the moment `rap_bo_headless` stopped matching on silence. That is the honest
  // outcome, not a regression: 11 of TALV's 24 arch-gated nodes have no consumption evidence at all, and
  // the harness cannot justify a target shape for them. Saying so is the point — the alternative is the
  // silent headless BO this whole arc removed. The human resolves it by re-DISPOSITIONING the node
  // (`decide … override:<disposition>` → `replan`), not by inventing a shape.
  if ((candidates ?? []).length === 0) {
    return {
      status: "no_shape",
      fact_hash,
      reason: "no target shape fits this object's evidence — re-disposition it (seal/retire/refactor) rather than inventing a shape",
    };
  }

  if (!needsReasoning(node, candidates, opts)) {
    return { status: "deterministic", fact_hash, recommendation: recommend(node, candidates[0], candidates, "deterministic") };
  }

  const key = entryKey(fact_hash, opts.model_id, opts.prompt_hash);
  const cached = cache[key];
  if (cached) return { status: "cached", fact_hash, recommendation: cached };
  return { status: "await_arch", fact_hash, request: buildRequest(node, fact, candidates, fact_hash, opts) };
}

/**
 * Validate a judge selection against the offered candidates — the FULFILLER guard (fail-closed). A shape
 * outside the candidate set (and not the `other` corpus-extension sentinel) is rejected, so injection or
 * a hallucinated shape can never widen the closed target_shape vocabulary.
 */
export function validateSelection(selection, candidates) {
  if (!selection || typeof selection.target_shape !== "string") {
    throw new Error("arch-reason: judge selection is missing target_shape");
  }
  const ids = new Set((candidates ?? []).map((c) => c.id));
  if (selection.target_shape !== "other" && !ids.has(selection.target_shape)) {
    throw new Error(`arch-reason: judge selected '${selection.target_shape}' outside the match candidates [${[...ids].join(", ")}]`);
  }
  return true;
}

/**
 * Freeze a JUDGE selection into the exact recommendation shape the deterministic path produces — the
 * fulfiller's write seam (S14), the counterpart to the `await_arch` request. The selection is validated
 * against the offered candidates FIRST, so a hallucinated or injected shape can never widen the closed
 * target_shape vocabulary (P8). The `other` corpus-extension sentinel is accepted by `validateSelection`
 * but cannot be frozen: a bespoke shape must be added to the patterns corpus before it can be contracted.
 */
export function freezeJudgeSelection(node, selection, candidates) {
  validateSelection(selection, candidates);
  const chosen = (candidates ?? []).find((c) => c.id === selection.target_shape);
  if (!chosen) {
    throw new Error(`arch-reason: '${selection.target_shape}' cannot be frozen — add it to the patterns corpus first (grow the corpus, not the code)`);
  }
  const rec = recommend(node, chosen, candidates, "judge");
  // The judge reasons at the APP level first (§6.13 two-level): its optional cross-object grouping — one
  // OData service fronting several BOs, a shared projection, screens collapsed into one Fiori app — rides
  // the recommendation so cmdArch can assemble the app verdict the blueprint conformance tier checks.
  return selection.shared ? { ...rec, shared: selection.shared } : rec;
}

/** A frozen recommendation attached to the node by sig (sigs live here, NEVER in the prompt-bound fact). */
function recommend(node, chosen, candidates, source) {
  return {
    sig: node.id,
    target_shape: chosen.id,
    components: [...(chosen.components ?? [])],
    invariants: [...(chosen.invariants ?? [])],
    candidates: (candidates ?? []).map((c) => ({ id: c.id, score: c.score ?? 0 })),
    source,
  };
}

/** The fulfiller request. `fact` is the ONLY prompt input (P8); `sig` is for re-attaching the result. */
function buildRequest(node, fact, candidates, fact_hash, opts) {
  return {
    sig: node.id,
    fact,
    candidates: (candidates ?? []).map((c) => ({ id: c.id, name: c.name, components: c.components ?? [] })),
    fact_hash,
    model_id: opts.model_id ?? null,
    prompt_hash: opts.prompt_hash ?? null,
    prompt_ref: "plan/patterns/arch-reason-prompt.md",
  };
}

/** Σ blast over the super-node's members (the at-risk SAP dependency count). */
function nodeBlast(node) {
  return Object.values(node.member_meta ?? {}).reduce((sum, m) => sum + (Number(m?.blast) || 0), 0);
}
