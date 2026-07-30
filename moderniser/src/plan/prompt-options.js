/**
 * The prompt contract (MODERNISER_DESIGN §6.11, BUILD_PLAN S2/S12 — Arc D). Builds the operator's CHOICE set
 * for a prompted node: >= 3 options, EXACTLY one `recommended:true` (listed first), grounded alternatives, and
 * ALWAYS an `other` (operator-specified, freeform) escape. A bare recommendation or alternatives with no
 * recommendation both violate the contract. GENERALISED over the labelled field so BOTH plan-time gates reuse
 * it: gate 1 (disposition) keys on `disposition`/`isDisposition`; gate 2 (architecture) keys on `target_shape`
 * with a patterns-corpus-id validator (S12). The `{labelField, isValid}` defaults preserve the disposition gate.
 */
import { isDisposition } from "./disposition-enum.js";

/**
 * @param {Record<string, string>} recommended the recommended option (carries `[labelField]` + `rationale`)
 * @param {Array<Record<string, string>>} alternatives grounded alternatives (>= 1 required)
 * @param {{labelField?: string, isValid?: (v: string) => boolean}} [opts] the labelled field + its validator
 * @returns {Array<Record<string, unknown>>} options with `[labelField]`, `recommended`, `rationale`, `freeform?`
 */
export function buildPromptOptions(recommended, alternatives = [], { labelField = "disposition", isValid = isDisposition } = {}) {
  const label = (o) => o?.[labelField];
  if (!recommended || !isValid(label(recommended))) {
    throw new Error(`prompt-options: recommended must carry a valid ${labelField} (got ${label(recommended)})`);
  }
  const seen = new Set([label(recommended)]);
  const options = [{ [labelField]: label(recommended), recommended: true, rationale: recommended.rationale }];
  for (const a of alternatives) {
    if (!isValid(label(a))) {
      throw new Error(`prompt-options: alternative '${label(a)}' is not a valid ${labelField}`);
    }
    if (seen.has(label(a))) continue; // dedupe an alternative that repeats the recommendation
    seen.add(label(a));
    options.push({ [labelField]: label(a), recommended: false, rationale: a.rationale });
  }
  options.push({ [labelField]: "other", recommended: false, rationale: "operator-specified — enter a value or instruction", freeform: true });
  if (options.length < 3) {
    throw new Error(`prompt-options: need at least 3 options (recommended + >= 1 alternative + other); got ${options.length}`);
  }
  return options;
}
