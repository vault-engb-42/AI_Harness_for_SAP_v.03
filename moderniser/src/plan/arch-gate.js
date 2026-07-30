/**
 * The architecture gate wiring (BUILD_PLAN B3.5a, S12). Bridges the architecture manifest to the shared
 * escalation machinery: raises one ARCH_REVIEW per re_architect/rebuild node at PLAN TIME (after the
 * disposition gate, before the first `drive`), and records the operator's PARAMETRIZED decision
 * (approve | refine:<notes> | reject). On approve it binds the ratified `contract_hash` + the reviewer
 * verdict onto the decision — the ratification is OF a specific frozen contract, so a later contract edit
 * (new hash) forces re-ratification. Mirrors plan/disposition-gate.js. The judgment itself is produced
 * upstream (arch-reason.js, S14) and independently reviewed (abap-arch-reviewer); this file only gates the
 * human ratification — it renders no PASS and never grades the ratchet.
 */
import { raiseEscalation, resolveEscalation } from "../exception/escalation-bus.js";

/**
 * Raise one ARCH_REVIEW per architecture-manifest row (idempotent per node via the bus).
 * @param {{escalations: object[]}} register
 * @param {{rows: Array<{sig: string}>}} archManifest
 * @param {{ts: string}} meta
 * @returns {{escalations: object[]}} the new register
 */
export function raiseArchReviews(register, archManifest, { ts }) {
  let reg = register;
  for (const row of archManifest.rows ?? []) {
    reg = raiseEscalation(reg, { kind: "ARCH_REVIEW", node_ids: [row.sig] }, { ts });
  }
  return reg;
}

/**
 * Parse + validate a parametrized architecture decision (S12): approve | refine:<notes> | reject.
 * A bare `refine` (no notes) and any free-form token THROW (fail-closed).
 * @param {string} raw
 * @returns {{verb: "approve"} | {verb: "refine", notes: string} | {verb: "reject"}}
 */
export function parseArchDecision(raw) {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("arch-gate: empty decision");
  const i = raw.indexOf(":");
  const verb = (i < 0 ? raw : raw.slice(0, i)).trim();
  const param = i < 0 ? "" : raw.slice(i + 1).trim();
  if (verb === "approve") return { verb: "approve" };
  if (verb === "reject") return { verb: "reject" };
  if (verb === "refine") {
    if (!param) throw new Error("arch-gate: 'refine' requires operator notes (refine:<notes>)");
    return { verb: "refine", notes: param };
  }
  throw new Error(`arch-gate: decision '${verb}' is not approve | refine:<notes> | reject`);
}

/**
 * Record the operator's ARCH_REVIEW decision (dedicated parametrized recorder, S12). Fails closed on a
 * non-ARCH_REVIEW escalation, an unknown id, or a missing decider. On approve, binds the ratified
 * `contract_hash` + reviewer verdict onto the decision; a refine/reject ratifies nothing.
 * @param {{escalations: object[]}} register
 * @param {string} id
 * @param {string} raw
 * @param {{decided_by: string, ts: string, run_id?: string, contract_hash?: string, reviewer_verdict?: object}} meta
 * @returns {{escalations: object[]}} the new register
 */
export function recordArchDecision(register, id, raw, { decided_by, ts, run_id, contract_hash, reviewer_verdict }) {
  if (typeof decided_by !== "string" || !decided_by) throw new Error("arch-gate: decided_by (a named human) is required");
  const e = register.escalations.find((x) => x.id === id);
  if (!e) throw new Error(`arch-gate: unknown escalation '${id}'`);
  if (e.kind !== "ARCH_REVIEW") throw new Error(`arch-gate: '${id}' is a ${e.kind}, not an ARCH_REVIEW`);
  const decision = parseArchDecision(raw);
  const enriched = decision.verb === "approve"
    ? {
        ...decision,
        ...(contract_hash !== undefined ? { contract_hash } : {}),
        ...(reviewer_verdict !== undefined ? { reviewer_verdict } : {}),
      }
    : decision;
  return resolveEscalation(register, id, { resolved_by: decided_by, ts, decision: enriched, run_id });
}
