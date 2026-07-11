#!/usr/bin/env node
/**
 * /modernise CLI (MODERNISER_DESIGN §6.5, §3.5 layer 2→3 boundary) — the deterministic
 * imperative shell over the pure reducer. The skill drives it via Bash between agent
 * dispatches; every mutating command persists state DURABLY (write→fsync→rename) and
 * appends a P8-scrubbed observability row (§6.6 — sigs/statuses/reasons only, never ABAP
 * source, never credentials). All output is JSON on stdout; failures exit 1 on stderr.
 *
 * Commands:
 *   plan <findings.json> [--run-id id] [--team-size N]      assemble → freeze → init
 *   next <run_id>                                           the ready frontier batch
 *   dispatch <run_id> <sig...>                              hand to node drivers (readiness-guarded)
 *   progress <run_id> <sig> <STATUS>                        FSM-checked phase move
 *   outcome <run_id> <sig> <STATUS> [--reason r]            terminal outcome (GREEN/BLOCK/PARK/SEAM)
 *   verdict <run_id> <sig> --checkpoint f --evidence f [--record]   ratchet→verdict composition
 *   status <run_id>                                         counts, quarantine, park, ready-now
 *   resume <run_id>                                         verify plan_hash + state binding, report
 * Common flags: --state-dir (default .claude/state) --runs-dir (default specs/runs)
 */
import { readFileSync, mkdirSync, renameSync, openSync, writeSync, fsyncSync, closeSync, appendFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { assemblePlan } from "./sched/assemble.js";
import { savePlan, loadPlan } from "./sched/plan.js";
import { initRun, nextDispatch, dispatch, applyProgress, applyOutcome, renderVerdict, runComplete } from "./sched/loop.js";
import { onPass } from "./state/ratchet.js";

function main(argv) {
  const { cmd, pos, flags } = parseArgs(argv);
  const stateDir = flags["state-dir"] ?? ".claude/state";
  const runsDir = flags["runs-dir"] ?? "specs/runs";
  const io = { stateDir, runsDir };

  switch (cmd) {
    case "plan": {
      const doc = JSON.parse(readFileSync(pos[0], "utf8"));
      const { plan } = assemblePlan(doc, { generator_team_size: flags["team-size"] ? Number(flags["team-size"]) : null });
      const runId = flags["run-id"] ?? `run-${plan.plan_hash.slice(0, 12)}`;
      savePlan(runId, plan, stateDir);
      saveState(io, runId, initRun(plan));
      log(io, runId, "plan", { plan_hash: plan.plan_hash, nodes: plan.nodes.length });
      return out({
        run_id: runId,
        plan_hash: plan.plan_hash,
        nodes: plan.nodes.map((n) => ({ sig: n.id, object: n.object, wave: n.wave })),
        waves: plan.waves.length,
      });
    }
    case "next": {
      const { plan, state } = load(io, pos[0]);
      return out({ ready: describe(plan, nextDispatch(plan, state)) });
    }
    case "dispatch": {
      const [runId, ...sigs] = pos;
      const { plan, state } = load(io, runId);
      saveState(io, runId, dispatch(plan, state, sigs));
      for (const sig of sigs) log(io, runId, "dispatch", { sig });
      return out({ dispatched: sigs });
    }
    case "progress": {
      const [runId, sig, status] = pos;
      const { plan, state } = load(io, runId);
      saveState(io, runId, applyProgress(plan, state, sig, status));
      log(io, runId, "progress", { sig, status });
      return out({ sig, status });
    }
    case "outcome": {
      const [runId, sig, status] = pos;
      const { plan, state } = load(io, runId);
      const next = applyOutcome(plan, state, sig, { status, reason: flags.reason });
      saveState(io, runId, next);
      log(io, runId, "outcome", { sig, status, reason: flags.reason });
      return out({ sig, status, complete: runComplete(plan, next) });
    }
    case "verdict": {
      const [runId, sig] = pos;
      const { plan } = load(io, runId);
      const node = plan.nodes.find((n) => n.id === sig);
      if (!node) throw new Error(`verdict: unknown node ${sig}`);
      const checkpoint = JSON.parse(readFileSync(flags.checkpoint, "utf8"));
      const evidence = JSON.parse(readFileSync(flags.evidence, "utf8"));
      const baselines = readBaselines(stateDir);
      const gateNode = { canonical_sig: sig, parity_required: node.parity_required, diff_changed_lines: evidence.diff_changed_lines ?? [] };
      const r = renderVerdict(gateNode, checkpoint, evidence, baselines);
      if (r.green && flags.record !== undefined) {
        const updated = onPass(gateNode, evidence, baselines); // copy-on-write; throws on BLOCK
        writeDurable(join(stateDir, "atc-baseline.json"), JSON.stringify(updated.atcBaseline, null, 2));
        writeDurable(join(stateDir, "abapunit-baseline.json"), JSON.stringify(updated.covBaseline, null, 2));
        log(io, runId, "baselines-recorded", { sig, delta: r.gate.delta });
      }
      log(io, runId, "verdict", { sig, green: r.green, gate: r.gate.verdict, score: evidence.parity_score });
      return out(r);
    }
    case "status": {
      const { plan, state } = load(io, pos[0]);
      return out(statusOf(plan, state));
    }
    case "resume": {
      const runId = pos[0];
      const { plan, state } = load(io, runId); // loadPlan re-hashes; bind() rejects a foreign state
      log(io, runId, "resume", {});
      return out({ verified: true, run_id: runId, plan_hash: plan.plan_hash, status: statusOf(plan, state) });
    }
    default:
      throw new Error(`unknown command '${cmd}' — see moderniser/src/cli.js header for usage`);
  }
}

/** Load the verified plan + its bound state (fail-closed on either hash). */
function load(io, runId) {
  if (!runId) throw new Error("a <run_id> is required");
  const plan = loadPlan(runId, io.stateDir); // re-hashes, rejects tamper/unknown major
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

function statePath(io, runId) {
  return join(io.stateDir, "runs", `${runId}.state.json`);
}

function saveState(io, runId, state) {
  writeDurable(statePath(io, runId), JSON.stringify(state, null, 2));
}

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

function readJson(path, fallback) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
}

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
        flags[name] = ""; // bare flag (e.g. --record)
      }
    } else {
      pos.push(rest[i]);
    }
  }
  return { cmd, pos, flags };
}

const out = (obj) => process.stdout.write(`${JSON.stringify(obj, null, 1)}\n`);

try {
  main(process.argv.slice(2));
} catch (e) {
  // CLI process boundary: the one place a broad catch is correct — surface and exit non-zero.
  process.stderr.write(`modernise: ${e.message}\n`);
  process.exit(1);
}
