/**
 * PURE pre-freeze conformance of an app blueprint (BUILD_PLAN S12 build order / §6.13). Run BEFORE any
 * Architecture Contract freezes, so a structurally inconsistent blueprint never reaches ratification:
 *   1. every blueprint object appears in the object→pattern map, and the map references only real objects;
 *   2. every mapped shape (and every object.target_shape) is a corpus pattern, and the two agree;
 *   3. every cross-object shared-group member resolves to a blueprint object (no dangling ref);
 *   4. every object.shared_ref resolves to a declared shared group.
 * Returns all violations (not just the first), fail-closed by construction. Grades only — never mutates.
 */
import { loadPatternCorpus } from "./patterns/match.js";

/**
 * @param {ReturnType<import("./app-blueprint.js").buildAppBlueprint>} blueprint
 * @param {{patterns: Array<{id: string}>}} [corpus]
 * @returns {{ok: boolean, violations: string[]}}
 */
export function checkBlueprint(blueprint, corpus = loadPatternCorpus()) {
  const violations = [];
  const patternIds = new Set(corpus.patterns.map((p) => p.id));
  const objects = blueprint.objects ?? [];
  const objectSigs = new Set(objects.map((o) => o.sig));
  const map = blueprint.object_to_pattern ?? {};

  // 1. object ⇔ map consistency
  for (const o of objects) {
    if (!(o.sig in map)) violations.push(`object '${o.sig}' is absent from the object→pattern map`);
  }
  for (const sig of Object.keys(map)) {
    if (!objectSigs.has(sig)) violations.push(`object→pattern map references '${sig}' which is not a blueprint object`);
  }

  // 2. shape ∈ corpus, and object.target_shape agrees with the map
  for (const [sig, shape] of Object.entries(map)) {
    if (!patternIds.has(shape)) violations.push(`object '${sig}' maps to '${shape}' which is not a corpus pattern`);
  }
  for (const o of objects) {
    if (!patternIds.has(o.target_shape)) violations.push(`object '${o.sig}' target_shape '${o.target_shape}' is not a corpus pattern`);
    if (o.sig in map && map[o.sig] !== o.target_shape) {
      violations.push(`object '${o.sig}' target_shape '${o.target_shape}' disagrees with the map '${map[o.sig]}'`);
    }
  }

  // 3. cross-object refs resolve; collect the declared shared-group ids
  const sharedIds = new Set();
  for (const kind of ["services", "projections", "fiori_apps"]) {
    for (const g of blueprint.shared?.[kind] ?? []) {
      sharedIds.add(g.id);
      for (const member of g.members ?? []) {
        if (!objectSigs.has(member)) violations.push(`shared ${kind} '${g.id}' references member '${member}' which is not a blueprint object`);
      }
    }
  }

  // 4. object.shared_ref → a declared shared group
  for (const o of objects) {
    for (const ref of o.shared_refs ?? []) {
      if (!sharedIds.has(ref)) violations.push(`object '${o.sig}' shared_ref '${ref}' resolves to no declared shared group`);
    }
  }

  return { ok: violations.length === 0, violations };
}
