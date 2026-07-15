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
import { ratchetGate, offlineRatchetGate } from "../state/ratchet.js";
import { nodeVerdict, offlineVerdict } from "../node/verdict.js";

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
    generation: {}, // per-sig artifact generation — bumps on EVERY entry to GENERATED (attestation binding)
    verdict_green: {}, // per-sig recorded verdict result — GREEN is EARNED, never asserted
    verdict_provisional: {}, // per-sig offline provisional-pass flag (recorded at PROVISIONAL_GATED; offline never GREENs)
    deferral_track: [],
    park_register: [],
    activate_mutex: {}, // transport_id -> owning sig
    cancel_token: opts.cancel_token ?? null,
  };
}

/**
 * Record the rendered verdict for a node AT ITS CHECKPOINT (status must be GATED — a node
 * that has not reached the checkpoint has nothing to verdict, and baselines must never move
 * outside the lifecycle). `applyOutcome(GREEN)` refuses without a recorded GREEN verdict:
 * the reducer, not the orchestrating prose, decides GREEN (GAN separation, §3.2).
 */
export function recordVerdict(plan, state, sig, verdictResult) {
  bind(plan, state);
  if (state.status[sig] === undefined) throw new Error(`loop: unknown node ${sig}`);
  if (state.status[sig] !== "GATED") {
    throw new Error(`loop: verdict for ${sig} refused — the node is ${state.status[sig]}, not GATED`);
  }
  return { ...state, verdict_green: { ...state.verdict_green, [sig]: verdictResult.green === true } };
}

/**
 * The OFFLINE sibling of recordVerdict: record the offline verdict at PROVISIONAL_GATED (the
 * offline rest state — a node that has not reached the offline checkpoint has nothing to
 * verdict). Kept separate from recordVerdict's GATED-only guard so the live-GREEN record path is
 * untouched; offline NEVER GREENs (P6), so this records only a provisional-pass flag.
 */
export function recordProvisionalVerdict(plan, state, sig, verdictResult) {
  bind(plan, state);
  if (state.status[sig] === undefined) throw new Error(`loop: unknown node ${sig}`);
  if (state.status[sig] !== "PROVISIONAL_GATED") {
    throw new Error(`loop: provisional verdict for ${sig} refused — the node is ${state.status[sig]}, not PROVISIONAL_GATED`);
  }
  return { ...state, verdict_provisional: { ...state.verdict_provisional, [sig]: verdictResult.provisional === true } };
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
    // Re-check the frontier's third veto too (F11): a sealed node must never reach a node
    // driver — signature-changing modernisation waits for the human caller-set confirmation.
    if (plan.nodes.find((n) => n.id === sig)?.dynamic_seal === "NEEDS_MANUAL_SEAM") {
      throw new Error(`loop: ${sig} is dynamic-sealed — a human must confirm the caller set before dispatch (L5)`);
    }
    next = setStatus(plan, next, sig, "GROUNDED");
  }
  return next;
}

// Terminal outcomes carry semantics applyProgress cannot honour: the earned-GREEN verdict
// guard, the dependent indegree decrement, quarantine/park bookkeeping, and the mutex
// release all live in applyOutcome — an FSM-legal GATED→GREEN through this channel would
// bypass every one of them (branch review F2).
const TERMINAL_OUTCOMES = new Set(["GREEN", "BLOCK", "PARK", "NEEDS_MANUAL_SEAM"]);

