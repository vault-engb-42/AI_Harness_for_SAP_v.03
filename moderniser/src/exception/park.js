/**
 * PARK register (MODERNISER_DESIGN §3.4 #5, L7) — bounded, audited, DISTINCT from a P4
 * waiver. A node leaves its level's green requirement ONLY when the block reason is
 * deterministically NO_RELEASED_SUCCESSOR, with a NAMED human sign-off + justification
 * (§3.4 #6 `park-register.json` row shape). Parked nodes re-enter scheduling when the
 * cloudification registry ships the probed successor. Pure copy-on-write; ts injected.
 *
 * Scheduling-side parking (status FSM, frontier exclusion) lives in `sched/loop`; this
 * module owns the AUDITED register the loop's park entries are justified by.
 */

/**
 * @param {{parked: object[]}} register
 * @param {string} nodeId canonical sig
 * @param {{reason: string, signed_by: string, justification: string, successor_probe?: string, ts: string}} signoff
 * @returns {{parked: object[]}} the new register
 */
export function tryPark(register, nodeId, { reason, signed_by, justification, successor_probe, ts }) {
  if (reason !== "NO_RELEASED_SUCCESSOR") {
    throw new Error(`park: refused — only the deterministic NO_RELEASED_SUCCESSOR class parks (got '${reason}'; a defect BLOCK never parks, L7)`);
  }
  if (typeof signed_by !== "string" || signed_by.length === 0) throw new Error("park: a NAMED human sign-off is required");
  if (typeof justification !== "string" || justification.length === 0) throw new Error("park: a justification is required");
  if (register.parked.some((p) => p.node_id === nodeId)) throw new Error(`park: ${nodeId} is already parked`);
  return {
    ...register,
    parked: [
      ...register.parked,
      { node_id: nodeId, reason, signed_by, justification, successor_probe: successor_probe ?? null, parked_at: ts },
    ],
  };
}

/**
 * Release the nodes whose probed successor is now available (re-checked each run, §3.4 #5).
 * @param {{parked: object[]}} register
 * @param {{available: Set<string>}} probe the cloudification-registry probe result
 * @returns {{register: {parked: object[]}, reentered: string[]}}
 */
export function reEnter(register, { available }) {
  const reentered = register.parked
    .filter((p) => p.successor_probe !== null && available.has(p.successor_probe))
    .map((p) => p.node_id)
    .sort();
  if (reentered.length === 0) return { register, reentered };
  const gone = new Set(reentered);
  return { register: { ...register, parked: register.parked.filter((p) => !gone.has(p.node_id)) }, reentered };
}
