/**
 * Plan-freeze ASSEMBLY (MODERNISER_DESIGN §3.1 / §3.3 / §6.3). Composes the whole offline
 * pipeline into ONE frozen, content-hashed, SELF-CONTAINED plan:
 *
 *   analyser doc → buildObjectGraph → scopeNodes (JOIN) → precedenceEdges (bottom-up,
 *   ratified 2026-07-11) → tarjanCondense → kahnLevels → plan nodes → freezePlan
 *
 * Everything load-bearing lives ON the hashed nodes (freezePlan hashes {nodes, waves} only):
 *   - `id` = the super-node's canonical_sig (smallest in-plan member's sig — §6.3);
 *   - `dependencies` = TRANSITIVE in-plan ancestor sigs, walked THROUGH out-of-plan nodes
 *     (a clean/SAP object between two plan objects transmits the constraint but is never
 *     scheduled — closure_green stays honest, L2, with NO loop-init discount needed);
 *   - `wave` = the super-node's bottom-up Kahn level over the FULL graph (a conservative
 *     static estimate for humans/transport grouping; live readiness is counter-based and
 *     may run earlier when the deeper deps are out-of-plan);
 *   - `conflict_keys` = SUPER-NODE-KEYED resource keys (§3.1 Stage 4 wiring contract —
 *     members' pools aggregated via `program_pools[]` so a break_gate node loses nothing);
 *   - `members` + `member_meta` (grade/complexity/blast per in-plan member) so the frontier
 *     can aggregate worst-member risk from the plan alone; `break_gate` from condensation.
 *
 * Pure. Deterministic (same doc → byte-identical plan incl. hash).
 *
 * @param {object} doc analyser-findings.json (read-only, P8)
 * @returns {{plan: object, runtime: {objectToSig: Record<string, string>}}}
 */
import { buildObjectGraph, precedenceEdges } from "../graph/build.js";
import { scopeNodes, scopeMeta } from "../node/scope.js";
import { tarjanCondense } from "../graph/condense.js";
import { kahnLevels } from "./levels.js";
import { buildConflictGraph } from "../graph/conflict.js";
import { freezePlan } from "./plan.js";

export function assemblePlan(doc, opts = {}) {
  const og = buildObjectGraph(doc);
  const scoped = scopeNodes(doc, og);
  const cond = tarjanCondense(og.nodes.map((n) => n.id), precedenceEdges(og.edges));
  const levels = kahnLevels(cond, scopeMeta(scoped));

  const scopedByObject = new Map(scoped.map((s) => [s.object, s]));
  const inPlanSupers = groupBySuper(scoped, cond.superOf);

  const sigOfSuper = new Map(); // superId -> plan-node sig (smallest in-plan member's sig)
  for (const [superId, members] of inPlanSupers) {
    sigOfSuper.set(superId, scopedByObject.get(members[0]).canonical_sig);
  }

  const conflictKeys = superConflictKeys(inPlanSupers, scopedByObject, sigOfSuper);
  const predecessors = predecessorMap(cond.edges);

  const nodes = [...inPlanSupers.entries()].map(([superId, members]) => {
    const superNode = cond.superNodes.find((s) => s.id === superId);
    const rep = scopedByObject.get(members[0]);
    return {
      id: sigOfSuper.get(superId),
      object: rep.object,
      kind: members.length > 1 ? "super" : "object",
      members: [...superNode.members].sort(),
      break_gate: superNode.break_gate,
      wave: levels.levelOf[superId],
      dependencies: inPlanAncestors(superId, predecessors, sigOfSuper),
      conflict_keys: conflictKeys[sigOfSuper.get(superId)],
      member_meta: Object.fromEntries(members.map((m) => [m, scopedByObject.get(m).meta])),
      parity_required: members.some((m) => scopedByObject.get(m).parity_required),
      transport_id: opts.transportOf?.[rep.object],
    };
  });

  const plan = freezePlan({
    nodes,
    session_budget: opts.session_budget ?? null,
    generator_team_size: opts.generator_team_size ?? null,
  });

  const objectToSig = {};
  for (const [superId, members] of inPlanSupers) {
    for (const m of members) objectToSig[m] = sigOfSuper.get(superId);
  }
  return { plan, runtime: { objectToSig } };
}

/** superId -> sorted IN-PLAN member objects (only supers containing at least one plan object). */
function groupBySuper(scoped, superOf) {
  const groups = new Map();
  for (const s of scoped) {
    const superId = superOf[s.object] ?? s.object;
    if (!groups.has(superId)) groups.set(superId, []);
    groups.get(superId).push(s.object);
  }
  for (const members of groups.values()) members.sort();
  return new Map([...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}

/** Super-node-keyed conflict keys (§3.1 Stage 4): members' resources aggregated per sig. */
function superConflictKeys(inPlanSupers, scopedByObject, sigOfSuper) {
  const conflictNodes = [...inPlanSupers.entries()].map(([superId, members]) => {
    const pools = new Set();
    const ddic = new Set();
    const locks = new Set();
    const nr = new Set();
    for (const m of members) {
      const rk = scopedByObject.get(m).resource_keys;
      if (rk.program_pool) pools.add(rk.program_pool);
      for (const d of rk.ddic ?? []) ddic.add(d);
      for (const l of rk.locks ?? []) locks.add(l);
      for (const r of rk.number_ranges ?? []) nr.add(r);
    }
    return { id: sigOfSuper.get(superId), program_pools: [...pools], ddic: [...ddic], locks: [...locks], number_ranges: [...nr] };
  });
  return buildConflictGraph(conflictNodes).keysOf;
}

/** superId -> its direct predecessor superIds over the condensed precedence edges (dep → dependent). */
function predecessorMap(edges) {
  const preds = new Map();
  for (const [u, v] of edges) {
    if (!preds.has(v)) preds.set(v, []);
    preds.get(v).push(u);
  }
  return preds;
}

/**
 * Nearest transitive IN-PLAN ancestors: walk predecessor edges back through out-of-plan
 * super-nodes; an in-plan ancestor is collected and not walked past. Iterative (scale NFR).
 */
function inPlanAncestors(superId, predecessors, sigOfSuper) {
  const found = new Set();
  const seen = new Set([superId]);
  const stack = [...(predecessors.get(superId) ?? [])];
  while (stack.length) {
    const p = stack.pop();
    if (seen.has(p)) continue;
    seen.add(p);
    if (sigOfSuper.has(p)) {
      found.add(sigOfSuper.get(p)); // in-plan: the constraint lands here, stop walking past it
    } else {
      for (const pp of predecessors.get(p) ?? []) stack.push(pp); // clean/SAP: transmit through
    }
  }
  return [...found].sort();
}
