/**
 * The PURE app-level decomposer (BUILD_PLAN S11 two-level reasoning / MODERNISER_DESIGN §6.13).
 *
 * The planner reasons at the APP level first (an app blueprint: object→pattern assignment + cross-object
 * structure — one OData service fronting several BOs, dynpro screens collapsed into one Fiori app, shared
 * CDS projections), then DECOMPOSES it into per-object contract stubs. `buildAppBlueprint` takes that
 * app-level VERDICT (a fulfiller artifact — deterministic for single-candidate nodes, judge-selected for
 * the escalated subset, S14) and produces the per-object stubs + a flat object→pattern map, resolving each
 * object's components from the patterns corpus and the cross-object groups it belongs to.
 *
 * Pure, deterministic, canonically ordered (objects sorted by sig; shared groups + members sorted) so it
 * hashes stably. Fails closed on a shape outside the corpus or a duplicate sig — the verdict must reference
 * the closed target_shape vocabulary. `blueprint-conformance.js` proves internal consistency before freeze.
 */
import { loadPatternCorpus } from "./patterns/match.js";

/**
 * @param {{app_id?: string, assignments: Array<{sig: string, target_shape: string, rationale?: string}>, shared?: {services?: Array<{id: string, members: string[]}>, projections?: Array<{id: string, members: string[]}>, fiori_apps?: Array<{id: string, members: string[]}>}}} verdict
 * @param {{patterns: Array<{id: string, components: string[]}>}} [corpus]
 * @returns {{app_id: string|null, object_to_pattern: Record<string, string>, objects: Array<{sig: string, target_shape: string, components: string[], shared_refs: string[], rationale?: string}>, shared: {services: Array<{id: string, members: string[]}>, projections: Array<{id: string, members: string[]}>, fiori_apps: Array<{id: string, members: string[]}>}}}
 */
export function buildAppBlueprint(verdict, corpus = loadPatternCorpus()) {
  const byId = new Map(corpus.patterns.map((p) => [p.id, p]));
  const shared = normalizeShared(verdict.shared);
  const sharedRefsBySig = sharedRefsBySigOf(shared);

  const seen = new Set();
  const objects = [];
  for (const a of verdict.assignments ?? []) {
    if (seen.has(a.sig)) throw new Error(`app-blueprint: duplicate sig '${a.sig}' in the verdict`);
    seen.add(a.sig);
    const pat = byId.get(a.target_shape);
    if (!pat) throw new Error(`app-blueprint: '${a.target_shape}' is not a corpus target_shape (sig ${a.sig})`);
    objects.push({
      sig: a.sig,
      target_shape: a.target_shape,
      components: [...pat.components],
      shared_refs: (sharedRefsBySig.get(a.sig) ?? []).slice().sort(),
      ...(a.rationale ? { rationale: a.rationale } : {}),
    });
  }
  objects.sort((x, y) => (x.sig < y.sig ? -1 : x.sig > y.sig ? 1 : 0));

  const object_to_pattern = {};
  for (const o of objects) object_to_pattern[o.sig] = o.target_shape;

  return { app_id: verdict.app_id ?? null, object_to_pattern, objects, shared };
}

/** Canonicalise the cross-object groups: members sorted, groups sorted by id. */
function normalizeShared(shared) {
  const groups = (arr) => [...(arr ?? [])]
    .map((g) => ({ id: g.id, members: [...(g.members ?? [])].sort() }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    services: groups(shared?.services),
    projections: groups(shared?.projections),
    fiori_apps: groups(shared?.fiori_apps),
  };
}

/** sig → the sorted ids of the shared groups it is a member of. */
function sharedRefsBySigOf(shared) {
  const m = new Map();
  for (const kind of ["services", "projections", "fiori_apps"]) {
    for (const g of shared[kind]) {
      for (const sig of g.members) {
        if (!m.has(sig)) m.set(sig, []);
        m.get(sig).push(g.id);
      }
    }
  }
  return m;
}
