/**
 * PURE structural evidence for one cross-object GROUP, so the human ratifying a grouping is shown what the
 * judge's claim rests on rather than only the claim.
 *
 * "These eight objects become one Fiori app" is the largest architectural call a run makes, and the
 * independent ARCH_REVIEW of the TALV blueprint found two ways it can be wrong while every conformance tier
 * passes: a member with no structural relationship to any other member (ZAESOP_LOG_DEMO, a logging demo),
 * and a group organised around a hub that is `disposition: seal` and therefore can never BE a member
 * (ZCL_TALV_PARENT) — "the blueprint names the shell and structurally cannot name the core".
 *
 * Neither is something the harness may decide. Two independent screens can legitimately be one app, and a
 * sealed hub is a correct disposition, not a defect. What was wrong is that the human ratified with none of
 * it in front of them. This module computes the evidence; `arch-row.js` attaches it to the decision.
 *
 * The adjacency is the PLAN's own `dependencies` — sig-level, already derived from the CPG — read
 * UNDIRECTED, because "is connected to" is symmetric: a caller and its callee are equally each other's
 * evidence of belonging together.
 */

/**
 * @param {{nodes: Array<{id: string, dependencies?: string[]}>}} plan the frozen plan
 * @returns {Map<string, Set<string>>} sig → adjacent sigs (every plan node present, possibly empty)
 */
export function buildAdjacency(plan) {
  const adj = new Map();
  const link = (a, b) => {
    if (!adj.has(a)) adj.set(a, new Set());
    if (b !== undefined && b !== a) adj.get(a).add(b);
  };
  for (const n of plan?.nodes ?? []) link(n.id);
  for (const n of plan?.nodes ?? []) {
    for (const dep of n.dependencies ?? []) {
      if (!adj.has(dep)) continue; // a dependency outside this plan is not adjacency evidence within it
      link(n.id, dep);
      link(dep, n.id);
    }
  }
  return adj;
}

/**
 * How connected is ONE member to the rest of its group? `isolated` is the flag worth reading: it says this
 * object shares no structural edge with anything else the judge put it with. A single-member group is never
 * isolated — there is nothing to be isolated from, and flagging it would be noise at a gate.
 *
 * @returns {{members: number, linked_members: number, isolated: boolean}}
 */
export function groupEvidence(sig, group, adjacency) {
  const members = new Set(group?.members ?? []);
  const neighbours = adjacency.get(sig) ?? new Set();
  let linked = 0;
  for (const m of members) if (m !== sig && neighbours.has(m)) linked += 1;
  return { members: members.size, linked_members: linked, isolated: members.size > 1 && linked === 0 };
}

/**
 * The strongest NON-member the group is organised around, or null. Ties resolve by sig so two runs over the
 * same plan never disagree.
 *
 * @returns {{sig: string, object: string|null, disposition: string|null, links: number}|null}
 */
export function groupHub(group, plan, adjacency) {
  const members = new Set(group?.members ?? []);
  const counts = new Map();
  for (const m of members) {
    for (const nb of adjacency.get(m) ?? []) {
      if (members.has(nb)) continue;
      counts.set(nb, (counts.get(nb) ?? 0) + 1);
    }
  }
  // One shared neighbour is coincidence, not a centre; a hub is what several members organise around.
  const ranked = [...counts.entries()]
    .filter(([, links]) => links > 1)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  if (ranked.length === 0) return null;
  const [sig, links] = ranked[0];
  const node = (plan?.nodes ?? []).find((n) => n.id === sig);
  return { sig, object: node?.object ?? null, disposition: node?.disposition ?? null, links };
}
