/**
 * The scheduler LOOP (MODERNISER_DESIGN §3.1 Stage 5/6, §3.3) — a pure, resumable,
 * sig-space REDUCER over the frozen plan alone. The imperative shell (the /modernise
 * skill: agent dispatch, fsync→rename→git persistence, DEV I/O) drives it; every function
 * here is copy-on-write and JSON-durable, so a crash resumes from the persisted state.
 *
 *   - Status moves are FSM-guarded (node-status, L9) — the loop can never mis-route.
 *   - Readiness is the live-decrementing in-degree counter over the plan's TRANSITIVE
 *     in-plan dependencies (L2). No init discount is needed: out-of-plan (clean/SAP)
 *     objects were reduced away at assembly; a GREEN outcome decrements its dependents.
 *   - BLOCK quarantines the node (deferral_track) — only its own dependents wait (L2).
 *   - PARK is FSM-gated to NO_RELEASED_SUCCESSOR (L7); PARK → PENDING re-enters.
 *   - The per-transport activate mutex (L4) serializes registration+activation among
 *     co-transport nodes even when generation is parallel; a terminal outcome releases it.
 *   - `renderVerdict` composes ratchetGate → nodeVerdict with the SIGNED atc_warn_delta
 *     (the ratchet-review contract) so gate and verdict can never disagree.
 *
 * Every entry point re-checks `state.plan_hash === plan.plan_hash` (fail-closed resume:
 * a state file from another plan is rejected — REPLAN is the only legal crossover, L6).
 */
import { assertTransition, NO_RELEASED_SUCCESSOR } from "../state/node-status.js";
import { nextFrontier } from "./frontier.js";
import { ratchetGate } from "../state/ratchet.js";
import { nodeVerdict } from "../node/verdict.js";

/**
 * @param {object} plan a frozen `assemblePlan().plan`
 * @returns {object} SchedulerState — JSON-plain, copy-on-write from here on
 */
export function initRun(plan, opts = {}) {
  const known = new Set(plan.nodes.map((n) => n.id));
  const indegree = {};
  const status = {};
  for (const n of plan.nodes) {
    for (const d of n.dependencies ?? []) {
      if (!known.has(d)) throw new Error(`loop: node ${n.id} has an unknown dependency ${d}`);
    }
    indegree[n.id] = (n.dependencies ?? []).length;
    status[n.id] = "PENDING";
  }
  return {
    plan_hash: plan.plan_hash,
    indegree,
    status,
    cycle: {}, // per-sig generator-refinement retries used (MAX_PHASE_RETRY_CYCLES gate)
    deferral_track: [],
    park_register: [],
    activate_mutex: {}, // transport_id -> owning sig
    cancel_token: opts.cancel_token ?? null,
  };
}

/** The next parallel batch: both-graph independent, worst-first, capped (§3.1 Stage 5). */
export function nextDispatch(plan, state) {
  bind(plan, state);
  const frontier = nextFrontier({
    condensation: {
      superNodes: plan.nodes.map((n) => ({ id: n.id, members: n.members, dynamic_seal: n.dynamic_seal })),
      edges: refEdges(plan),
    },
    conflict: { keysOf: Object.fromEntries(plan.nodes.map((n) => [n.id, n.conflict_keys ?? []])) },
    status: state.status,
    indegree: state.indegree,
    park: state.park_register.map((p) => p.sig),
    meta: metaByMember(plan),
    teamSize: plan.generator_team_size ?? Infinity,
  });
  return frontier;
}

/** Hand a frontier batch to the node drivers: PENDING → GROUNDED (FSM-checked + readiness-guarded). */
export function dispatch(plan, state, sigs) {
  bind(plan, state);
  let next = state;
  for (const sig of sigs) {
    if (state.indegree[sig] === undefined) throw new Error(`loop: unknown node ${sig}`);
    if (state.indegree[sig] !== 0) {
      throw new Error(`loop: ${sig} is not ready — its closure is not green (indegree ${state.indegree[sig]})`);
    }
    if (state.park_register.some((p) => p.sig === sig)) {
      throw new Error(`loop: ${sig} is parked — it re-enters only when its successor ships (L7)`);
    }
    next = setStatus(plan, next, sig, "GROUNDED");
  }
  return next;
}

/** A non-terminal per-node phase move reported by the node driver (FSM-checked, cycle-aware). */
export function applyProgress(plan, state, sig, nextStatus) {
  bind(plan, state);
  const wasParked = state.status[sig] === "PARK";
  let next = setStatus(plan, state, sig, nextStatus);
  if (wasParked && nextStatus === "PENDING") {
    // re-entry (successor shipped, L7): the node leaves the CURRENTLY-parked register AND
    // its quarantine record — the audited history stays in the persisted park file / git,
    // not in live state (a re-entered, later-GREEN node must not read as still quarantined).
    next = {
      ...next,
      park_register: next.park_register.filter((p) => p.sig !== sig),
      deferral_track: next.deferral_track.filter((d) => d.sig !== sig),
    };
  }
  return next;
}

