/**
 * The disposition manifest (MODERNISER_DESIGN §6.11, BUILD_PLAN B3): the plan-gate artifact the operator
 * ratifies. One row per plan node carrying the classified disposition; `autonomy=prompt` rows carry the
 * 3-4-option choice set (recommended + grounded alternatives + `other`), `autonomy=auto` rows omit options.
 * Plus a by-disposition summary. Pure + deterministic (rows sorted by sig). The manifest is NOT hashed
 * separately — `disposition_*` already ride `plan_hash` on the node (§6.11).
 */
import { buildPromptOptions } from "./prompt-options.js";

// Grounded alternatives offered per recommended disposition (the `other` escape is appended by buildPromptOptions).
const ALTERNATIVES = Object.freeze({
  re_architect: [{ disposition: "refactor", rationale: "clean in place instead of re-architecting" }, { disposition: "retire", rationale: "drop if a grounded no-successor basis exists" }],
  refactor: [{ disposition: "re_architect", rationale: "re-architect to the analyser's Cloud target instead" }, { disposition: "retire", rationale: "drop if obsolete" }],
  rebuild: [{ disposition: "re_architect", rationale: "in-stack RAP instead of a side-by-side rebuild" }, { disposition: "retire", rationale: "drop if obsolete" }],
  replace: [{ disposition: "re_architect", rationale: "build a bespoke RAP BO instead of adopting the standard" }, { disposition: "retire", rationale: "drop if obsolete" }],
  retire: [{ disposition: "re_architect", rationale: "re-architect instead of dropping" }, { disposition: "replace", rationale: "adopt a released standard instead" }],
  seal: [{ disposition: "re_architect", rationale: "attempt re-architecture" }, { disposition: "retire", rationale: "drop if unsupportable" }],
});

/**
 * Replace an alternative's placeholder rationale with the GROUNDED one when the node carries evidence (P1).
 *
 * The `retire` and `replace` options were always offered, but with rationales like "drop if obsolete" — a
 * choice the operator had no basis to make. Where the cloudification registry supplies a basis, say exactly
 * what it is and name the objects; where it does not, leave the option available but do NOT dress it up as
 * grounded. A `replace` alternative is only ADDED when a standard domain was actually detected — offering it
 * with no basis at all is what made the original option meaningless.
 */
function groundAlternatives(alternatives, evidence) {
  const noSucc = evidence?.no_successor_refs ?? [];
  const domains = evidence?.standard_domains ?? [];
  const grounded = alternatives.map((a) => {
    if (a.disposition === "retire" && noSucc.length > 0) {
      return { ...a, rationale: `${noSucc.length} referenced SAP ${noSucc.length === 1 ? "API has" : "APIs have"} no released successor (${noSucc.join(", ")}) — no forward path as built` };
    }
    if (a.disposition === "replace" && domains.length > 0) {
      return { ...a, rationale: `reads standard ${domains.join(", ")} data — a released SAP standard may already deliver this; verify via /fit-to-standard` };
    }
    return a;
  });
  const hasReplace = grounded.some((a) => a.disposition === "replace");
  if (domains.length > 0 && !hasReplace) {
    grounded.push({ disposition: "replace", rationale: `reads standard ${domains.join(", ")} data — a released SAP standard may already deliver this; verify via /fit-to-standard` });
  }
  return grounded;
}

/**
 * @param {{plan_hash: string, nodes: Array<object>}} plan a frozen, classified plan (disposition_* on each node)
 * @param {{run_id: string}} opts
 * @returns {{run_id: string, plan_hash: string, rows: object[], summary: {by_disposition: Record<string, number>, prompt_count: number, auto_count: number}}}
 */
export function buildDispositionManifest(plan, { run_id }) {
  const rows = [...plan.nodes]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((n) => {
      const row = {
        sig: n.id,
        object: n.object,
        disposition: n.disposition,
        target: n.disposition_target ?? null,
        rationale: n.disposition_rationale,
        // `confidence` is the CLASSIFIER's confidence, so it is null on an operator override — and these two
        // provenance fields are what make that absence legible rather than merely blank. Without them the
        // artifact a human ratifies cannot distinguish "no classifier ran" from "the classifier was unsure",
        // and cannot name who decided. Reported, never invented: an unprovenanced node reads as null, since
        // defaulting it to "classifier" would be the same fabrication in a different field.
        confidence: n.disposition_confidence,
        source: n.disposition_source ?? null,
        decided_by: n.disposition_decided_by ?? null,
        autonomy: n.disposition_autonomy,
      };
      if (n.disposition_autonomy === "prompt") {
        row.options = buildPromptOptions(
          { disposition: n.disposition, rationale: n.disposition_rationale },
          groundAlternatives(ALTERNATIVES[n.disposition] ?? [], n.disposition_evidence),
        );
      }
      return row;
    });

  const by_disposition = {};
  let prompt_count = 0;
  let auto_count = 0;
  for (const r of rows) {
    by_disposition[r.disposition] = (by_disposition[r.disposition] ?? 0) + 1;
    if (r.autonomy === "auto") auto_count += 1;
    else prompt_count += 1;
  }

  return { run_id, plan_hash: plan.plan_hash, rows, summary: { by_disposition, prompt_count, auto_count } };
}
