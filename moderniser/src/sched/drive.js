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
import { nextDispatch, runComplete, dispatch, applyProgress, applyOutcome } from "./loop.js";
import { MAX_PHASE_RETRY_CYCLES } from "../state/node-status.js";

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

/**
 * Increment 2 (Option A): the driver OWNS retry-vs-ceiling. The fulfiller reports the SYNTAX
 * self-check outcome for `sig`; the driver orchestrates the reducer, counts the failed attempts
 * (`syntax_attempts` — a SEPARATE counter from the FSM post-verdict `cycle`, since a self-check
 * failure never reaches SYNTAX_OK so the FSM cycle never sees it — this is what the SKILL counted
 * "in prose"), decides, and returns the next action + the state to persist:
 *
 *   syntax_ok                     → advance `sig` to SYNTAX_OK (idempotent), then driveDecision
 *   syntax_fail | generator_error → bump syntax_attempts; below the ceiling re-issue the SAME node
 *                                   to regenerate ({generate, [{…, retry:true}]}); AT the ceiling
 *                                   quarantine it (BLOCK / SYNTAX_CEILING) then driveDecision
 *
 * The driver does NOT thread the repair brief — the fulfiller already holds it from its own
 * `lint-rules` call; `drive` only says "regenerate `<sig>`". The generation-counter/attestation
 * binding on a regenerate is deferred to Phase 3 (only matters once attestations exist), so a
 * retry rests the node at GENERATED without re-entering it. Pure over (plan, state).
 * @returns {{state: object, action: {action: string, packets?: object[], nodes?: any[]}}}
 */
export function driveReport(plan, state, sig, outcome) {
  if (state.status[sig] === undefined) throw new Error(`drive: unknown node ${sig}`);
  if (outcome === "syntax_ok") {
    const next = advanceToSyntaxOk(plan, state, sig);
    return { state: next, action: driveDecision(plan, next) };
  }
  // syntax_fail | generator_error — a failed generation attempt against the same node.
  const attempts = (state.syntax_attempts?.[sig] ?? 0) + 1;
  let next = ensureGenerated(plan, state, sig);
  next = { ...next, syntax_attempts: { ...next.syntax_attempts, [sig]: attempts } };
  if (attempts >= MAX_PHASE_RETRY_CYCLES) {
    next = applyOutcome(plan, next, sig, { status: "BLOCK", reason: "SYNTAX_CEILING" });
    return { state: next, action: driveDecision(plan, next) };
  }
  return { state: next, action: { action: "generate", packets: [{ ...packetOf(plan, sig), retry: true }] } };
}

/** Advance `sig` to SYNTAX_OK from wherever it rests (idempotent if a report is replayed). */
function advanceToSyntaxOk(plan, state, sig) {
  if (state.status[sig] === "SYNTAX_OK") return state; // idempotent report repeat
  const generated = ensureGenerated(plan, state, sig);
  return applyProgress(plan, generated, sig, "SYNTAX_OK"); // GENERATED → SYNTAX_OK
}

/** Bring `sig` to GENERATED along the forward chain (a no-op once it is already there). */
function ensureGenerated(plan, state, sig) {
  let next = state;
  if (next.status[sig] === "PENDING") next = dispatch(plan, next, [sig]); // PENDING → GROUNDED
  if (next.status[sig] === "GROUNDED") next = applyProgress(plan, next, sig, "GENERATED"); // GROUNDED → GENERATED
  return next;
}

function packetOf(plan, sig) {
  const n = plan.nodes.find((x) => x.id === sig);
  return { sig, object: n.object, wave: n.wave };
}