/**
 * A terminal outcome from the node driver. GREEN frees dependents (counter decrement, L2);
 * BLOCK quarantines into deferral_track; PARK (reason-gated) lands in the park register.
 * Any terminal outcome releases a held activation mutex.
 * @param {{status: "GREEN"|"BLOCK"|"PARK"|"NEEDS_MANUAL_SEAM", reason?: string}} outcome
 */
export function applyOutcome(plan, state, sig, outcome) {
  bind(plan, state);
  let next = setStatus(plan, state, sig, outcome.status, { reason: outcome.reason });

  if (outcome.status === "GREEN") {
    const indegree = { ...next.indegree };
    for (const n of plan.nodes) {
      if ((n.dependencies ?? []).includes(sig)) indegree[n.id] -= 1;
    }
    next = { ...next, indegree };
  } else if (outcome.status === "BLOCK") {
    next = { ...next, deferral_track: [...next.deferral_track, { sig, reason: outcome.reason ?? "unspecified" }] };
  } else if (outcome.status === "PARK") {
    next = { ...next, park_register: [...next.park_register, { sig, reason: outcome.reason }] };
  }

  return releaseActivation(plan, next, sig); // idempotent when no mutex is held
}

/**
 * Acquire the per-transport activate mutex (L4). A node with no transport_id activates on
 * its own implicit transport (keyed by its sig). Re-acquire by the owner is idempotent.
 * @returns {{state: object, acquired: boolean}}
 */
export function acquireActivation(plan, state, sig) {
  bind(plan, state);
  const tid = transportOf(plan, sig);
  const owner = state.activate_mutex[tid];
  if (owner !== undefined && owner !== sig) return { state, acquired: false };
  if (owner === sig) return { state, acquired: true };
  return { state: { ...state, activate_mutex: { ...state.activate_mutex, [tid]: sig } }, acquired: true };
}

/** Release the mutex iff held by `sig` (idempotent otherwise). */
export function releaseActivation(plan, state, sig) {
  bind(plan, state);
  const tid = transportOf(plan, sig);
  if (state.activate_mutex[tid] !== sig) return state;
  const activate_mutex = { ...state.activate_mutex };
  delete activate_mutex[tid];
  return { ...state, activate_mutex };
}

/**
 * The ratchetGate → nodeVerdict composition (one coherent answer): the gate's SIGNED
 * `atc_warn_delta` is what the verdict conjunct consumes — never the absolute count.
 * @returns {{gate: object, verdict: object, green: boolean, reasons: string[]}}
 */
export function renderVerdict(planNode, checkpoint, evidence, baselines) {
  const gate = ratchetGate(planNode, evidence, baselines);
  const verdict = nodeVerdict(checkpoint, { atc_warn_delta: gate.atc_warn_delta });
  return {
    gate,
    verdict,
    green: gate.verdict === "PASS" && verdict.verdict === "GREEN",
    reasons: [...new Set([...gate.reasons, ...verdict.reasons])],
  };
}

/** Done ⇔ EVERY plan node is GREEN — a quarantined/parked node leaves the run incomplete. */
export function runComplete(plan, state) {
  bind(plan, state);
  return plan.nodes.every((n) => state.status[n.id] === "GREEN");
}

/** Fail-closed plan↔state binding: a state from another plan must never drive this one. */
function bind(plan, state) {
  if (state.plan_hash !== plan.plan_hash) {
    throw new Error(`loop: state plan_hash ${state.plan_hash} does not match plan ${plan.plan_hash} — resume through REPLAN`);
  }
}

/** FSM-checked status move; tracks the generator-refinement cycle count on retry loops. */
function setStatus(plan, state, sig, to, ctx = {}) {
  const from = state.status[sig];
  if (from === undefined) throw new Error(`loop: unknown node ${sig}`);
  const retry = to === "GENERATED" && (from === "SYNTAX_OK" || from === "GATED");
  assertTransition(from, to, { cycle: retry ? state.cycle[sig] ?? 0 : ctx.cycle ?? 0, reason: ctx.reason });
  const next = { ...state, status: { ...state.status, [sig]: to } };
  if (retry) next.cycle = { ...state.cycle, [sig]: (state.cycle[sig] ?? 0) + 1 };
  return next;
}

/** dep → dependent edge pairs, derived from the hashed node dependencies. */
function refEdges(plan) {
  const edges = [];
  for (const n of plan.nodes) for (const d of n.dependencies ?? []) edges.push([d, n.id]);
  return edges;
}

/** member-object-keyed meta for the frontier's worst-member aggregation. */
function metaByMember(plan) {
  const meta = {};
  for (const n of plan.nodes) for (const [m, v] of Object.entries(n.member_meta ?? {})) meta[m] = v;
  return meta;
}

function transportOf(plan, sig) {
  const n = plan.nodes.find((x) => x.id === sig);
  if (!n) throw new Error(`loop: unknown node ${sig}`);
  return n.transport_id ?? `own:${sig}`;
}

export { NO_RELEASED_SUCCESSOR };
