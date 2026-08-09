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
import { driveDecision, driveReport, driveOfflineVerdict } from "./sched/drive.js";
import { loadRun, saveState, log, readBaselines } from "./cli-io.js";
import { renderOfflineNodeVerdict } from "./node/offline-checkpoint.js";
import { assembleBundle } from "./extract/bundle.js";
import { attestationsOf } from "./cli-attest.js";
import { filesFromBundle } from "../../analyser/src/modes.js";
import { analyzePackage } from "../../analyser/src/orchestrator.js";
import { triageAll, applyFinalReview } from "./node/final-review.js";

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
 * The ATC evidence is COMPUTED here, from the node's own generated artifacts, not accepted as an argument.
 * It was a `--findings` path until the R1 adversarial finding showed the lane was pointing it at the
 * BEFORE-side brownfield document (see the inline note below). F5's absence-propagation guard was the right
 * answer while a caller could omit the evidence; the evidence is now always present and always the right
 * side, which is a stronger position than failing closed on a missing flag.
 */
function offlineVerdictStep(io, runId, plan, state, flags) {
  const sig = flags.verdict;
  if (!plan.nodes.some((n) => n.id === sig)) throw new Error(`drive: unknown node ${sig}`);
  if (!flags.before) throw new Error("drive --verdict: --before <dir> is required (the pre-modernisation source)");
  if (!flags.after) throw new Error("drive --verdict: --after <dir> is required (the node's generated artifacts)");

  const beforeFiles = filesFromBundle(flags.before);
  const afterFiles = filesFromBundle(flags.after);

  // C1 — the final-output self-review. The analyser grades the artifacts we just generated (never the
  // BEFORE side: `extract/bundle.js:18` forbids that rescan as O(N²)). This ONE run feeds two consumers:
  // the verdict's ATC evidence below, and C2's triage. GAN-safe: the analyser grades, the generator
  // regenerates.
  const review = analyzePackage(afterFiles, { package: sig, source_system: `final-review:${sig}` });

  const result = renderOfflineNodeVerdict(
    { canonical_sig: sig },
    {
      before: assembleBundle(beforeFiles),
      after: assembleBundle(afterFiles),
      beforeFiles,
      afterFiles,
      // R1 (adversarial pass 2026-08-07, CONFIRMED with an end-to-end reproduction): this MUST be the
      // AFTER-side findings. It used to be whatever `--findings` pointed at, and the lane pointed it at
      // specs/brownfield/analyser-findings.json — the BEFORE side, the very document `plan` froze on. So
      // atc_p1/atc_p2 counted the PRE-modernisation source's defects: every node blocked on
      // atc-p*-nonzero however clean its output, regenerated three times against repair context describing
      // code it had already replaced, then quarantined at OFFLINE_VERDICT_CEILING. offline-checkpoint.js:22-26
      // states the contract — "The caller passes the AFTER-side findings — the generated artifact is what is
      // being judged." Computing it here instead of accepting it as a flag means the caller cannot get it
      // wrong, and removes the F5 absence case entirely: the evidence is always present and always real.
      findings: { findings: review.findings },
      baselines: readBaselines(io.stateDir),
      attestations: attestationsOf(io, sig, runId, state),
      touched_files: afterFiles.map((f) => f.filename),
    },
  );
  const folded = applyFinalReview(result, triageAll(review.findings));

  const { state: next, action } = driveOfflineVerdict(plan, state, sig, folded);
  saveState(io, runId, next);
  log(io, runId, "drive-offline-verdict", {
    sig,
    provisional: folded.provisional,
    action: action.action,
    final_review: folded.final_review.counts,
  });
  return {
    ...action,
    verdict: { provisional: folded.provisional, reasons: folded.reasons },
    final_review: folded.final_review,
  };
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
