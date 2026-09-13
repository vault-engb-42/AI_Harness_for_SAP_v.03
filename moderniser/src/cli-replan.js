/**
 * The REPLAN verb (P3, S-c) — `replan <run_id> <findings.json> --by <name> [--bundle dir] [--force]`.
 *
 * This is the effect half of the disposition gate. `decide <esc> override:<disposition>` records the
 * operator's decision durably and audibly; until this verb existed nothing ever read it back, so the frozen
 * node kept the classifier's disposition and the driver went on building what the human had just said to
 * drop. Here the recorded overrides are collected (plan/replan-overrides.js), re-assembled into a plan, and
 * re-FROZEN under a NEW `plan_hash` — the L6 REPLAN gate. Three things are deliberately NOT done:
 *   - the frozen plan is never mutated (it is the run's immutable identity, and every verb re-hashes it);
 *   - no disposition override is stored at state level, which would let state and plan disagree about what
 *     is being built — precisely the fail-open the ratchet exists to forbid;
 *   - the old run is left intact, so the record still shows what the classifier recommended and what the
 *     human changed it to.
 *
 * The re-assembly is proven honest before it is used: assembling the run's OWN inputs with no overrides must
 * reproduce the run's exact `plan_hash`. That check subsumes the whole wave/node-set diff `sched/plan.js
 * replan()` performs — an equal content hash means an identical node set and identical waves — so a
 * disposition delta is the ONLY difference the new plan can carry, and a forgotten `--bundle` or a drifted
 * findings doc is caught here instead of smuggling unrelated structural change in behind an override.
 */
import { assemblePlan } from "./sched/assemble.js";
import { augmentFromCpg } from "./graph/adapt.js";
import { readBundleSources } from "./graph/sources.js";
import { savePlan, PLAN_SCHEMA_VERSION } from "./sched/plan.js";
import { initRun } from "./sched/loop.js";
import { collectOverrides, supersededOverrides } from "./plan/replan-overrides.js";
import { readVerifiedDoc } from "./cli-arch.js";
import { loadRun, readEscalations, saveState, statePath, readJson, log, validRunId } from "./cli-io.js";

export function cmdReplan(io, pos, flags) {
  const [runId] = pos;
  if (typeof flags.by !== "string" || flags.by === "") {
    throw new Error("replan: --by <name> is required — re-freezing a run's plan is an accountable human act, not a housekeeping step");
  }
  const { plan, state } = loadRun(io, runId);
  // Diagnosed BEFORE the reproduction check below, which would otherwise blame the bundle: a run frozen
  // under an older node schema cannot re-assemble to its own hash, because the node fields themselves moved.
  if (plan.schema_version !== PLAN_SCHEMA_VERSION) {
    throw new Error(
      `replan: run '${runId}' was frozen under plan schema ${plan.schema_version}, but nodes are now built to ${PLAN_SCHEMA_VERSION} — its plan cannot be reproduced; re-run 'plan' on the current findings`,
    );
  }
  const doc = readVerifiedDoc(pos[1] ?? flags.findings, state, "replan");
  const opts = assembleOptions(plan, doc, flags);

  // The run's OWN overrides, read back off its frozen nodes (R1). A run that `replan` produced already
  // carries the human's earlier decisions, so re-assembling it from the classifier alone could never
  // reproduce its plan_hash — the honesty check below was unsatisfiable for exactly the runs the lane tells
  // the operator to continue under, which made a SECOND override impossible to apply. The plan is the record
  // of what was decided, so it is also the right place to read it from: the escalation register is scoped to
  // one run id and knows nothing of the chain.
  const inherited = inheritedOverrides(plan);

  // Honesty check before anything is built on the result (see the file header). Assembling twice is
  // deliberate: `replan` is a rare human-gated verb, and proving the inputs reproduce the run is worth more
  // than one saved traversal.
  const base = assemblePlan(doc, { ...opts, dispositionOverrides: inherited }).plan;
  if (base.plan_hash !== plan.plan_hash) {
    throw new Error(
      `replan: re-assembling this run's own inputs produced plan ${base.plan_hash.slice(0, 12)}, not the run's ${plan.plan_hash.slice(0, 12)} — the findings identity matched, so the difference is in the assembly inputs: pass the SAME --bundle that 'plan' was given (an omitted bundle plans an unsealed graph). An override must not carry unrelated structural drift with it`,
    );
  }

  // Newly recorded decisions win over the inherited ones for the same node (the human changed their mind
  // again); an inherited override that nobody re-decided simply carries forward unchanged.
  const register = readEscalations(io);
  const overrides = { ...inherited, ...collectOverrides(register, runId) };
  // Decisions the human RECORDED and a later one DISCARDED. Reported on BOTH exits, because the silent
  // case is the dangerous one: a run that throws away six overrides and shows `changed: []` tells the
  // operator nothing happened, when in fact their decisions were the thing that did not happen.
  const superseded = supersededOverrides(register, runId);
  const next = assemblePlan(doc, { ...opts, dispositionOverrides: overrides }).plan;
  const changed = dispositionDelta(plan, next, overrides);
  if (changed.length === 0) {
    log(io, runId, "replan", { changed: 0, superseded: superseded.length });
    return {
      replanned: false,
      run_id: runId,
      plan_hash: plan.plan_hash,
      changed: [],
      superseded,
      ...(superseded.length > 0
        ? {
          note: `${superseded.length} recorded override(s) were SUPERSEDED by a later decision on the same `
            + "node and did not reach the plan — re-record them AFTER the approvals if they still stand",
        }
        : {}),
    };
  }

  const newRunId = validRunId(`run-${next.plan_hash.slice(0, 12)}`);
  const existing = readJson(statePath(io, newRunId), null);
  // A genuine idempotent repeat: the overrides are already applied and the new run may have made progress
  // since. Re-initialising it here would silently discard that progress — report the no-op instead.
  if (existing?.plan_hash === next.plan_hash) {
    return { replanned: true, already: true, old_run_id: runId, new_run_id: newRunId, old_plan_hash: plan.plan_hash, new_plan_hash: next.plan_hash, changed, restarted: [], superseded };
  }

  const restarted = assertForcedIfDestructive(plan, state, changed, flags);
  savePlan(newRunId, next, io.stateDir); // plan first: the residue of a crash here is a plan with no state,
  saveState(io, newRunId, migrateState(next, state, changed)); //  which every verb rejects and this verb heals
  log(io, runId, "replan", { new_run_id: newRunId, changed: changed.length, by: flags.by, forced: flags.force !== undefined });
  log(io, newRunId, "replan-from", { old_run_id: runId, changed, restarted, by: flags.by });
  return { replanned: true, old_run_id: runId, new_run_id: newRunId, old_plan_hash: plan.plan_hash, new_plan_hash: next.plan_hash, changed, restarted, superseded };
}