/** A non-terminal per-node phase move reported by the node driver (FSM-checked, cycle-aware). */
export function applyProgress(plan, state, sig, nextStatus) {
  bind(plan, state);
  if (TERMINAL_OUTCOMES.has(nextStatus)) {
    throw new Error(`loop: ${nextStatus} is a terminal outcome — route it through applyOutcome (verdict guard, quarantine, mutex release)`);
  }
  if (nextStatus === "GROUNDED") {
    // grounding is dispatch's move ONLY — dispatch re-checks readiness, park, and the L5
    // seal; PENDING→GROUNDED through this channel would bypass all three (F11 escape)
    throw new Error(`loop: GROUNDED is dispatch's move — dispatch re-checks readiness, park, and the L5 seal`);
  }
  const reentry = (state.status[sig] === "PARK" || state.status[sig] === "NEEDS_MANUAL_SEAM") && nextStatus === "PENDING";
  let next = setStatus(plan, state, sig, nextStatus);
  if (reentry) {
    // re-entry (successor shipped / caller set confirmed, L7): the node leaves the
    // CURRENTLY-parked register AND its quarantine record — the audited history stays in
    // the persisted park file / git, not in live state. Any verdict recorded before the
    // detour is voided too: the re-walk regenerates, and a stale verdict must never bless
    // the artifact it produces (branch review F3 — defense in depth with the setStatus void).
    const verdict_green = { ...next.verdict_green };
    delete verdict_green[sig];
    const verdict_provisional = { ...next.verdict_provisional };
    delete verdict_provisional[sig];
    next = {
      ...next,
      verdict_green,
      verdict_provisional,
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
  if (!TERMINAL_OUTCOMES.has(outcome.status)) {
    // mirror of applyProgress's guard: a phase move through this channel would skip the
    // re-entry register cleanup (verb symmetry — the F11-escape review)
    throw new Error(`loop: ${outcome.status} is not a terminal outcome — report phase moves through applyProgress`);
  }
  if (outcome.status === "GREEN" && state.verdict_green?.[sig] !== true) {
    throw new Error(`loop: GREEN for ${sig} refused — no recorded green verdict (record one at GATED first)`);
  }
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
    // L7: the EXECUTABLE park path enforces the audited sign-off — never optional
    if (typeof outcome.signed_by !== "string" || outcome.signed_by.length === 0) {
      throw new Error(`loop: PARK for ${sig} refused — a NAMED human sign-off is required (L7)`);
    }
    if (typeof outcome.justification !== "string" || outcome.justification.length === 0) {
      throw new Error(`loop: PARK for ${sig} refused — a justification is required (L7)`);
    }
    next = {
      ...next,
      park_register: [
        ...next.park_register,
        { sig, reason: outcome.reason, signed_by: outcome.signed_by, justification: outcome.justification },
      ],
    };
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

/**
 * The OFFLINE composition (Phase 2, Option A): offlineRatchetGate → offlineVerdict with the SIGNED
 * `atc_warn_delta`, mirroring renderVerdict. Both partition out their DEV-only conjuncts (ratchet:
 * coverage/bite; verdict: activated/reconciled/unit), so a full pass rests in `provisional` — never
 * `green` (offline NEVER GREENs, P6). The warn/checkpoint evidence is fed by the gap-2b extractor.
 * @returns {{gate: object, verdict: object, provisional: boolean, reasons: string[]}}
 */
export function renderOfflineVerdict(planNode, checkpoint, evidence, baselines) {
  const gate = offlineRatchetGate(planNode, evidence, baselines);
  const verdict = offlineVerdict(checkpoint, { atc_warn_delta: gate.atc_warn_delta });
  return {
    gate,
    verdict,
    provisional: gate.verdict === "PASS" && verdict.verdict === "PROVISIONAL",
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
  const retry = to === "GENERATED" && (from === "SYNTAX_OK" || from === "GATED" || from === "PROVISIONAL_GATED");
  assertTransition(from, to, { cycle: retry ? state.cycle[sig] ?? 0 : ctx.cycle ?? 0, reason: ctx.reason });
  const next = { ...state, status: { ...state.status, [sig]: to } };
  if (to === "GENERATED") {
    // EVERY entry into GENERATED is a new artifact — first pass, retry, or a post-re-entry
    // re-walk. The generation counter is the attestation temporal binding (F4: the retry
    // cycle alone misses re-entry regeneration), and any recorded verdict is void here
    // (F3: a stale verdict can never bless a REGENERATED artifact). `?? {}` tolerates a
    // legacy persisted state written before the counter existed.
    next.generation = { ...(state.generation ?? {}), [sig]: ((state.generation ?? {})[sig] ?? 0) + 1 };
    if (next.verdict_green?.[sig] !== undefined) {
      const verdict_green = { ...next.verdict_green };
      delete verdict_green[sig];
      next.verdict_green = verdict_green;
    }
    if (next.verdict_provisional?.[sig] !== undefined) {
      const verdict_provisional = { ...next.verdict_provisional };
      delete verdict_provisional[sig];
      next.verdict_provisional = verdict_provisional;
    }
  }
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
