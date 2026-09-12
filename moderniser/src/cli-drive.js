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
import { existsSync } from "node:fs";
import { join } from "node:path";
import { driveDecision, driveReport, driveOfflineVerdict } from "./sched/drive.js";
import { loadRun, saveState, log, readBaselines, readEscalations, saveEscalations } from "./cli-io.js";
import { raiseEscalation } from "./exception/escalation-bus.js";
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

  // R2/R3 — scope the evidence to THIS node. The verdict is recorded per node, so grading it on the whole
  // generated tree lets a sibling's defects condemn a clean node, and the lane had no way to hand over a
  // per-node before-directory at all. Both sides are narrowed here rather than by argument, because a
  // caller cannot get wrong what it cannot supply (the same rule as R1's computed evidence).
  const attestations = attestationsOf(io, sig, runId, state);
  const node = plan.nodes.find((n) => n.id === sig);
  const afterDir = nodeScopedDir(flags.after, sig);
  const afterFiles = filesFromBundle(afterDir);
  const allBefore = filesFromBundle(flags.before);
  const beforeFiles = scopeToMembers(allBefore, node);
  const scope = {
    after: afterDir === flags.after ? "tree" : "node",
    before: beforeFiles.length === allBefore.length ? "tree" : "node",
  };

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
      attestations,
      touched_files: afterFiles.map((f) => f.filename),
    },
  );
  const folded = applyFinalReview(result, triageAll(review.findings), attestations);

  const { state: next, action } = driveOfflineVerdict(plan, state, sig, folded);
  saveState(io, runId, next);
  raiseOwedGates(io, runId, action);
  log(io, runId, "drive-offline-verdict", {
    sig,
    provisional: folded.provisional,
    action: action.action,
    final_review: folded.final_review.counts,
    scope,
    // R4: counts alone are not a record — they say three things were surfaced without saying what, so
    // nothing downstream can name them. BUILD_PLAN C1 calls the `document` case "a recorded suppression",
    // and the run log is the durable channel already in use. `document` is recorded in full because each
    // row is a question a human must answer; `recommend` is advisory and can run to dozens per node, so it
    // is recorded as its distinct rule set — enough to audit what was surfaced without copying the corpus
    // into the log. The full lists still reach the fulfiller on stdout.
    documented: folded.final_review.document.map((v) => ({ rule_id: v.rule_id, file: v.finding?.file, line: v.finding?.line })),
    recommended_rules: [...new Set(folded.final_review.recommend.map((v) => v.rule_id))].sort(),
  });
  return {
    ...action,
    verdict: { provisional: folded.provisional, reasons: folded.reasons },
    final_review: folded.final_review,
    scope,
  };
}

/**
 * Raise the gates the driver OWES into the durable register.
 *
 * `driveOfflineVerdict` computes the escalations and deliberately does not raise them — "Escalations are
 * RETURNED as intent, never raised here — raising touches the durable register, which is the CLI's job"
 * (sched/drive.js). The CLI never did that job, so the intent reached stdout and nothing else: no row
 * existed for `escalations`/`packets` to show, `decide` had no id to take a decision against, and
 * `registerAttestation` joins from the AUDITED register only — so the node rested at PROVISIONAL_GATED
 * awaiting a human, against a gate that did not exist. Found by the surface census.
 *
 * Raised AFTER the state is saved, matching cmdDecide's ordering rule: a crash between the two leaves a
 * node correctly awaiting a human with its gate not yet raised, which the idempotent next `drive --verdict`
 * heals. The reverse order would advertise a gate for a state that was never persisted.
 *
 * The bus dedupes an already-OPEN (kind, node-set), which matters more here than anywhere else: the lane
 * re-runs this step on every resume, and a re-raise VOIDS any attestation already recorded against it
 * (cli-attest.js — the latest EVENT governs), so a storming gate could never be cleared.
 */
function raiseOwedGates(io, runId, action) {
  const owed = action?.escalations ?? [];
  if (owed.length === 0) return;
  const ts = new Date().toISOString();
  // Per-gate, not per-batch. The bus dedupes an already-OPEN (kind, node-set), so on a resume some of the
  // owed gates are new and some are not — logging the whole `owed` list claimed a raise that did not
  // happen, which makes the run log say a gate reached the human on a step where it did not.
  let reg = readEscalations(io);
  const raised = [];
  for (const e of owed) {
    const next = raiseEscalation(reg, { kind: e.kind, node_ids: e.node_ids }, { ts });
    if (next !== reg) raised.push(e);
    reg = next;
  }
  if (raised.length === 0) return;
  saveEscalations(io, reg);
  log(io, runId, "escalate", {
    kinds: [...new Set(raised.map((e) => e.kind))].sort(),
    node_ids: [...new Set(raised.flatMap((e) => e.node_ids))].sort(),
  });
}

/**
 * `<after>/<sig>/` when the generator wrote per node, else `<after>` unchanged.
 *
 * Conditional on purpose: the lane keeps ONE instruction (`--after specs/abap/`) and it becomes node-scoped
 * the moment TRANSFORM adopts the per-node layout, so a run mid-migration degrades to the old, WIDER
 * evidence rather than failing. Wider is the safe direction — it can only over-report defects.
 */
function nodeScopedDir(after, sig) {
  const candidate = join(after, sig);
  return existsSync(candidate) ? candidate : after;
}

/**
 * The brownfield files belonging to this node's own objects. abapGit names every file for its object
 * (`zbc_fg_idoc_fw.fugr.*`), so the frozen node's `members` select them without needing a new extractor
 * verb — which is what made the per-node `--before` unbuildable.
 *
 * A node whose members match NOTHING keeps the whole bundle. That is deliberate: a corpus not following the
 * naming convention would otherwise be scoped down to zero before-files, and an empty before side reads as
 * "authorization vanished" — a fabricated block. A too-wide before side only makes the auth-coverage and
 * parity conjuncts stricter, so the fallback errs closed.
 */
function scopeToMembers(files, node) {
  const members = (node?.members ?? [node?.object]).filter(Boolean).map((m) => String(m).toLowerCase());
  if (members.length === 0) return files;
  const mine = files.filter((f) => {
    const base = String(f.filename).split(/[\\/]/).pop().toLowerCase();
    return members.some((m) => base === m || base.startsWith(`${m}.`));
  });
  return mine.length > 0 ? mine : files;
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
