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
 *   status <run_id> · resume <run_id>
 * Common flags: --state-dir (default .claude/state) --runs-dir (default specs/runs)
 */
import { readFileSync, existsSync } from "node:fs";
import { assemblePlan } from "./sched/assemble.js";
import { savePlan } from "./sched/plan.js";
import { initRun, nextDispatch, dispatch, applyProgress, applyOutcome, renderVerdict, recordVerdict, runComplete } from "./sched/loop.js";
import { onPass } from "./state/ratchet.js";
import { tryPark } from "./exception/park.js";
import { statePath, saveState, writeBaselinePair, log, readSweepLedger, saveSweepLedger, readBaselines, readParkRegister, saveParkRegister, parseArgs, loadRun, validRunId } from "./cli-io.js";
import { cmdEscalate, cmdEscalations, cmdDecide } from "./cli-escalations.js";

const COMMANDS = {
  plan: cmdPlan,
  next: cmdNext,
  dispatch: cmdDispatch,
  progress: cmdProgress,
  outcome: cmdOutcome,
  verdict: cmdVerdict,
  "sweep-order": cmdSweepOrder,
  "sweep-mark": cmdSweepMark,
  escalate: cmdEscalate,
  escalations: cmdEscalations,
  decide: cmdDecide,
  status: cmdStatus,
  resume: cmdResume,
};

function cmdPlan(io, pos, flags) {
  const doc = JSON.parse(readFileSync(pos[0], "utf8"));
  const teamSize = parseTeamSize(flags["team-size"]);
  const { plan } = assemblePlan(doc, { generator_team_size: teamSize });
  const runId = validRunId(flags["run-id"] ?? `run-${plan.plan_hash.slice(0, 12)}`);
  if (existsSync(statePath(io, runId)) && flags.force === undefined) {
    throw new Error(`plan: run '${runId}' already exists — use 'resume ${runId}' (or --force to discard it)`);
  }
  savePlan(runId, plan, io.stateDir);
  saveState(io, runId, initRun(plan));
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

/** The §3.4 #5/#6 audited park row (idempotent — a crash-retry must not double-park). */
function parkAudit(io, sig, flags) {
  const reg = readParkRegister(io);
  if (reg.parked.some((p) => p.node_id === sig)) return;
  saveParkRegister(
    io,
    tryPark(reg, sig, {
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
  const checkpoint = JSON.parse(readFileSync(flags.checkpoint, "utf8"));
  const evidence = JSON.parse(readFileSync(flags.evidence, "utf8"));
  const baselines = readBaselines(io.stateDir);
  const gateNode = { canonical_sig: sig, parity_required: node.parity_required, diff_changed_lines: evidence.diff_changed_lines ?? [] };
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

/**
 * Offline draft sweep (§6.5, ratified 2026-07-11): the nodes the gated pass could not reach
 * (still PENDING — their closure can never green offline), in plan-topological order
 * (wave asc — the bottom-up level IS a topological order), with each dependency's current
 * status so the generator knows which drafts to ground against. READ-ONLY on loop state.
 */
function cmdSweepOrder(io, pos) {
  const [runId] = pos;
  const { plan, state } = load(io, runId);
  const ledger = readSweepLedger(io, runId);
  const bySig = new Map(plan.nodes.map((n) => [n.id, n]));
  const remaining = plan.nodes
    .filter((n) => state.status[n.id] === "PENDING" && ledger.swept[n.id] === undefined)
    .sort((a, b) => a.wave - b.wave || (a.id < b.id ? -1 : 1))
    .map((n) => ({
      sig: n.id,
      object: n.object,
      wave: n.wave,
      dependencies: (n.dependencies ?? []).map((d) => ({
        sig: d,
        object: bySig.get(d).object,
        status: state.status[d],
        swept: ledger.swept[d] !== undefined,
      })),
    }));
  return { remaining };
}

/** Record a sweep result in the LEDGER (never loop state — the reducer's semantics stay single-meaning). */
function cmdSweepMark(io, pos, flags) {
  const [runId, sig] = pos;
  const { plan } = load(io, runId);
  if (!plan.nodes.some((n) => n.id === sig)) throw new Error(`sweep-mark: unknown node ${sig}`);
  const result = flags.result;
  if (result !== "drafted" && result !== "failed") {
    throw new Error(`sweep-mark: --result must be 'drafted' or 'failed' (got '${result}')`);
  }
  const ledger = readSweepLedger(io, runId);
  if (ledger.swept[sig]?.result !== result) {
    ledger.swept[sig] = { result, ts: new Date().toISOString() };
    saveSweepLedger(io, runId, ledger);
    log(io, runId, "sweep-mark", { sig, result });
  }
  return { sig, result };
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
