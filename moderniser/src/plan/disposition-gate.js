/**
 * The disposition gate wiring (BUILD_PLAN B3, S1/S2). Bridges the disposition manifest to the shared
 * escalation machinery: raises one DISPOSITION_REVIEW per PROMPTED node (autonomy=prompt) at PLAN TIME
 * (after plan freeze, before the first `drive` — NOT the `drive` await_human branch, S1), and records the
 * operator's PARAMETRIZED decision (approve | override:<disposition> | other:<freeform>), validating an
 * override against the disposition enum allowlist. `autonomy=auto` rows raise no escalation.
 */
import { raiseEscalation, resolveEscalation } from "../exception/escalation-bus.js";
import { DISPOSITIONS, isDisposition } from "./disposition-enum.js";

/**
 * Raise one DISPOSITION_REVIEW escalation per prompted manifest row (idempotent per node via the bus).
 * @param {{escalations: object[]}} register
 * @param {{rows: Array<{sig: string, autonomy: string, confidence?: number}>}} manifest
 * @param {{ts: string}} meta
 * @returns {{escalations: object[]}} the new register
 */
export function raiseDispositionReviews(register, manifest, { ts }) {
  let reg = register;
  for (const row of manifest.rows) {
    if (row.autonomy !== "prompt") continue;
    reg = raiseEscalation(reg, { kind: "DISPOSITION_REVIEW", node_ids: [row.sig], confidence: row.confidence }, { ts });
  }
  return reg;
}

/**
 * DROPPED-DEPENDENCY detection (§7.4, operator-ratified 2026-08-05). PURE over the frozen plan.
 *
 * A run-completing terminal releases its dependents' readiness counter, and RETIRED is one — so dropping B
 * lets A, which still depends on B, proceed to be built against something that will not exist. The ruling
 * was to ALLOW that (the human may know the call is dead, or intend to adapt A) but to make the consequence
 * visible at the plan gate, where it can still be acted on, rather than let it surface far from its cause as
 * an ATC or syntax failure on a generated object.
 *
 * `dependencies` are the NEAREST in-plan ancestors — `inPlanAncestors` (assemble.js) stops at the first
 * in-plan node and walks only THROUGH out-of-plan ones. That is exactly the right relation here, and
 * deliberately so: this predicate is the SAME one `releaseDependents` (sched/terminals.js) and the indegree
 * initialiser use, so the nodes reported are precisely the nodes whose readiness the drop releases. A
 * dependent reached through a SURVIVING in-plan node is not released by the drop and is not reported; if
 * that intermediary is itself retired, the dependent appears under the intermediary's own row.
 *
 * (An earlier docblock here claimed full transitive coverage. It was wrong, and a maintainer trusting the
 * stated reason would make the wrong call the first time these two predicates are asked to diverge.)
 *
 * A dependent that is ITSELF retired is not reported: dropping a whole cluster is coherent, and reporting
 * it would bury the real cases in noise.
 *
 * @param {{nodes: Array<{id: string, object: string, disposition?: string, dependencies?: string[]}>}} plan
 * @returns {Array<{retired: string, object: string, dependents: string[]}>} ordered by retired sig
 */
export function droppedDependencies(plan) {
  // Indexed by dependency, ONCE. The scan-all-nodes-per-retired-node shape was O(retired × nodes × closure)
  // — 4.9s at 10k nodes / 1k drops / 200 deps per node, against a stated 100K+ LOC NFR. This is one pass.
  const dependentsOf = new Map();
  for (const n of plan.nodes) {
    if (n.disposition === "retire") continue; // a dropped cluster is coherent — see the docblock
    for (const d of n.dependencies ?? []) {
      if (!dependentsOf.has(d)) dependentsOf.set(d, []);
      dependentsOf.get(d).push(n.id);
    }
  }
  const out = [];
  for (const r of plan.nodes.filter((n) => n.disposition === "retire").sort(byId)) {
    const dependents = (dependentsOf.get(r.id) ?? []).slice().sort();
    if (dependents.length > 0) out.push({ retired: r.id, object: r.object, dependents });
  }
  return out;
}

/**
 * Raise one DROPPED_DEPENDENCY per dropped object that in-plan work still depends on (idempotent per the
 * bus). The dropped sig rides `node_ids` as well as `root_signature`: the register keys an escalation id on
 * (kind, node_ids), so reporting only the dependents would give two drops that share a dependent the SAME
 * id — the second would dedupe into the first and one dropped object would never reach the human.
 */
export function raiseDroppedDependencies(register, plan, { ts }) {
  let reg = register;
  for (const { retired, dependents } of droppedDependencies(plan)) {
    reg = raiseEscalation(reg, { kind: "DROPPED_DEPENDENCY", node_ids: [retired, ...dependents], root_signature: retired }, { ts });
  }
  return reg;
}

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Parse + validate a parametrized disposition decision (S2): approve | override:<disposition> | other:<text>.
 * @param {string} raw
 * @returns {{verb: "approve"} | {verb: "override", disposition: string} | {verb: "other", freeform: string}}
 */
export function parseDispositionDecision(raw) {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("disposition-gate: empty decision");
  const i = raw.indexOf(":");
  const verb = (i < 0 ? raw : raw.slice(0, i)).trim();
  const param = i < 0 ? "" : raw.slice(i + 1).trim();
  if (verb === "approve") return { verb: "approve" };
  if (verb === "override") {
    if (!isDisposition(param)) throw new Error(`disposition-gate: override target '${param}' is not a disposition [${DISPOSITIONS}]`);
    return { verb: "override", disposition: param };
  }
  if (verb === "other") {
    if (!param) throw new Error("disposition-gate: 'other' requires an operator instruction (other:<text>)");
    return { verb: "other", freeform: param };
  }
  throw new Error(`disposition-gate: decision '${verb}' is not approve | override:<disposition> | other:<text>`);
}

/**
 * Record the operator's DISPOSITION_REVIEW decision (dedicated parametrized recorder, S2). Fails closed on a
 * non-DISPOSITION_REVIEW escalation, an unknown id, a missing decider, or an invalid parametrized form.
 * @returns {{escalations: object[]}} the new register
 */
export function recordDispositionDecision(register, id, raw, { decided_by, ts, run_id }) {
  if (typeof decided_by !== "string" || !decided_by) throw new Error("disposition-gate: decided_by (a named human) is required");
  const e = register.escalations.find((x) => x.id === id);
  if (!e) throw new Error(`disposition-gate: unknown escalation '${id}'`);
  if (e.kind !== "DISPOSITION_REVIEW") throw new Error(`disposition-gate: '${id}' is a ${e.kind}, not a DISPOSITION_REVIEW`);
  const decision = parseDispositionDecision(raw);
  return resolveEscalation(register, id, { resolved_by: decided_by, ts, decision, run_id });
}
