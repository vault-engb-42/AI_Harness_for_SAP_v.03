/**
 * Node-state status FSM (MODERNISER_DESIGN §6.3, L9). The single source of truth for a
 * node's lifecycle — supersedes the illustrative inline sketches in §3.2/§3.3. ONLY the
 * enumerated transitions are legal; everything else fails closed, so a multi-session resume
 * can never mis-route on an ad-hoc status string (the durable-workflow single-record rule).
 *
 * Happy path:  PENDING → GROUNDED → GENERATED → SYNTAX_OK → PUSHED → ACTIVATED → GATED → GREEN
 * Offline fork: SYNTAX_OK → PROVISIONAL_GATED — the offline verdict rest state. Offline NEVER
 *              GREENs (P6): DEV push/activate/GATED/GREEN are unreachable, so the offline pass
 *              rests here. A fixable offline BLOCK retries to GENERATED (cycle-gated); an
 *              unfixable one escalates to BLOCK / NEEDS_MANUAL_SEAM.
 * Retry loop:  SYNTAX_OK→GENERATED, GATED→GENERATED, PROVISIONAL_GATED→GENERATED, only while cycle < MAX_PHASE_RETRY_CYCLES
 *              (post-syntax refinement / a machine BLOCK at the checkpoint re-generates; at the
 *              ceiling the only move is BLOCK — the bounded generator-refinement loop, §3.2/§3.4).
 *              NB a syntax FAIL is never reported as a status: SYNTAX_OK is pass-only, and the
 *              orchestrating skill counts failed syntax attempts in prose (§3.2 #4 offline
 *              compromise) — the FSM cycle counter sees only these two edges.
 * Escalation:  any ACTIVE state → BLOCK (dependents never schedule) or → NEEDS_MANUAL_SEAM.
 * Re-entry:    BLOCK → PARK only when the block reason is the deterministic NO_RELEASED_SUCCESSOR
 *              (never a P4/defect BLOCK, L7); PARK → PENDING when the successor ships;
 *              NEEDS_MANUAL_SEAM → PENDING once a human confirms the caller set.
 * GREEN is terminal (⇔ every artifact activated AND reconciled).
 *
 * Pure. No I/O.
 */
export const MAX_PHASE_RETRY_CYCLES = 3;
export const NO_RELEASED_SUCCESSOR = "NO_RELEASED_SUCCESSOR";

export const STATUSES = Object.freeze([
  "PENDING",
  "GROUNDED",
  "GENERATED",
  "SYNTAX_OK",
  "PUSHED",
  "ACTIVATED",
  "GATED",
  "PROVISIONAL_GATED",
  "GREEN",
  "BLOCK",
  "PARK",
  "NEEDS_MANUAL_SEAM",
  // Disposition-route terminals (B4): reached at drive time from a non-generating disposition. A `retire`
  // node grounds (to establish the no-released-successor basis, L7/P6) then terminates at RETIRED with no
  // generation; a `rebuild` node grounds then hands off (handoff-spec.json) at REBUILT_HANDOFF. Terminal.
  "RETIRED",
  "REBUILT_HANDOFF",
]);

// The in-flight states a node can escalate from (BLOCK / NEEDS_MANUAL_SEAM) — everything
// before a terminal/parked verdict. PROVISIONAL_GATED is the offline rest state: in-flight
// (it can still retry or escalate), never terminal (offline never GREENs).
export const ACTIVE_STATES = Object.freeze(["PENDING", "GROUNDED", "GENERATED", "SYNTAX_OK", "PUSHED", "ACTIVATED", "GATED", "PROVISIONAL_GATED"]);

const STATUS_SET = new Set(STATUSES);
const ACTIVE_SET = new Set(ACTIVE_STATES);

// Always-legal edges (forward chain + re-entry). Cycle-gated retries and reason-gated PARK
// are handled specially in canTransition.
const FORWARD = new Map([
  ["PENDING", new Set(["GROUNDED"])],
  ["GROUNDED", new Set(["GENERATED", "RETIRED", "REBUILT_HANDOFF"])], // GENERATED = build; RETIRED/REBUILT_HANDOFF = disposition-route terminals (retire/rebuild ground then terminate, no ABAP)
  ["GENERATED", new Set(["SYNTAX_OK"])],
  ["SYNTAX_OK", new Set(["PUSHED", "PROVISIONAL_GATED"])], // PUSHED = live DEV; PROVISIONAL_GATED = offline verdict
  ["PUSHED", new Set(["ACTIVATED"])],
  ["ACTIVATED", new Set(["GATED"])],
  ["GATED", new Set(["GREEN"])],
  ["PARK", new Set(["PENDING"])],
  ["NEEDS_MANUAL_SEAM", new Set(["PENDING"])],
]);

/** @returns {boolean} true iff `status` is one of the seven in-flight states. */
export function isActive(status) {
  return ACTIVE_SET.has(status);
}

/**
 * @param {string} from current status
 * @param {string} to proposed next status
 * @param {{cycle?: number, reason?: string}} [ctx] cycle = refinement retries already used; reason = BLOCK classification
 * @returns {boolean} whether the transition is legal
 */
export function canTransition(from, to, ctx = {}) {
  if (!STATUS_SET.has(from) || !STATUS_SET.has(to)) return false;
  if ((to === "BLOCK" || to === "NEEDS_MANUAL_SEAM") && ACTIVE_SET.has(from)) return true;
  if (to === "GENERATED" && (from === "SYNTAX_OK" || from === "GATED" || from === "PROVISIONAL_GATED")) return (ctx.cycle ?? 0) < MAX_PHASE_RETRY_CYCLES;
  if (from === "BLOCK" && to === "PARK") return ctx.reason === NO_RELEASED_SUCCESSOR;
  return FORWARD.get(from)?.has(to) ?? false;
}

/**
 * Fail-closed transition guard. @returns {string} `to` when legal; throws otherwise.
 * @param {string} from @param {string} to @param {{cycle?: number, reason?: string}} [ctx]
 */
export function assertTransition(from, to, ctx = {}) {
  if (!canTransition(from, to, ctx)) {
    throw new Error(`node-status: illegal transition ${from} → ${to}${ctx.cycle !== undefined ? ` (cycle ${ctx.cycle})` : ""}`);
  }
  return to;
}
