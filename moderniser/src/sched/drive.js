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
 *   { action: "complete" }                                      live: every node GREEN
 *   { action: "blocked", nodes: [{sig, status}, …] }            a wedged node that is neither dispatchable nor rested — fail-closed surface
 *
 * Offline NEVER GREENs (P6), so the offline exit is `provisional_complete` (→ the draft sweep +
 * proof bundle), never `complete`. A starved PENDING dependent (indegree > 0, its dep never
 * GREENed offline) is a sweep target, not a wedge — only a genuinely stuck node is `blocked`.
 */
import { nextDispatch, runComplete, dispatch, applyProgress, applyOutcome } from "./loop.js";
import { recordProvisionalVerdict } from "./verdict-ops.js";
import { MAX_PHASE_RETRY_CYCLES, isActive } from "../state/node-status.js";
import { isArchRatified, ARCH_GATED_DISPOSITIONS } from "../plan/arch-contract.js";

// The states a node may legitimately rest in when the frontier is empty (offline or terminal). Includes the
// B4 disposition-route terminals (RETIRED / REBUILT_HANDOFF) — else a retired/handed-off node would satisfy
// neither RESTED nor runComplete and driveDecision would wedge the run forever.
const RESTED = new Set(["GREEN", "SYNTAX_OK", "PROVISIONAL_GATED", "BLOCK", "PARK", "NEEDS_MANUAL_SEAM", "RETIRED", "REBUILT_HANDOFF"]);

/**
 * An arch-gated node is waiting on ratification iff it could otherwise make progress: either it is PENDING
 * with a green closure (never entered), or it is IN FLIGHT at a non-terminal, non-resting status and can no
 * longer advance because its ratification was voided. A PENDING node still waiting on its dependencies is a
 * starved sweep target, not an arch gate.
 */
const isAwaitingArch = (state, id) => {
  const status = state.status[id];
  if (status === "PENDING") return (state.indegree[id] ?? 0) === 0;
  return isActive(status) && !RESTED.has(status);
};

/** A starved dependent (PENDING, still waiting on a non-GREEN dep) — a sweep target, not a wedge. */
const isStarved = (state, id) => state.status[id] === "PENDING" && (state.indegree[id] ?? 0) > 0;

/**
 * @param {object} plan a frozen assemblePlan().plan
 * @param {object} state a SchedulerState (initRun + reducer moves)
 * @returns {{action: string, packets?: object[], nodes?: any[]}}
 */
