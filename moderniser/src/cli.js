#!/usr/bin/env node
/**
 * /modernise CLI (MODERNISER_DESIGN §6.5, §3.5 layer 2→3 boundary) — the deterministic
 * imperative shell over the pure reducer. The skill drives it via Bash between agent
 * dispatches. All output is JSON on stdout; failures exit 1 on stderr. IO rules live in
 * cli-io.js (durable commits, §6.6 log, sweep ledger).
 *
 * GREEN is EARNED: `verdict` (only legal at GATED) records the rendered result into state;
 * `outcome GREEN` is refused without a recorded green verdict — the reducer decides, never
 * the orchestrating prose. Mutating commands are IDEMPOTENT on exact repeat (a retry after
 * a crash between state-commit and log-append is a no-op, never an FSM wedge).
 *
 * Commands:
 *   plan <findings.json> [--run-id id] [--team-size N] [--force]
 *   next <run_id> · dispatch <run_id> <sig...> · progress <run_id> <sig> <STATUS>
 *   outcome <run_id> <sig> <STATUS> [--reason r] [--signed-by name]
 *   verdict <run_id> <sig> --checkpoint f --evidence f [--record]
 *   sweep-order <run_id> · sweep-mark <run_id> <sig> --result drafted|failed   (offline draft sweep, §6.5)
 *   reprobe <run_id> --available I_X[,I_Y...]   (park successor re-probe → re-entry, §3.4 #5)
 *   packets <run_id> [--max N]                  (surfaced escalations as GatePackets, §3.4 #8)
 *   status <run_id> · resume <run_id>
 * Common flags: --state-dir (default .claude/state) --runs-dir (default specs/runs)
 */
import { readFileSync, existsSync } from "node:fs";
import { assemblePlan } from "./sched/assemble.js";
import { savePlan } from "./sched/plan.js";
import { initRun, nextDispatch, dispatch, applyProgress, applyOutcome, renderVerdict, recordVerdict, runComplete } from "./sched/loop.js";
import { onPass } from "./state/ratchet.js";
import { tryPark } from "./exception/park.js";
import { statePath, saveState, writeBaselinePair, log, readBaselines, readParkRegister, saveParkRegister, readEscalations, parseArgs, loadRun, validRunId } from "./cli-io.js";
import { cmdEscalate, cmdEscalations, cmdPackets, cmdDecide } from "./cli-escalations.js";
import { cmdSweepOrder, cmdSweepMark } from "./cli-sweep.js";
import { cmdReprobe } from "./cli-park.js";

const COMMANDS = {
  plan: cmdPlan,
  next: cmdNext,
  dispatch: cmdDispatch,
  progress: cmdProgress,
  outcome: cmdOutcome,
  verdict: cmdVerdict,
  "sweep-order": cmdSweepOrder,
  "sweep-mark": cmdSweepMark,
  reprobe: cmdReprobe,
  escalate: cmdEscalate,
  escalations: cmdEscalations,
  packets: cmdPackets,
  decide: cmdDecide,
  status: cmdStatus,
  resume: cmdResume,
};

function cmdPlan(io, pos, flags) {
  const doc = JSON.parse(readFileSync(pos[0], "utf8"));
  // Fail LOUD, never a vacuous zero-node run that status reports complete (F25): an
  // adt-only/subset analyser artifact is schema-valid WITHOUT a modernization_plan.
  if (!Array.isArray(doc.modernization_plan?.objects)) {
    throw new Error("plan: the findings doc has no modernization_plan.objects — an adt-only/subset analyser artifact cannot drive /modernise; re-run /abap-analyser in a plan-emitting mode");
  }
  const teamSize = parseTeamSize(flags["team-size"]);
  const { plan } = assemblePlan(doc, { generator_team_size: teamSize });
  if (plan.nodes.length === 0) {
    throw new Error("plan: modernization_plan.objects is empty — nothing to modernise; refusing a zero-node run that would vacuously report complete");
  }
  const runId = validRunId(flags["run-id"] ?? `run-${plan.plan_hash.slice(0, 12)}`);
  if (existsSync(statePath(io, runId)) && flags.force === undefined) {
    throw new Error(`plan: run '${runId}' already exists — use 'resume ${runId}' (or --force to discard it)`);
  }
  savePlan(runId, plan, io.stateDir);
  // run_epoch (F4-escape review): the run id is plan-hash-derived, so `--force` recreates a
  // run under the SAME id while escalations.json survives — the epoch makes each plan
  // invocation a distinct attestation domain, so a discarded run's attestation can never
  // bless the recreated run's artifact. Shell-side clock; the reducer stays pure.
  saveState(io, runId, { ...initRun(plan), run_epoch: new Date().toISOString() });
  log(io, runId, "plan", { plan_hash: plan.plan_hash, nodes: plan.nodes.length });
  return {
    run_id: runId,
    plan_hash: plan.plan_hash,
    nodes: plan.nodes.map((n) => ({ sig: n.id, object: n.object, wave: n.wave })),
    waves: plan.waves.length,
  };
}

