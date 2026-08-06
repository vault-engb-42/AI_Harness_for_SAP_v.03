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
import { buildDroppedFeatures } from "./plan/dropped-features.js";
import { tryPark } from "./exception/park.js";

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
// arch-reason verdict cache (B3.5a, S14/ADDITION A) — CROSS-RUN (io.stateDir root, not run-scoped) so a
// re-analyse reuses a frozen judgment; entry_hash integrity is verified in state/arch-verdict-cache.js.
export const readArchVerdictCache = (io) => readJson(join(io.stateDir, "arch-verdict-cache.json"), { entries: {} });
export const saveArchVerdictCache = (io, cache) => writeDurable(join(io.stateDir, "arch-verdict-cache.json"), JSON.stringify(cache, null, 2));

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

/**
 * The §3.4 #5/#6 audited park row. REPLACE-not-skip (F17/F26): every PARK is a FRESH audited sign-off — a
 * stale row from an earlier park episode must not shadow the new signer/justification/probe (episode
 * history lives in git + log.jsonl; the register holds the CURRENT park). An exact crash-retry rewrites the
 * same content — idempotent in effect.
 */
export function parkAudit(io, sig, flags) {
  const reg = readParkRegister(io);
  const cleared = { ...reg, parked: reg.parked.filter((p) => p.node_id !== sig) };
  saveParkRegister(io, tryPark(cleared, sig, {
    reason: flags.reason,
    signed_by: flags["signed-by"],
    justification: flags.justification,
    successor_probe: flags["successor-probe"],
    ts: new Date().toISOString(),
  }));
}

/**
 * The dropped-features ledger (B4) at `specs/runs/<run_id>/dropped-features.json`. RECOMPUTED from the
 * frozen plan + the audited disposition register on every disposition terminal, so it can never drift from
 * either — the shell owns the write; the join itself is pure (plan/dropped-features.js).
 */
export const droppedFeaturesPath = (io, runId) => join(io.runsDir, runId, "dropped-features.json");
export const readDroppedFeatures = (io, runId) => readJson(droppedFeaturesPath(io, runId), null);
export function writeDroppedFeatures(io, runId, plan, state) {
  writeDurable(droppedFeaturesPath(io, runId), JSON.stringify(buildDroppedFeatures(plan, state, { run_id: runId }), null, 2));
}

// architecture manifest + per-sig Architecture Contracts (B3.5a, S12/§6.13) — the arch-gate artifacts at
// specs/runs/<run_id>/. The contract filename embeds the node sig, so guard it against path traversal (P8).
export const architectureManifestPath = (io, runId) => join(io.runsDir, runId, "architecture-manifest.json");
export const readArchManifest = (io, runId) => readJson(architectureManifestPath(io, runId), null);
export const saveArchManifest = (io, runId, m) => writeDurable(architectureManifestPath(io, runId), JSON.stringify(m, null, 2));
/**
 * The contract's ref RELATIVE to io.runsDir (`<run_id>/arch-contract-<sig>.json`). The ref is persisted in
 * durable run state and committed, so it must not carry an absolute host path — that would bind the run to
 * one machine's directory layout and leak it into the record. Resolve it with `archContractPath`.
 */
export function archContractRef(runId, sig) {
  if (!/^[A-Za-z0-9._-]+$/.test(sig) || sig.includes("..")) {
    throw new Error(`invalid contract sig '${sig}' — [A-Za-z0-9._-] only, no separators or '..' (path traversal, P8)`);
  }
  return `${validRunId(runId)}/arch-contract-${sig}.json`;
}
export const archContractPath = (io, runId, sig) => join(io.runsDir, archContractRef(runId, sig));
/**
 * Resolve a STORED contract ref (the counterpart to `archContractRef`, which mints one). Re-validated on
 * READ, not merely on write: run state is durable and hand-editable, so the shape is re-checked here before
 * it reaches a path join (P8). A binding survives a replan, and the contract stays in the run it was frozen
 * under — so resolving the bound ref is what lets the ratification the human gave still be honoured.
 */
export function archContractPathFromRef(io, ref) {
  if (typeof ref !== "string" || !/^[A-Za-z0-9._-]+\/arch-contract-[A-Za-z0-9._-]+\.json$/.test(ref) || ref.includes("..")) {
    throw new Error(`invalid contract ref '${ref}' — expected '<run_id>/arch-contract-<sig>.json' with no separators or dot-segments (path traversal, P8)`);
  }
  return join(io.runsDir, ref);
}
export const saveArchContract = (io, runId, sig, c) => writeDurable(archContractPath(io, runId, sig), JSON.stringify(c, null, 2));

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