export function driveDecision(plan, state) {
  if (runComplete(plan, state)) return { action: "complete" };

  // The frontier already EXCLUDES arch-gated nodes awaiting ratification (M5: excluded before the team-size
  // cap, so they never occupy a slot and starve dispatchable work).
  const frontier = nextDispatch(plan, state);
  if (frontier.length > 0) return { action: "generate", packets: frontier.map((sig) => packetOf(plan, sig)) };

  // Nothing is dispatchable. An arch-gated node that is not ratified is not wedged — it is waiting on the
  // human ARCH_REVIEW ratification (B4 fail-closed precondition), so name that gate rather than reporting a
  // wedge the operator cannot act on. This covers BOTH a node that never entered (PENDING with a green
  // closure) and one whose ratification was VOIDED mid-flight by a reject/refine (A) — the latter can no
  // longer advance, so without this it would read as a wedge.
  const awaitingArch = plan.nodes
    .filter((n) => ARCH_GATED_DISPOSITIONS.has(n.disposition) && !isArchRatified(state, n.id) && isAwaitingArch(state, n.id))
    .map((n) => n.id);
  if (awaitingArch.length > 0) return { action: "await_human", nodes: awaitingArch, reason: "arch_ratification" };

  // Frontier is empty and the run is not complete. A human gate (a parked node awaiting its
  // successor, or a dynamic-sealed node awaiting caller-set confirmation) takes priority.
  const parked = (state.park_register ?? []).map((p) => p.sig);
  const seamed = plan.nodes
    .filter((n) => state.status[n.id] === "NEEDS_MANUAL_SEAM" || (n.dynamic_seal === "NEEDS_MANUAL_SEAM" && state.status[n.id] === "PENDING"))
    .map((n) => n.id);
  // A node resting at PROVISIONAL_GATED with a RECORDED FAILING verdict is not rested — it is
  // waiting on the attestation that `driveOfflineVerdict` escalated for (B6.5 F8). Without this the
  // run reported `provisional_complete` on the very next step and the proof bundle declared an
  // unattested authorization change complete. An ABSENT verdict is a node that has not been
  // verdicted yet, which is a different state and stays rested.
  const awaitingAttestation = plan.nodes
    .filter((n) => state.status[n.id] === "PROVISIONAL_GATED" && state.verdict_provisional?.[n.id] === false)
    .map((n) => n.id);
  const humanGated = [...new Set([...parked, ...seamed, ...awaitingAttestation])];
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

/**
 * gap-2b B6 — the OFFLINE verdict step, the offline sibling of the live push→activate→gate arc.
 * The fulfiller has already passed the gap-2a rule gate, extracted the before/after bundles and
 * rendered the verdict (`renderOfflineNodeVerdict`); it hands the RESULT here. Keeping the render
 * outside means the scheduler stays pure over (plan, state, result) and never imports the extractor.
 *
 * Advances SYNTAX_OK → PROVISIONAL_GATED, records the verdict there, then decides. The decision
 * turns on a distinction the reason list makes but a naive driver would miss: AN OFFLINE BLOCK IS
 * NOT ONE THING.
 *   - A DEFECT (ATC priority-1/-2, a broken P4 invariant, lost auth coverage, a parity veto or
 *     scope_reduced) is what regeneration exists for → regenerate WITH the findings, cycle-gated,
 *     quarantining at the ceiling.
 *   - An OWED ATTESTATION (`auth-delta-unattested`, the `needs_review` parity band) is not fixable
 *     by any amount of regeneration — no rewrite produces a security reviewer's signature. Routing
 *     it through the retry loop would burn the entire cycle budget and land a false ceiling BLOCK
 *     on EVERY classic→managed-RAP node, because relocating authorization to DCL always sets
 *     auth_delta on the first pass. So it rests at PROVISIONAL_GATED with the budget untouched and
 *     escalates to the human gate that can actually clear it.
 *
 * A defect OUTRANKS an owed attestation when both are present: attesting a defective artifact is
 * meaningless, so fix first and attest the fixed thing.
 *
 * Escalations are RETURNED as intent, never raised here — raising touches the durable register,
 * which is the CLI's job; this stays pure.
 *
 * @param {object} plan @param {object} state @param {string} sig
 * @param {{provisional: boolean, reasons: string[]}} result from `renderOfflineNodeVerdict`
 * @returns {{state: object, action: object}}
 */
export function driveOfflineVerdict(plan, state, sig, result) {
  if (state.status[sig] === undefined) throw new Error(`drive: unknown node ${sig}`);
  let next = state.status[sig] === "PROVISIONAL_GATED" ? state : applyProgress(plan, state, sig, "PROVISIONAL_GATED");
  next = recordProvisionalVerdict(plan, next, sig, result);
  if (result.provisional === true) return { state: next, action: driveDecision(plan, next) };

  const reasons = result.reasons ?? [];
  const escalations = ESCALATABLE.filter(([reason]) => reasons.includes(reason)).map(([, kind]) => ({ kind, node_ids: [sig] }));
  const onlyAttestable = escalations.length > 0 && reasons.every((r) => ATTESTABLE.has(r));
  if (onlyAttestable) return { state: next, action: { action: "await_human", nodes: [sig], escalations } };

  if ((next.cycle[sig] ?? 0) >= MAX_PHASE_RETRY_CYCLES) {
    next = applyOutcome(plan, next, sig, { status: "BLOCK", reason: "OFFLINE_VERDICT_CEILING" });
    return { state: next, action: driveDecision(plan, next) };
  }
  next = applyProgress(plan, next, sig, "GENERATED"); // the cycle-gated offline retry edge
  return { state: next, action: { action: "generate", packets: [{ ...packetOf(plan, sig), retry: true, findings: reasons }] } };
}

// The only two offline BLOCK reasons a human — not a regeneration — can clear. Sorted by kind so
// the escalation list is deterministic. Every OTHER reason, vetoes and scope_reduced included, is a
// defect: parity vetoes are NEVER attestable (§7.5).
const ESCALATABLE = Object.freeze([
  ["auth-delta-unattested", "AUTH_EQUIVALENCE"],
  ["parity-not-equivalent:needs_review", "PARITY_REVIEW"],
]);
const ATTESTABLE = new Set(ESCALATABLE.map(([reason]) => reason));

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