function cmdNext(io, pos) {
  const { plan, state } = load(io, pos[0]);
  return { ready: describe(plan, nextDispatch(plan, state)) };
}

function cmdDispatch(io, pos) {
  const [runId, ...sigs] = pos;
  const { plan, state } = load(io, runId);
  const fresh = sigs.filter((sig) => state.status[sig] !== "GROUNDED"); // idempotent repeat
  if (fresh.length > 0) {
    saveState(io, runId, dispatch(plan, state, fresh));
    for (const sig of fresh) log(io, runId, "dispatch", { sig });
  }
  return { dispatched: sigs, applied: fresh };
}

function cmdProgress(io, pos) {
  const [runId, sig, status] = pos;
  const { plan, state } = load(io, runId);
  if (state.status[sig] !== status) {
    // idempotent repeat guard: an exact-repeat after a half-commit is a no-op
    saveState(io, runId, applyProgress(plan, state, sig, status));
    log(io, runId, "progress", { sig, status });
  }
  return { sig, status };
}

function cmdOutcome(io, pos, flags) {
  const [runId, sig, status] = pos;
  const { plan, state } = load(io, runId);
  if (state.status[sig] === status) return { sig, status, complete: runComplete(plan, state) }; // idempotent repeat
  const next = applyOutcome(plan, state, sig, {
    status,
    reason: flags.reason,
    signed_by: flags["signed-by"],
    justification: flags.justification,
  });
  if (status === "PARK") parkAudit(io, sig, flags); // audit register FIRST — a retry is idempotent on both
  saveState(io, runId, next);
  log(io, runId, "outcome", { sig, status, reason: flags.reason, signed_by: flags["signed-by"] });
  return { sig, status, complete: runComplete(plan, next) };
}

/**
 * The LATEST register row for (PARITY_REVIEW, sig) → the attester's name, IFF the decision
 * is temporally bound to THIS run and THIS artifact (the node's current GENERATION — it
 * bumps on every entry to GENERATED, so a retry, a re-entry re-walk, or a pre-artifact
 * decision all mismatch). Unstamped/older rows fail closed — the human attested code this
 * artifact is not.
 */
function parityAttestation(io, sig, runId, state) {
  const rows = readEscalations(io).escalations.filter((e) => e.kind === "PARITY_REVIEW" && e.node_ids.includes(sig));
  const latest = rows[rows.length - 1];
  if (latest?.status !== "RESOLVED" || latest?.decision !== "ATTEST_EQUIVALENT") return null;
  if (latest.run_id !== runId) return null;
  if ((latest.decided_epoch ?? null) !== (state.run_epoch ?? null)) return null; // plan --force reuses the run id; the epoch does not
  if ((latest.decided_generations?.[sig] ?? -1) !== (state.generation?.[sig] ?? 0)) return null;
  return latest.resolved_by;
}

/**
 * The §3.4 #5/#6 audited park row. REPLACE-not-skip (F17/F26): every PARK is a FRESH
 * audited sign-off — a stale row from an earlier park episode must not shadow the new
 * signer/justification/probe (episode history lives in git + log.jsonl; the register
 * holds the CURRENT park). An exact crash-retry rewrites the same content — idempotent
 * in effect.
 */
function parkAudit(io, sig, flags) {
  const reg = readParkRegister(io);
  const cleared = { ...reg, parked: reg.parked.filter((p) => p.node_id !== sig) };
  saveParkRegister(
    io,
    tryPark(cleared, sig, {
      reason: flags.reason,
      signed_by: flags["signed-by"],
      justification: flags.justification,
      successor_probe: flags["successor-probe"],
      ts: new Date().toISOString(),
    }),
  );
}

