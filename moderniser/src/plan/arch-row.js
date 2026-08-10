/**
 * What the OPERATOR is asked to decide on one architecture-manifest row: the target-shape options and the
 * grouping decisions, each shaped like every other prompt in the harness — one recommendation, real
 * alternatives, an operator-specified escape.
 *
 * Split out of cli-arch.js, which owns the gate itself (reason → blueprint → freeze → raise). That file
 * ISSUES and FREEZES; this one shapes what a human is shown. Keeping them apart also keeps both inside the
 * 300-line limit.
 */
import { buildPromptOptions } from "./prompt-options.js";
import { PATTERN_IDS } from "./patterns/match.js";
import { groupEvidence, groupHub } from "./group-evidence.js";

/**
 * EVERY cross-object group one object was put in, each as its own decidable option. Empty when it belongs to
 * none — there is no decision to take, and inventing one would train the human to click through empty gates.
 *
 * Returning only the FIRST match hid the decision this row exists to surface. `mergeShared` builds `shared`
 * in the order services → projections → fiori_apps, and on TALV every member of the Fiori app is also a
 * member of its OData service — so "these objects become ONE Fiori app", the largest architectural call the
 * run makes, appeared on zero rows while the service membership stood in for it. The memberships are
 * independent claims and each is separately ratifiable, so the object carries all of them.
 *
 * Each decision carries its STRUCTURAL EVIDENCE (group-evidence.js) when a plan context is supplied: how
 * many other members this object is actually connected to, and the hub the group is organised around when
 * that hub is not itself a member. Co-membership is the judge's claim; this is what the claim rests on.
 *
 * @param {{plan: object, adjacency: Map<string, Set<string>>}} [ctx] omit to shape a decision with no evidence
 */
export function groupingDecision(sig, blueprint, ctx = null) {
  const decisions = [];
  for (const [kind, groups] of Object.entries(blueprint?.shared ?? {})) {
    for (const g of groups ?? []) {
      if (!(g.members ?? []).includes(sig)) continue;
      const evidence = ctx ? groupEvidence(sig, g, ctx.adjacency) : null;
      const hub = ctx ? groupHub(g, ctx.plan, ctx.adjacency) : null;
      decisions.push({
        kind,
        id: g.id,
        members: g.members,
        evidence,
        // The group's structural centre, when it is not a member. `validateShared` refuses a non-arch-gated
        // member by design, so a sealed hub can never join the group it organises — and the blueprint then
        // names the shell without the core. Naming it here is the remedy the human can act on.
        absent_hub: hub,
        options: buildPromptOptions(
          { group: `${kind}:${g.id}`, rationale: groupRationale(kind, g, sig, evidence) },
          [{ group: "standalone", rationale: "keep this object on its own — the grouping is a claim about application intent, not a fact" }],
          { labelField: "group", isValid: (v) => typeof v === "string" && v.length > 0 },
        ),
      });
    }
  }
  return decisions;
}

/** The recommendation's reason, with the cohesion evidence folded in when it contradicts the claim. */
function groupRationale(kind, group, sig, evidence) {
  const others = (group.members ?? []).filter((m) => m !== sig).length;
  const base = `judge grouped this with ${others} other object(s) as one ${kind.replace(/s$/, "")}`;
  if (!evidence) return base;
  if (evidence.isolated) {
    return `${base} — but it shares NO structural edge with any of them; the grouping rests on the judge's reading of intent alone`;
  }
  return `${base}; it is structurally connected to ${evidence.linked_members} of them`;
}

/** The prompt-options for a row: buildPromptOptions when a competing shape exists, else an honest 2-option set. */
export function archOptions(recommendation) {
  const alts = (recommendation.candidates ?? [])
    .filter((c) => c.id !== recommendation.target_shape)
    .map((c) => ({ target_shape: c.id, rationale: `alternative shape (match score ${c.score})` }));
  const why = recommendedRationale(recommendation);
  if (alts.length === 0) {
    // A single-candidate node has no competing shape — the operator's choice is approve | refine | reject,
    // so surface the sole shape + the freeform 'other' (refine) escape without the >= 3 buildPromptOptions rule.
    return [
      { target_shape: recommendation.target_shape, recommended: true, rationale: why },
      { target_shape: "other", recommended: false, rationale: "operator-specified — refine or reject", freeform: true },
    ];
  }
  return buildPromptOptions(
    { target_shape: recommendation.target_shape, rationale: why },
    alts,
    { labelField: "target_shape", isValid: (s) => PATTERN_IDS.includes(s) },
  );
}

/**
 * The reason shown beside the recommended shape. It used to be `recommendation.source` — the literal string
 * "judge" or "deterministic", which names the DECIDER in the field reserved for the decision's reason. The
 * judge's own words are used when a judge reasoned about the node; a matcher-resolved row says plainly that
 * no judge did.
 */
function recommendedRationale(recommendation) {
  if (recommendation.rationale) return recommendation.rationale;
  return recommendation.source === "judge"
    ? "judge-selected (no rationale recorded — pre-dates the required --rationale seam)"
    : "the deterministic matcher left exactly one grounded shape; no judge was asked";
}
