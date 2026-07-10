import { createHash } from "node:crypto";

/**
 * Canonical content-hashed node id (MODERNISER_DESIGN §6.3, L6.3, L9).
 *
 * `sha256(rule|entity_name|seam)` over the node's stable CPG signature — never a
 * positional Tarjan index (abaplint edge numbering is unstable across parses). This
 * id keys the ratchet baselines (`atc-baseline.json`, `abapunit-baseline.json`), so
 * it must survive a re-parse and must never collide two distinct nodes onto one
 * baseline key. Components are derived by the moderniser (§6.3): `rule` = the driving
 * `finding.rule_id`, `entity_name` = the CPG `object`, `seam` = the smallest
 * containing AST unit.
 *
 * Fail-closed: every component must be a non-empty string containing no `|` — a `|`
 * inside a component would make the delimiter ambiguous (`a|b|c` from `("a","b","c")`
 * or from `("a|b","c",…)`), collapsing distinct nodes to one id.
 *
 * @param {{rule: string, entity_name: string, seam: string}} sig
 * @returns {string} 64-char lowercase sha256 hex
 */
export function canonicalNodeId(sig) {
  const rule = component(sig, "rule");
  const entity_name = component(sig, "entity_name");
  const seam = component(sig, "seam");
  return createHash("sha256").update(`${rule}|${entity_name}|${seam}`).digest("hex");
}

/**
 * @param {Record<string, unknown>|null|undefined} sig
 * @param {string} key
 * @returns {string}
 */
function component(sig, key) {
  const v = sig?.[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`canonicalNodeId: signature component '${key}' must be a non-empty string`);
  }
  if (v.includes("|")) {
    throw new Error(`canonicalNodeId: signature component '${key}' must not contain the '|' delimiter`);
  }
  return v;
}
