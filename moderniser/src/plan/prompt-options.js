/**
 * The prompt contract (MODERNISER_DESIGN §6.11, BUILD_PLAN S2 — Arc D). Builds the operator's CHOICE set for
 * a prompted node: >= 3 options, EXACTLY one `recommended:true` (listed first), grounded alternatives, and
 * ALWAYS an `other` (operator-specified, freeform) escape. A bare recommendation or alternatives with no
 * recommendation both violate the contract. Reused by both plan-time gates (disposition + architecture).
 */
import { isDisposition } from "./disposition-enum.js";

/**
 * @param {{disposition: string, rationale: string}} recommended the evidence-based recommended disposition
 * @param {Array<{disposition: string, rationale: string}>} alternatives grounded alternatives (>= 1 required)
 * @returns {Array<{disposition: string, recommended: boolean, rationale: string, freeform?: boolean}>}
 */
export function buildPromptOptions(recommended, alternatives = []) {
  if (!recommended || !isDisposition(recommended.disposition)) {
    throw new Error(`prompt-options: recommended must carry a valid disposition (got ${recommended?.disposition})`);
  }
  const seen = new Set([recommended.disposition]);
  const options = [{ disposition: recommended.disposition, recommended: true, rationale: recommended.rationale }];
  for (const a of alternatives) {
    if (!isDisposition(a.disposition)) {
      throw new Error(`prompt-options: alternative '${a.disposition}' is not a valid disposition`);
    }
    if (seen.has(a.disposition)) continue; // dedupe an alternative that repeats the recommendation
    seen.add(a.disposition);
    options.push({ disposition: a.disposition, recommended: false, rationale: a.rationale });
  }
  options.push({ disposition: "other", recommended: false, rationale: "operator-specified — enter a disposition or instruction", freeform: true });
  if (options.length < 3) {
    throw new Error(`prompt-options: need at least 3 options (recommended + >= 1 alternative + other); got ${options.length}`);
  }
  return options;
}
