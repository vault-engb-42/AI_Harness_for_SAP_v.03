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
import { readFileSync } from "node:fs";
import { driveDecision, driveReport, driveOfflineVerdict } from "./sched/drive.js";
import { loadRun, saveState, log, readBaselines } from "./cli-io.js";
import { renderOfflineNodeVerdict } from "./node/offline-checkpoint.js";
import { assembleBundle } from "./extract/bundle.js";
import { attestationsOf } from "./cli-attest.js";
import { filesFromBundle } from "../../analyser/src/modes.js";

const OUTCOMES = new Set(["syntax_ok", "syntax_fail", "generator_error"]);

export function cmdDrive(io, pos, flags) {
  const runId = pos[0];
  if (!runId) throw new Error("drive: usage: drive <run_id> [--report <sig>=<outcome>] [--verdict <sig> --before <dir> --after <dir>]");
  const { plan, state } = loadRun(io, runId);
  if (flags?.verdict) return offlineVerdictStep(io, runId, plan, state, flags);
  if (flags?.report === undefined || flags.report === "") return driveDecision(plan, state);
  const { sig, outcome } = parseReport(flags.report);
  const { state: next, action } = driveReport(plan, state, sig, outcome);
  saveState(io, runId, next);
  log(io, runId, "drive-report", { sig, outcome, action: action.action });
  return action;
}

/**
 * The OFFLINE verdict step (gap-2b B4+B5+B6, wired here by B6.5 F12 — before this the whole arc
 * had no executable entry point and the abap_fico offline E2E could not run).
 *
 * Extracts both sides into feature bundles, renders the offline verdict through the ratchet
 * composition, and hands the RESULT to the driver, which owns the retry-vs-escalate-vs-quarantine
 * decision. Attestations are joined from the AUDITED escalations register only — identical rule to
 * the live `verdict` verb, so the offline path cannot be attested by any softer route.
 *
 * Absence propagates deliberately: an omitted `--findings` yields undefined ATC counts rather than
 * zeros, so the judges' fail-closed guards fire instead of a fabricated clean pass (F5).
 */
function offlineVerdictStep(io, runId, plan, state, flags) {
  const sig = flags.verdict;
  if (!plan.nodes.some((n) => n.id === sig)) throw new Error(`drive: unknown node ${sig}`);
  if (!flags.before) throw new Error("drive --verdict: --before <dir> is required (the pre-modernisation source)");
  if (!flags.after) throw new Error("drive --verdict: --after <dir> is required (the node's generated artifacts)");

  const beforeFiles = filesFromBundle(flags.before);
  const afterFiles = filesFromBundle(flags.after);
  const result = renderOfflineNodeVerdict(
    { canonical_sig: sig },
    {
      before: assembleBundle(beforeFiles),
      after: assembleBundle(afterFiles),
      beforeFiles,
      afterFiles,
      findings: flags.findings ? JSON.parse(readFileSync(flags.findings, "utf8")) : undefined,
      baselines: readBaselines(io.stateDir),
      attestations: attestationsOf(io, sig, runId, state),
      touched_files: afterFiles.map((f) => f.filename),
    },
  );
  const { state: next, action } = driveOfflineVerdict(plan, state, sig, result);
  saveState(io, runId, next);
  log(io, runId, "drive-offline-verdict", { sig, provisional: result.provisional, action: action.action });
  return { ...action, verdict: { provisional: result.provisional, reasons: result.reasons } };
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
