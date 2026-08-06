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
 *   - The node's verdict lives in `verdict-ops.js` (the gate → verdict COMPOSITION +
 *     the earned-GREEN record); it shares this file's `bind` guard, exported for it.
 *
 * Every entry point re-checks `state.plan_hash === plan.plan_hash` (fail-closed resume:
 * a state file from another plan is rejected — REPLAN is the only legal crossover, L6).
 */
import { assertTransition, NO_RELEASED_SUCCESSOR } from "../state/node-status.js";
import { isArchRatified, ARCH_GATED_DISPOSITIONS } from "../plan/arch-contract.js";
import { nextFrontier } from "./frontier.js";
import { refEdges, metaByMember, transportOf } from "./plan-views.js";
import { TERMINAL_OUTCOMES, RUN_COMPLETE_TERMINALS, DISPOSITION_TERMINALS, NON_BUILD_DISPOSITIONS, assertDispositionTerminal, assertArchRatified, assertBuildable, releaseDependents } from "./terminals.js";

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
    syntax_attempts: {}, // per-sig failed syntax self-check attempts (offline, pre-SYNTAX_OK) — SEPARATE from `cycle`; the driver's ceiling counter (Phase 2 increment 2). Cleared on re-entry.
    generation: {}, // per-sig artifact generation — bumps on EVERY entry to GENERATED (attestation binding)
    verdict_green: {}, // per-sig recorded verdict result — GREEN is EARNED, never asserted
    verdict_provisional: {}, // per-sig offline provisional-pass flag (recorded at PROVISIONAL_GATED; offline never GREENs)
    deferral_track: [],
    park_register: [],
    activate_mutex: {}, // transport_id -> owning sig
    arch_contracts: {}, // per-sig ratified Architecture Contract binding {ref,hash,ratified_by,reviewer_verdict} (S6 run state; NOT the frozen node, so plan_hash is unaffected)
    disposition_register: [], // audited RETIRED / REBUILT_HANDOFF sign-offs — these terminals complete a run with NO verdict, so this row is the only record of who authorised the drop/handoff and why
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
    // Nodes that cannot become build work right now, excluded BEFORE the team-size cap (M5) so they never
    // occupy a slot and starve dispatchable work: an arch-gated node awaiting human ratification, a `retire`
    // node (routed by driveDecision's own action, never generated), and a `seal` node (the classifier asked
    // for manual review — generating it is the fail-open the seam exists to prevent). S5.
    ineligible: plan.nodes
      .filter((n) => NON_BUILD_DISPOSITIONS.has(n.disposition)
        || (ARCH_GATED_DISPOSITIONS.has(n.disposition) && !isArchRatified(state, n.id)))
      .map((n) => n.id),
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
    // Re-check the frontier's third veto too (F11): a sealed node must never reach a node driver —
    // signature-changing modernisation waits for the human caller-set confirmation. EXCEPT a `retire`,
    // which has no generator to reach (assertBuildable now ENFORCES that, rather than assuming it) and
    // whose terminal demands a named human: without the exception a sealed override froze the plan (R3).
    const node = plan.nodes.find((n) => n.id === sig);
    if (node?.dynamic_seal === "NEEDS_MANUAL_SEAM" && node.disposition !== "retire") {
      throw new Error(`loop: ${sig} is dynamic-sealed — a human must confirm the caller set before dispatch (L5)`);
    }
    // The arch veto belongs HERE, not only in driveDecision's frontier filter (M1): `dispatch` and
    // `progress` are first-class CLI verbs that reach the reducer directly, so a driver-only guard is
    // bypassable — an unratified re_architect node could be walked to GENERATED through another verb.
    assertArchRatified(plan, state, sig, "clear the ARCH_REVIEW gate first");
    next = setStatus(plan, next, sig, "GROUNDED");
  }
  return next;
}

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
  // Both dispositional gates hold for the WHOLE lifecycle, not just the entry edge. Re-entry to PENDING
  // stays legal either way: that is how a node returns to be re-gated or re-dispositioned.
  //   V3 — a non-build disposition never becomes build work, whatever verb is driving (see terminals.js).
  //   A  — voiding a ratification (`decide reject|refine`) must stop a node already in flight, or the build
  //        continues and the run COMPLETES on architecture the human rejected.
  if (nextStatus !== "PENDING") {
    assertBuildable(plan, sig);
    assertArchRatified(plan, state, sig, "a rejected or unratified architecture must not keep building");
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
    // The driver's syntax-attempt counter is per-generation-episode: a re-walk starts a fresh
    // artifact, so the pre-detour failed attempts must not shorten the new episode's ceiling.
    const syntax_attempts = { ...next.syntax_attempts };
    delete syntax_attempts[sig];
    next = {
      ...next,
      verdict_green,
      verdict_provisional,
      syntax_attempts,
      park_register: next.park_register.filter((p) => p.sig !== sig),
      deferral_track: next.deferral_track.filter((d) => d.sig !== sig),
    };
  }
  return next;
}

