/**
 * Pure derivations of the FROZEN plan — the read-only views the scheduler needs but that carry no run state
 * and take no part in the reducer's copy-on-write discipline. Split out of loop.js so the reducer file holds
 * only state transitions and stays within the file-size limit.
 */

/** dep → dependent edge pairs, derived from the hashed node dependencies. */
export function refEdges(plan) {
  const edges = [];
  for (const n of plan.nodes) for (const d of n.dependencies ?? []) edges.push([d, n.id]);
  return edges;
}

/** member-object-keyed meta for the frontier's worst-member aggregation. */
export function metaByMember(plan) {
  const meta = {};
  for (const n of plan.nodes) for (const [m, v] of Object.entries(n.member_meta ?? {})) meta[m] = v;
  return meta;
}

/** The transport a node activates on — its own implicit one when it declares none (L4 mutex key). */
export function transportOf(plan, sig) {
  const n = plan.nodes.find((x) => x.id === sig);
  if (!n) throw new Error(`loop: unknown node ${sig}`);
  return n.transport_id ?? `own:${sig}`;
}
