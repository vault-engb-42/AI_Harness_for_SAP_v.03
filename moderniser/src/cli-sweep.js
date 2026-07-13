/**
 * Offline draft-sweep verbs for the /modernise CLI (MODERNISER_DESIGN §6.5, ratified
 * 2026-07-11 as Option C): the sweep is a SEPARATE ledger (`specs/runs/<run_id>/sweep.json`)
 * — never loop state — so the reducer's counters/FSM/earned-GREEN stay single-meaning and
 * an online resume re-gates everything.
 *
 *   sweep-order <run_id>                                  the not-yet-swept PENDING nodes, topological
 *   sweep-mark  <run_id> <sig> --result drafted|failed    ledger a sweep outcome (PENDING nodes only)
 */
import { loadRun, readSweepLedger, saveSweepLedger, log } from "./cli-io.js";

/**
 * The nodes the gated pass could not reach (still PENDING — their closure can never green
 * offline), in plan-topological order (wave asc — the bottom-up level IS a topological
 * order), with each dependency's current status so the generator knows which drafts to
 * ground against. READ-ONLY on loop state.
 */
export function cmdSweepOrder(io, pos) {
  const [runId] = pos;
  const { plan, state } = loadRun(io, runId);
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
        swept: ledger.swept[d]?.result === "drafted", // a FAILED sweep left no draft to ground against (F16)
        sweep_result: ledger.swept[d]?.result ?? null,
      })),
    }));
  return { remaining };
}

/** Record a sweep result in the LEDGER (never loop state — the reducer's semantics stay single-meaning). */
export function cmdSweepMark(io, pos, flags) {
  const [runId, sig] = pos;
  const { plan, state } = loadRun(io, runId);
  if (!plan.nodes.some((n) => n.id === sig)) throw new Error(`sweep-mark: unknown node ${sig}`);
  if (state.status[sig] !== "PENDING") {
    // the sweep covers only what the gated pass could NOT reach — marking a gated-pass
    // node would pollute the proof-bundle ledger (F16 secondary)
    throw new Error(`sweep-mark: ${sig} is ${state.status[sig]} — only gated-pass-unreached (PENDING) nodes are sweepable (§6.5)`);
  }
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
