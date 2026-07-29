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
        confidence: n.disposition_confidence,
        autonomy: n.disposition_autonomy,
      };
      if (n.disposition_autonomy === "prompt") {
        row.options = buildPromptOptions(
          { disposition: n.disposition, rationale: n.disposition_rationale },
          ALTERNATIVES[n.disposition] ?? [],
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