function cmdVerdict(io, pos, flags) {
  const [runId, sig] = pos;
  const { plan, state } = load(io, runId);
  const node = plan.nodes.find((n) => n.id === sig);
  if (!node) throw new Error(`verdict: unknown node ${sig}`);
  const fileCp = JSON.parse(readFileSync(flags.checkpoint, "utf8"));
  // Attestations are joined from the AUDITED escalations register ONLY (ratified
  // 2026-07-12/13): checkpoint-supplied attestation fields are overwritten, so the typed
  // `decide … ATTEST_EQUIVALENT --by <name>` verb is the single path to attest. The
  // LATEST register row governs, and it must be TEMPORALLY BOUND to this run + this
  // artifact (the node's current refinement cycle) — a regenerated artifact or another
  // run can never inherit an attestation. auth_equivalence is nulled until its consumer
  // is wired (build-step 7) — a forged field must not lie in wait.
  const checkpoint = {
    ...fileCp,
    attestations: { parity_equivalence: parityAttestation(io, sig, runId, state), auth_equivalence: null },
  };
  const evidence = JSON.parse(readFileSync(flags.evidence, "utf8"));
  const baselines = readBaselines(io.stateDir);
  // NO `?? []` fallback: an absent diff_changed_lines must PROPAGATE so the gate fails
  // closed (F1 — the erasure here made a missing diff indistinguishable from an empty one).
  const gateNode = { canonical_sig: sig, parity_required: node.parity_required, diff_changed_lines: evidence.diff_changed_lines };
  const r = renderVerdict(gateNode, checkpoint, evidence, baselines);
  saveState(io, runId, recordVerdict(plan, state, sig, r)); // GATED-gated; refuses out-of-lifecycle
  if (r.green && flags.record !== undefined) {
    const updated = onPass(gateNode, evidence, baselines); // copy-on-write; throws on BLOCK
    writeBaselinePair(io.stateDir, updated);
    log(io, runId, "baselines-recorded", { sig, delta: r.gate.delta });
  }
  log(io, runId, "verdict", { sig, green: r.green, gate: r.gate.verdict });
  return r;
}

function cmdStatus(io, pos) {
  const { plan, state } = load(io, pos[0]);
  return statusOf(plan, state);
}

function cmdResume(io, pos) {
  const runId = pos[0];
  const { plan, state } = load(io, runId); // loadPlan re-hashes; the bind check rejects a foreign state
  log(io, runId, "resume", {});
  return { verified: true, run_id: runId, plan_hash: plan.plan_hash, status: statusOf(plan, state) };
}

// ---------- guards ----------

/** team-size 0/negative/NaN would silently stall the frontier forever — fail loud instead. */
function parseTeamSize(raw) {
  if (raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`plan: --team-size must be an integer >= 1 (got '${raw}')`);
  return n;
}

// ---------- shared ----------

const load = loadRun; // plan/state read + traversal guard + hash binding live in cli-io

function statusOf(plan, state) {
  const counts = {};
  for (const n of plan.nodes) counts[state.status[n.id]] = (counts[state.status[n.id]] ?? 0) + 1;
  return {
    complete: runComplete(plan, state),
    counts,
    deferral_track: state.deferral_track,
    park_register: state.park_register,
    ready_now: describe(plan, nextDispatch(plan, state)),
  };
}

const describe = (plan, sigs) =>
  sigs.map((sig) => {
    const n = plan.nodes.find((x) => x.id === sig);
    return { sig, object: n.object, wave: n.wave };
  });

function main(argv) {
  const { cmd, pos, flags } = parseArgs(argv);
  const handler = COMMANDS[cmd];
  if (!handler) throw new Error(`unknown command '${cmd}' — see moderniser/src/cli.js header for usage`);
  const io = { stateDir: flags["state-dir"] || ".claude/state", runsDir: flags["runs-dir"] || "specs/runs" }; // || so an empty value falls back
  const result = handler(io, pos, flags);
  process.stdout.write(`${JSON.stringify(result, null, 1)}\n`);
}

try {
  main(process.argv.slice(2));
} catch (e) {
  // CLI process boundary: the one place a broad catch is correct — surface and exit non-zero.
  process.stderr.write(`modernise: ${e.message}\n`);
  process.exit(1);
}