/**
 * The overrides already frozen into this plan, in the shape `applyDispositionOverrides` consumes. Round-trip
 * safe by construction: that function is a pure function of {classified node, disposition, decided_by}, and
 * both fields ride the hashed node — so re-applying these to a fresh assembly reproduces the plan exactly.
 * (`decided_at` is deliberately not on the node — it would make plan_hash depend on decision timestamps —
 * and is not an input to the override, so nothing is lost here. The audit trail lives in the register.)
 */
function inheritedOverrides(plan) {
  return Object.fromEntries(
    plan.nodes
      .filter((n) => n.disposition_source === "operator_override")
      .map((n) => [n.id, { disposition: n.disposition, decided_by: n.disposition_decided_by }]),
  );
}

/** The run's own resource knobs (outside plan_hash) + the same Stage-1 bundle augment `plan` was given. */
function assembleOptions(plan, doc, flags) {
  return {
    generator_team_size: plan.generator_team_size,
    session_budget: plan.session_budget,
    ...(flags.bundle !== undefined ? { augment: augmentFromCpg(doc, readBundleSources(flags.bundle)) } : {}),
  };
}

/** The disposition delta, reported with the human who caused it. An override that agrees with the classifier is no delta. */
function dispositionDelta(plan, next, overrides) {
  const before = new Map(plan.nodes.map((n) => [n.id, n.disposition]));
  return next.nodes
    .filter((n) => before.get(n.id) !== n.disposition)
    .map((n) => ({ sig: n.id, from: before.get(n.id), to: n.disposition, decided_by: overrides[n.id]?.decided_by ?? null }));
}

/**
 * Two destructive consequences must be signed for, never absorbed silently:
 *   1. the new run starts from a fresh `initRun`, so any node already in flight is restarted from PENDING —
 *      per-node progress is NOT carried across a change of plan identity, because a state that half-belongs
 *      to two plans is the disagreement `loadRun`'s hash bind exists to reject;
 *   2. a node whose disposition changed loses its Architecture Contract ratification, and that ratification
 *      was a human's approval of a specific architecture.
 * @returns {string[]} the sigs whose work the caller has accepted restarting
 */
function assertForcedIfDestructive(plan, state, changed, flags) {
  const forced = flags.force !== undefined;
  const inFlight = plan.nodes.map((n) => n.id).filter((sig) => (state.status[sig] ?? "PENDING") !== "PENDING");
  if (inFlight.length > 0 && !forced) {
    throw new Error(
      `replan: ${inFlight.length} node(s) are in flight (${inFlight.join(", ")}) — a re-freeze restarts them from PENDING; re-run with --force --by <name> to accept discarding that work`,
    );
  }
  const voided = changed.map((c) => c.sig).filter((sig) => state.arch_contracts?.[sig]?.ratified_by);
  if (voided.length > 0 && !forced) {
    throw new Error(
      `replan: ${voided.join(", ")} would lose a ratified architecture (approved by ${voided.map((s) => state.arch_contracts[s].ratified_by).join(", ")}) — the contract describes a disposition that no longer applies; re-run with --force --by <name> to void it`,
    );
  }
  return inFlight;
}

/**
 * The new run's state: a fresh reducer state bound to the NEW plan, carrying forward only what identifies
 * the planning episode rather than its progress. `arch_contracts` survive for UNTOUCHED nodes — their
 * architecture is unchanged and re-asking a human to approve what they already approved is the deadlock H1
 * removed — and are dropped for every changed node.
 */
function migrateState(next, state, changed) {
  const changedSigs = new Set(changed.map((c) => c.sig));
  const carried = Object.entries(state.arch_contracts ?? {}).filter(([sig]) => !changedSigs.has(sig));
  return {
    ...initRun(next),
    run_epoch: state.run_epoch ?? null, // the same planning episode re-frozen, not a new attestation domain
    source_hash: state.source_hash ?? null,
    config_hash: state.config_hash ?? null,
    arch_contracts: Object.fromEntries(carried),
  };
}
