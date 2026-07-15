/**
 * The `drive <run_id>` verb — one step of the deterministic driver (MODERNISER_DRIVER_AND_GAP2_DESIGN
 * Phase 2). Loads the run and returns the ONE next action the /modernise fulfiller must take:
 * {generate | await_human | provisional_complete | complete | blocked}. The fulfiller performs it
 * (spawn the generator, write artifacts, run SELF_CHECK, report the outcome), then calls `drive` again.
 *
 * Two modes (Option A — ALL mutation rides on --report; bare `drive` stays READ-ONLY):
 *   drive <run_id>                                  → read-only next-action decision (reducer verbs own mutation)
 *   drive <run_id> --report <sig>=<outcome>         → the driver OWNS retry-vs-ceiling: it counts the
 *     syntax attempts, decides retry-vs-BLOCK, persists the state, and returns the next action.
 *     <outcome> ∈ {syntax_ok | syntax_fail | generator_error}.
 */
import { driveDecision, driveReport } from "./sched/drive.js";
import { loadRun, saveState, log } from "./cli-io.js";

const OUTCOMES = new Set(["syntax_ok", "syntax_fail", "generator_error"]);

export function cmdDrive(io, pos, flags) {
  const runId = pos[0];
  if (!runId) throw new Error("drive: usage: drive <run_id> [--report <sig>=<syntax_ok|syntax_fail|generator_error>]");
  const { plan, state } = loadRun(io, runId);
  if (flags?.report === undefined || flags.report === "") return driveDecision(plan, state);
  const { sig, outcome } = parseReport(flags.report);
  const { state: next, action } = driveReport(plan, state, sig, outcome);
  saveState(io, runId, next);
  log(io, runId, "drive-report", { sig, outcome, action: action.action });
  return action;
}

/** `<sig>=<outcome>` — split on the LAST '=' (the outcome vocabulary carries none), validate both. */
function parseReport(raw) {
  const eq = raw.lastIndexOf("=");
  if (eq <= 0) throw new Error(`drive: --report must be <sig>=<outcome> (got '${raw}')`);
  const sig = raw.slice(0, eq);
  const outcome = raw.slice(eq + 1);
  if (!OUTCOMES.has(outcome)) {
    throw new Error(`drive: --report outcome must be syntax_ok|syntax_fail|generator_error (got '${outcome}')`);
  }
  return { sig, outcome };
}
