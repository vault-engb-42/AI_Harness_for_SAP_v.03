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
import { uiCapable } from "./blueprint-conformance.js";

/**
 * Decline the Fiori-app enrolments that cannot render, so ONE bad cross-object claim costs only itself.
 *
 * `shared` rides EACH judge recommendation and is unioned across all of them, so one verdict can say "A and
 * B are one Fiori app" while A's own verdict says A is headless. Both pass the writer guard (`validateShared`
 * — members are arch-gated plan sigs) and the plan-fit filter (`sharedFitsPlan` — members are resolved);
 * only the JOINT reading violates tier 5. Reproduced on the grouping fixture: `arch` threw before writing the
 * manifest, so all three nodes lost their contracts, `arch-verdict` had no pending request to serve, and the
 * offending verdict stayed in the CROSS-RUN cache — every re-run threw identically, with no verb able to
 * recover the run. That is the same unrecoverable state V1/V1b closed, reached through a different door.
 *
 * Narrow by construction. Only a Fiori app's membership is repairable, because "this object has no UI" is a
 * fact about the object that the app cannot override; a headless BO behind an OData service or a shared
 * projection is ordinary and is left alone. A member with NO assignment is left alone too — that is a
 * dangling ref, and repairing it here would hide the inconsistency tier 3 exists to refuse.
 *
 * @param {{services?: object[], projections?: object[], fiori_apps?: object[]}} shared the merged groupings
 * @param {Array<{sig: string, target_shape: string}>} assignments the resolved object→shape assignment
 * @returns {{shared: object, pruned: Array<{kind: string, group: string, member: string, shape: string}>}}
 */
export function pruneUnrenderable(shared, assignments, corpus = loadPatternCorpus()) {
  const shapeOf = new Map((assignments ?? []).map((a) => [a.sig, a.target_shape]));
  const pruned = [];
  const fiori_apps = [];
  for (const g of shared?.fiori_apps ?? []) {
    const keep = [];
    for (const member of g.members ?? []) {
      const shape = shapeOf.get(member);
      if (shape !== undefined && !uiCapable(shape, corpus)) pruned.push({ kind: "fiori_apps", group: g.id, member, shape });
      else keep.push(member);
    }
    // An app with no renderable member is not an app. Keeping an empty shell would leave the human ratifying
    // a grouping with nothing in it, and `groupingDecision` offering membership of it.
    if (keep.length > 0) fiori_apps.push({ ...g, members: keep });
  }
  return { shared: { ...shared, fiori_apps }, pruned };
}

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
