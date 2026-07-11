/**
 * IO plumbing for the /modernise CLI — durable commits, the §6.6 observability log, the
 * sweep ledger, and arg parsing. Kept apart from the command handlers (cli.js) so each file
 * stays within the size limit and the persistence rules live in one place:
 *   - state/plan/baselines: write temp → fsync → atomic rename (§3.3; git-add is the shell's step)
 *   - baseline PAIR: both files fsynced before either rename — a residual tear is fail-SAFE
 *     by monotonicity (baselines only tighten, so a half-advanced pair can only over-block)
 *   - sweep ledger (specs/runs/<run_id>/sweep.json): the offline draft sweep's bookkeeping,
 *     DELIBERATELY outside the loop state (§6.5 draft-sweep decision — the reducer's
 *     counters/FSM/earned-GREEN stay single-meaning; an online resume re-gates everything)
 *   - log rows are P8-scrubbed: identifiers and statuses only, never ABAP source
 */
import { readFileSync, mkdirSync, renameSync, openSync, writeSync, fsyncSync, closeSync, appendFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

export const statePath = (io, runId) => join(io.stateDir, "runs", `${runId}.state.json`);

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
