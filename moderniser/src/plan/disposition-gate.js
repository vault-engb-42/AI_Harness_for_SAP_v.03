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
