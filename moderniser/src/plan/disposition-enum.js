/**
 * The disposition taxonomy (Gartner "R"s → SAP) — MODERNISER_DESIGN §6.11 / BUILD_PLAN B1.
 * A closed, FROZEN set shared by the classifier (plan/disposition.js, B2), the disposition gate
 * (B3), and the decide vocabulary (S2). It grows only by operator ratification, never silently.
 */
export const DISPOSITIONS = Object.freeze([
  "refactor", // Clean-Core ABAP in place
  "re_architect", // RAP + CDS + OData + Fiori (target-shape from the patterns corpus)
  "rebuild", // side-by-side handoff spec — no in-stack generation
  "replace", // wire to a released SAP standard
  "retire", // grounded drop (no released successor)
  "seal", // genuinely manual — NEEDS_MANUAL_SEAM
]);

/**
 * @param {unknown} x
 * @returns {boolean} true iff x is a member of the closed disposition set.
 */
export function isDisposition(x) {
  return typeof x === "string" && DISPOSITIONS.includes(x);
}