/**
 * A terminal outcome from the node driver. Every RUN-COMPLETING terminal frees dependents (the counter
 * decrement, L2) — GREEN, and equally RETIRED / REBUILT_HANDOFF, because a dropped or handed-off dependency
 * is RESOLVED: it is not coming, so nothing may keep waiting for it. NEEDS_MANUAL_SEAM, BLOCK (quarantine
 * into deferral_track) and PARK (reason-gated, into the park register) deliberately keep blocking, because
 * those dependencies are precisely not resolved. Any terminal outcome releases the mutex. The dependents of
 * a dropped node DO proceed; the consequence is surfaced at the plan gate (§7.4 DROPPED_DEPENDENCY).
 * @param {{status: "GREEN"|"BLOCK"|"PARK"|"NEEDS_MANUAL_SEAM"|"RETIRED"|"REBUILT_HANDOFF", reason?: string}} outcome
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
  if (DISPOSITION_TERMINALS.has(outcome.status)) assertDispositionTerminal(plan, sig, outcome);
  let next = setStatus(plan, state, sig, outcome.status, { reason: outcome.reason });

  // Every RESOLVED dependency releases its dependents, not just GREEN (P3 — see terminals.js for why the
  // GREEN-only decrement deadlocked a run the moment a `retire` node could exist).
  if (RUN_COMPLETE_TERMINALS.has(outcome.status)) next = releaseDependents(plan, next, sig);

  if (outcome.status === "BLOCK") {
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
  } else if (DISPOSITION_TERMINALS.has(outcome.status)) {
    // The sign-off is validated by assertDispositionTerminal; PERSIST it. These terminals complete a run
    // with no verdict behind them, so this row is the only evidence in the proof bundle of who authorised
    // dropping the object (RETIRED) or handing it off the stack (REBUILT_HANDOFF), and why.
    next = {
      ...next,
      disposition_register: [
        ...(next.disposition_register ?? []),
        { sig, status: outcome.status, reason: outcome.reason, signed_by: outcome.signed_by, justification: outcome.justification },
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

/** Done ⇔ EVERY plan node rests at a run-completing terminal (GREEN | RETIRED | REBUILT_HANDOFF) — a
 * quarantined/parked/in-flight node leaves the run incomplete. */
export function runComplete(plan, state) {
  bind(plan, state);
  return plan.nodes.every((n) => RUN_COMPLETE_TERMINALS.has(state.status[n.id]));
}

/** Fail-closed plan↔state binding: a state from another plan must never drive this one. Exported for the verdict-ops record* verbs, which are reducer entries too. */
export function bind(plan, state) {
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
    // A GENERATED re-entry via the verdict-retry edge (SYNTAX_OK/GATED/PROVISIONAL_GATED→GENERATED)
    // is a fresh generation episode, so the driver's per-episode syntax-attempt count must reset too
    // — else the pre-detour failures shorten the new artifact's ceiling (review F1). A no-op on the
    // first PENDING→GENERATED entry (the counter is not set yet); the PARK re-entry clears it earlier.
    if (next.syntax_attempts?.[sig] !== undefined) {
      const syntax_attempts = { ...next.syntax_attempts };
      delete syntax_attempts[sig];
      next.syntax_attempts = syntax_attempts;
    }
  }
  if (retry) next.cycle = { ...state.cycle, [sig]: (state.cycle[sig] ?? 0) + 1 };
  return next;
}

export { NO_RELEASED_SUCCESSOR };
