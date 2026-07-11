#!/usr/bin/env node
/**
 * /modernise CLI (MODERNISER_DESIGN §6.5, §3.5 layer 2→3 boundary) — the deterministic
 * imperative shell over the pure reducer. The skill drives it via Bash between agent
 * dispatches; every mutating command persists state DURABLY (write→fsync→rename) and
 * appends a P8-scrubbed observability row (§6.6 — sigs/statuses/reasons only, never ABAP
 * source, never credentials). All output is JSON on stdout; failures exit 1 on stderr.
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
 *   status <run_id> · resume <run_id>
 * Common flags: --state-dir (default .claude/state) --runs-dir (default specs/runs)
 */
import { readFileSync, mkdirSync, renameSync, openSync, writeSync, fsyncSync, closeSync, appendFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { assemblePlan } from "./sched/assemble.js";
import { savePlan, loadPlan } from "./sched/plan.js";
import { initRun, nextDispatch, dispatch, applyProgress, applyOutcome, renderVerdict, recordVerdict, runComplete } from "./sched/loop.js";
import { onPass } from "./state/ratchet.js";

const COMMANDS = {
  plan: cmdPlan,
  next: cmdNext,
  dispatch: cmdDispatch,
  progress: cmdProgress,
  outcome: cmdOutcome,
  verdict: cmdVerdict,
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
  const next = applyOutcome(plan, state, sig, { status, reason: flags.reason, signed_by: flags["signed-by"] });
  saveState(io, runId, next);
  log(io, runId, "outcome", { sig, status, reason: flags.reason, signed_by: flags["signed-by"] });
  return { sig, status, complete: runComplete(plan, next) };
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

/** run ids reach path joins — reject separators and dot-segments (path traversal, P8). */
function validRunId(runId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) || runId.includes("..")) {
    throw new Error(`plan: invalid --run-id '${runId}' — [A-Za-z0-9._-] only, no separators or '..'`);
  }
  return runId;
}

/** team-size 0/negative/NaN would silently stall the frontier forever — fail loud instead. */
function parseTeamSize(raw) {
  if (raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`plan: --team-size must be an integer >= 1 (got '${raw}')`);
  return n;
}

// ---------- shared plumbing ----------

function load(io, runId) {
  if (!runId) throw new Error("a <run_id> is required");
  const plan = loadPlan(validRunId(runId), io.stateDir); // re-hashes, rejects tamper/unknown major
  const state = JSON.parse(readFileSync(statePath(io, runId), "utf8"));
  if (state.plan_hash !== plan.plan_hash) {
    throw new Error(`resume: state plan_hash ${state.plan_hash} does not match plan ${plan.plan_hash} — REPLAN required`);
  }
  return { plan, state };
}

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

const statePath = (io, runId) => join(io.stateDir, "runs", `${runId}.state.json`);

const saveState = (io, runId, state) => writeDurable(statePath(io, runId), JSON.stringify(state, null, 2));

/** durable commit: write temp → fsync → atomic rename (§3.3; git-add is the caller's step). */
function writeDurable(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/**
 * Two-phase baseline pair commit: BOTH files are fully written+fsynced before either rename,
 * shrinking the tear window to the instant between renames. A tear there is FAIL-SAFE by
 * monotonicity — baselines only tighten, so a half-advanced pair can only over-block.
 */
function writeBaselinePair(stateDir, { atcBaseline, covBaseline }) {
  const targets = [
    [join(stateDir, "atc-baseline.json"), JSON.stringify(atcBaseline, null, 2)],
    [join(stateDir, "abapunit-baseline.json"), JSON.stringify(covBaseline, null, 2)],
  ];
  const prepared = targets.map(([path, text]) => {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return [tmp, path];
  });
  for (const [tmp, path] of prepared) renameSync(tmp, path);
}

/** §6.6 observability row — P8-scrubbed: identifiers and statuses only. */
function log(io, runId, event, fields) {
  const dir = join(io.runsDir, runId);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "log.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), run_id: runId, event, ...fields })}\n`, "utf8");
}

function readBaselines(stateDir) {
  return {
    atcBaseline: readJson(join(stateDir, "atc-baseline.json"), { per_object: {} }),
    covBaseline: readJson(join(stateDir, "abapunit-baseline.json"), { per_object: {} }),
  };
}

const readJson = (path, fallback) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback);

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const pos = [];
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i].startsWith("--")) {
      const name = rest[i].slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[name] = next;
        i += 1;
      } else {
        flags[name] = ""; // bare flag (e.g. --record, --force)
      }
    } else {
      pos.push(rest[i]);
    }
  }
  return { cmd, pos, flags };
}

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
