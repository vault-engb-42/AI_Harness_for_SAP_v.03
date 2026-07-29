/**
 * IO plumbing for the /modernise CLI — durable commits, the §6.6 observability log, the
 * sweep ledger, and arg parsing. Kept apart from the command handlers (cli.js) so each file
 * stays within the size limit and the persistence rules live in one place:
 *   - state/plan/baselines: write temp → fsync → atomic rename (§3.3; git-add is the shell's step)
 *   - baseline PAIR: both files fsynced before either rename — a residual tear is fail-SAFE
 *     by monotonicity (baselines only tighten, so a half-advanced pair can only over-block)
 *   - sweep ledger (specs/runs/<run_id>/sweep.json): the offline draft sweep's bookkeeping,
 *     DELIBERATELY outside the loop state (§6.5 draft-sweep decision — the reducer's
 *     counters/FSM/earned-GREEN stay single-meaning; a live resume re-gates everything)
 *   - log rows are P8-scrubbed: identifiers and statuses only, never ABAP source
 */
import { readFileSync, mkdirSync, renameSync, openSync, writeSync, fsyncSync, closeSync, appendFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { loadPlan } from "./sched/plan.js";

export const statePath = (io, runId) => join(io.stateDir, "runs", `${runId}.state.json`);

/** run ids reach path joins — reject separators and dot-segments (path traversal, P8). */
export function validRunId(runId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) || runId.includes("..")) {
    throw new Error(`invalid run id '${runId}' — [A-Za-z0-9._-] only, no separators or '..'`);
  }
  return runId;
}

/** Load the verified plan + its bound state (fail-closed on either hash). */
export function loadRun(io, runId) {
  if (!runId) throw new Error("a <run_id> is required");
  const plan = loadPlan(validRunId(runId), io.stateDir); // re-hashes, rejects tamper/unknown major
  const state = readJson(statePath(io, runId), null);
  if (state === null) throw new Error(`no state for run '${runId}'`);
  if (state.plan_hash !== plan.plan_hash) {
    throw new Error(`resume: state plan_hash ${state.plan_hash} does not match plan ${plan.plan_hash} — REPLAN required`);
  }
  return { plan, state };
}

// ---- exception-family registers (§3.4 #6 shapes, durably committed) ----

export const readEscalations = (io) => readJson(join(io.stateDir, "escalations.json"), { escalations: [] });
export const saveEscalations = (io, reg) => writeDurable(join(io.stateDir, "escalations.json"), JSON.stringify(reg, null, 2));
export const readParkRegister = (io) => readJson(join(io.stateDir, "park-register.json"), { parked: [] });
export const saveParkRegister = (io, reg) => writeDurable(join(io.stateDir, "park-register.json"), JSON.stringify(reg, null, 2));
export const readSeamMemory = (io) => readJson(join(io.stateDir, "seam-memory.json"), { learned: {} });
export const saveSeamMemory = (io, mem) => writeDurable(join(io.stateDir, "seam-memory.json"), JSON.stringify(mem, null, 2));

export const saveState = (io, runId, state) => writeDurable(statePath(io, runId), JSON.stringify(state, null, 2));

export function writeDurable(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path); // atomic swap on the same filesystem
}

/** Two-phase baseline pair commit: prepare (write+fsync) both, then rename both. */
export function writeBaselinePair(stateDir, { atcBaseline, covBaseline }) {
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

/** §6.6 observability row — P8-scrubbed. */
export function log(io, runId, event, fields) {
  const dir = join(io.runsDir, runId);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "log.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), run_id: runId, event, ...fields })}\n`, "utf8");
}

export const sweepPath = (io, runId) => join(io.runsDir, runId, "sweep.json");

export const readSweepLedger = (io, runId) => readJson(sweepPath(io, runId), { swept: {} });

export const saveSweepLedger = (io, runId, ledger) => writeDurable(sweepPath(io, runId), JSON.stringify(ledger, null, 2));

// disposition manifest (B3, §6.11) — the plan-gate artifact at specs/runs/<run_id>/disposition-manifest.json
export const dispositionManifestPath = (io, runId) => join(io.runsDir, runId, "disposition-manifest.json");
export const readDispositionManifest = (io, runId) => readJson(dispositionManifestPath(io, runId), null);
export const saveDispositionManifest = (io, runId, m) => writeDurable(dispositionManifestPath(io, runId), JSON.stringify(m, null, 2));

export function readBaselines(stateDir) {
  return {
    atcBaseline: readJson(join(stateDir, "atc-baseline.json"), { per_object: {} }),
    covBaseline: readJson(join(stateDir, "abapunit-baseline.json"), { per_object: {} }),
  };
}

export const readJson = (path, fallback) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback);

export function parseArgs(argv) {
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
