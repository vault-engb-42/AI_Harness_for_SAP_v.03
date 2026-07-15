/**
 * The deterministic DRIVER stepper (MODERNISER_DRIVER_AND_GAP2_DESIGN Phase 2). Given the frozen
 * plan and the durable run state, it returns the ONE next action the fulfiller must take — the
 * process reasoning that used to live in `/modernise` SKILL prose, now typed, tested code. The
 * fulfiller performs the action (spawn the generator, write artifacts, run SELF_CHECK, report the
 * outcome via the granular verbs), then calls `drive` again. Pure over (plan, state).
 *
 *   { action: "generate", packets: [{sig, object, wave}, …] }   ready frontier — ground+generate+self-check these
 *   { action: "await_human", nodes: [sig, …] }                  a human gate blocks progress (seam / park)
 *   { action: "provisional_complete" }                          offline: every node rested or a starved sweep target
 *   { action: "complete" }                                      online: every node GREEN
 *   { action: "blocked", nodes: [{sig, status}, …] }            a wedged node that is neither dispatchable nor rested — fail-closed surface
 *
 * Offline NEVER GREENs (P6), so the offline exit is `provisional_complete` (→ the draft sweep +
 * proof bundle), never `complete`. A starved PENDING dependent (indegree > 0, its dep never
 * GREENed offline) is a sweep target, not a wedge — only a genuinely stuck node is `blocked`.
 */
import { nextDispatch, runComplete } from "./loop.js";

// The states a node may legitimately rest in when the frontier is empty (offline or terminal).
const RESTED = new Set(["GREEN", "SYNTAX_OK", "PROVISIONAL_GATED", "BLOCK", "PARK", "NEEDS_MANUAL_SEAM"]);

/** A starved dependent (PENDING, still waiting on a non-GREEN dep) — a sweep target, not a wedge. */
const isStarved = (state, id) => state.status[id] === "PENDING" && (state.indegree[id] ?? 0) > 0;

/**
 * @param {object} plan a frozen assemblePlan().plan
 * @param {object} state a SchedulerState (initRun + reducer moves)
 * @returns {{action: string, packets?: object[], nodes?: any[]}}
 */
export function driveDecision(plan, state) {
  if (runComplete(plan, state)) return { action: "complete" };

  const frontier = nextDispatch(plan, state);
  if (frontier.length > 0) {
    return { action: "generate", packets: frontier.map((sig) => packetOf(plan, sig)) };
  }

  // Frontier is empty and the run is not complete. A human gate (a parked node awaiting its
  // successor, or a dynamic-sealed node awaiting caller-set confirmation) takes priority.
  const parked = (state.park_register ?? []).map((p) => p.sig);
  const seamed = plan.nodes
    .filter((n) => state.status[n.id] === "NEEDS_MANUAL_SEAM" || (n.dynamic_seal === "NEEDS_MANUAL_SEAM" && state.status[n.id] === "PENDING"))
    .map((n) => n.id);
  const humanGated = [...new Set([...parked, ...seamed])];
  if (humanGated.length > 0) return { action: "await_human", nodes: humanGated };

  // No human gate: the gated pass is done iff every node is rested or a starved sweep target.
  const wedged = plan.nodes.filter((n) => !RESTED.has(state.status[n.id]) && !isStarved(state, n.id));
  if (wedged.length === 0) return { action: "provisional_complete" };
  return { action: "blocked", nodes: wedged.map((n) => ({ sig: n.id, status: state.status[n.id] })) };
}

function packetOf(plan, sig) {
  const n = plan.nodes.find((x) => x.id === sig);
  return { sig, object: n.object, wave: n.wave };
}
