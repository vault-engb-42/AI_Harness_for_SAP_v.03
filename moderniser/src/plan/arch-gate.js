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
import { PATTERN_IDS } from "./patterns/match.js";
import { parseDispositionDecision } from "./disposition-gate.js";

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
 * Raise one NO_TARGET_SHAPE per UNPLACEABLE node (idempotent per node via the bus) — the gate for an object
 * `reasonArchitecture` could justify no shape for. It is the counterpart to raiseArchReviews above and
 * deliberately not the same kind: an ARCH_REVIEW asks a human to ratify a frozen Architecture Contract, and
 * an unplaceable node has none. Without this the manifest named the node and nothing else did: it held no
 * contract, so `isArchRatified` was permanently false and `drive` reported await_human/arch_ratification
 * against a gate that existed nowhere.
 * @param {{escalations: object[]}} register
 * @param {Array<{sig: string}>} unplaceable the arch manifest's `unplaceable` rows
 * @param {{ts: string}} meta
 * @returns {{escalations: object[]}} the new register
 */
export function raiseNoTargetShape(register, unplaceable, { ts }) {
  let reg = register;
  for (const row of unplaceable ?? []) {
    reg = raiseEscalation(reg, { kind: "NO_TARGET_SHAPE", node_ids: [row.sig] }, { ts });
  }
  return reg;
}

/**
 * Record the operator's NO_TARGET_SHAPE decision: override:<disposition> | other:<freeform>. Shares
 * `parseDispositionDecision` with the disposition gate because this gate's decision IS a disposition — the
 * remedy for an unplaceable object is to re-disposition it, and `collectOverrides` reads it back for
 * `replan`. `approve` parses there and is refused HERE: approving would resolve the gate while changing
 * nothing, leaving the node as unplaceable as before with a human's name on it — the deadlock, signed.
 * Fails closed on a non-NO_TARGET_SHAPE escalation, an unknown id, a missing decider, or an invalid form.
 * @returns {{escalations: object[]}} the new register
 */
export function recordNoTargetShapeDecision(register, id, raw, { decided_by, ts, run_id }) {
  if (typeof decided_by !== "string" || !decided_by) throw new Error("arch-gate: decided_by (a named human) is required");
  const e = register.escalations.find((x) => x.id === id);
  if (!e) throw new Error(`arch-gate: unknown escalation '${id}'`);
  if (e.kind !== "NO_TARGET_SHAPE") throw new Error(`arch-gate: '${id}' is a ${e.kind}, not a NO_TARGET_SHAPE`);
  // `shape:<id>` — a HUMAN-SUPPLIED target shape, the option the gate used to lack (operator, 2026-09-14).
  //
  // Without it the only ways out of "no shape fits" were to stop re-architecting (override) or to say the
  // corpus is missing a pattern (other). Choosing re_architect anyway just re-entered the deadlock, because
  // nothing could supply the shape the matcher would not derive — so the harness had quietly narrowed the
  // operator's options to what it could itself justify. Measured on abap_fico: all six unplaceable objects
  // had been fully re-architected in an earlier demo, two to complete RAP BOs with OData bindings.
  //
  // THE MATCHER IS NOT WEAKENED. It still derives no shape from silence, which is what RC-2 earned. This is
  // a NAMED HUMAN overruling a stated objection, recorded as `source: "human"` so nothing downstream can
  // present the shape as evidence-derived.
  const shape = parseShapeDecision(raw);
  if (shape) return resolveEscalation(register, id, { resolved_by: decided_by, ts, decision: shape, run_id });

  const decision = parseDispositionDecision(raw);
  if (decision.verb === "approve") {
    throw new Error("arch-gate: 'approve' is not a NO_TARGET_SHAPE decision — there is no shape to approve; re-disposition it (override:<disposition>), supply a shape yourself (shape:<id>), or record why the corpus is missing one (other:<text>)");
  }
  return resolveEscalation(register, id, { resolved_by: decided_by, ts, decision, run_id });
}

/**
 * `shape:<id>` → the human-supplied target-shape decision, or null when this is not one.
 *
 * CLOSED OVER THE CORPUS, deliberately. Overruling the matcher's objection is a legitimate human judgement;
 * naming a shape the corpus cannot build is not a judgement but a typo or a wish, and it would freeze a
 * contract the generator has no pattern for. That case has its own verb: `other:<why the corpus is missing
 * a shape>`, which re-dispositions nothing and records the gap.
 */
function parseShapeDecision(raw) {
  if (typeof raw !== "string") return null;
  const i = raw.indexOf(":");
  const verb = (i < 0 ? raw : raw.slice(0, i)).trim();
  if (verb !== "shape") return null;
  const target_shape = i < 0 ? "" : raw.slice(i + 1).trim();
  if (!target_shape) {
    throw new Error(`arch-gate: 'shape' needs an id — shape:<${PATTERN_IDS.join("|")}>`);
  }
  if (!PATTERN_IDS.includes(target_shape)) {
    throw new Error(
      `arch-gate: '${target_shape}' is not a target shape in the patterns corpus [${PATTERN_IDS.join(", ")}] — `
      + "a human may overrule the matcher's objection, but not name a shape the generator has no pattern for; "
      + "if the corpus is genuinely missing one, record that with other:<why>",
    );
  }
  return { verb: "shape", target_shape, source: "human" };
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
