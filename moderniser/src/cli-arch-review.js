/**
 * The INDEPENDENT REVIEWER's write seam for the architecture gate (D).
 *
 * GAN separation is a prime directive: the writer never grades its own work. At gate 2 the judge
 * (arch-reason + the `arch-judge` model role) proposes a target_shape, and a fresh-context
 * `abap-arch-reviewer` is meant to grade that JUDGMENT — is the disposition right, is the shape over-built
 * for the object's actual consumption surface, is any named API ungrounded. The agent and the manifest slot
 * both existed, but nothing could ever WRITE the verdict: `reviewer_verdict` was hardcoded null, so the
 * independent review was prose in a skill file rather than a step the gate could see.
 *
 * `arch-review <run_id> <sig> --verdict <file> --by <reviewer>` records it against the contract that was
 * actually reviewed (bound to its contract_hash, so a later contract change cannot inherit an old review),
 * and `cmdDecide` refuses to ratify without one.
 *
 * GAP 3 (2026-09-10): a `pass` now RATIFIES. The decisive argument is this repository's own stated
 * principle, at the top of escalation-bus.js — "The human is an exception handler + attester, NEVER A
 * VOLUME GATE" — against a measured 196 human decisions to modernise the four corpora. It does not weaken
 * GAN separation: the rule is that the GENERATOR must not grade itself, and this reviewer is a
 * fresh-context agent that never sees the judge's session, reads the real source, and may rule the
 * disposition itself wrong. The grader is still not the writer; what changes is whether a SECOND grader
 * must also sign every object.
 *
 * It implements the reviewer's OWN vocabulary rather than reinterpreting it: `concerns` is defined as
 * "defensible but something deserves the human's eye" and `fail` as "wrong on the evidence", so only
 * `pass` ratifies. Until now that vocabulary was recorded and then ignored — a produced fact with no
 * consumer, in the most consequential gate here. A human may still ratify over concerns; that is their
 * call and is unchanged. P5 is untouched: offline never GREENs and a human still releases the transport.
 */
import { readFileSync } from "node:fs";
import { bindArchContract } from "./plan/arch-contract.js";
import { recordArchDecision } from "./plan/arch-gate.js";
import { loadRun, saveState, log, readEscalations, saveEscalations } from "./cli-io.js";

/** The closed verdict vocabulary the abap-arch-reviewer renders. */
export const REVIEWER_VERDICTS = ["pass", "concerns", "fail"];

export function cmdArchReview(io, pos, flags) {
  const [runId, sig] = pos;
  const { plan, state } = loadRun(io, runId);
  if (typeof flags.by !== "string" || !flags.by) throw new Error("arch-review: --by <reviewer> is required (the named independent reviewer)");
  if (typeof flags.verdict !== "string" || !flags.verdict) throw new Error("arch-review: --verdict <file> is required (the reviewer's rendered verdict)");
  if (!plan.nodes.some((n) => n.id === sig)) throw new Error(`arch-review: unknown node ${sig}`);

  const binding = state.arch_contracts?.[sig];
  if (!binding?.hash) {
    throw new Error(`arch-review: ${sig} has no bound Architecture Contract to review — run \`arch\` first`);
  }
  const payload = parseVerdict(readFileSync(flags.verdict, "utf8"));
  const reviewer_verdict = { ...payload, reviewed_by: flags.by, contract_hash: binding.hash };

  // GAP 3. `pass` ratifies; anything else leaves the human gate open, because the reviewer's own vocabulary
  // says so. The attribution is `auto:<reviewer>` and NEVER a person's name — an automatic ratification that
  // reads as a human signature would be a fabricated attestation, which is the one thing this gate exists to
  // make impossible. It names the reviewer that supplied the basis, so the trail stays answerable.
  const autoRatify = payload.verdict === "pass";
  const ratified_by = autoRatify ? `auto:${flags.by}` : (binding.ratified_by ?? null);
  saveState(io, runId, bindArchContract(state, sig, { ...binding, reviewer_verdict, ratified_by }));

  if (autoRatify) {
    // Resolve the human gate too. Leaving it OPEN while the contract is ratified would show the operator a
    // decision that no longer needs making — the duplicate-row erosion `cmdArch` already avoids on re-runs.
    const reg = readEscalations(io);
    const esc = reg.escalations.find((e) => e.kind === "ARCH_REVIEW" && e.status === "OPEN" && e.node_ids?.[0] === sig);
    if (esc) {
      saveEscalations(io, recordArchDecision(reg, esc.id, "approve", {
        decided_by: ratified_by, ts: new Date().toISOString(), run_id: runId,
        contract_hash: binding.hash, reviewer_verdict,
      }));
    }
  }

  log(io, runId, "arch-review", { sig, verdict: payload.verdict, flags: payload.flags, reviewed_by: flags.by, auto_ratified: autoRatify });
  return { run_id: runId, sig, verdict: payload.verdict, flags: payload.flags, contract_hash: binding.hash, auto_ratified: autoRatify };
}

/** Validate the reviewer's payload against a closed shape — it is agent output crossing into durable state. */
function parseVerdict(text) {
  const doc = JSON.parse(text);
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error("arch-review: the verdict file must contain an object {verdict, flags, notes?}");
  }
  if (!REVIEWER_VERDICTS.includes(doc.verdict)) {
    throw new Error(`arch-review: verdict must be one of ${REVIEWER_VERDICTS.join(" | ")} (got '${doc.verdict ?? "∅"}')`);
  }
  if (!Array.isArray(doc.flags) || doc.flags.some((f) => typeof f !== "string")) {
    throw new Error("arch-review: flags must be an array of strings (e.g. over_built, ungrounded_api, wrong_disposition)");
  }
  return {
    verdict: doc.verdict,
    flags: [...doc.flags],
    ...(typeof doc.notes === "string" && doc.notes ? { notes: doc.notes } : {}),
  };
}

/**
 * The ratification precondition: the contract being approved must carry an independent review OF ITSELF.
 * Throws otherwise — approving unreviewed judgment is exactly the self-grading GAN separation forbids.
 */
export function assertReviewed(state, sig) {
  const binding = state.arch_contracts?.[sig];
  const review = binding?.reviewer_verdict;
  if (!review) {
    throw new Error(
      `decide: ${sig} has no independent reviewer verdict — run \`arch-review\` first; ratifying unreviewed judgment breaks GAN separation`,
    );
  }
  if (review.contract_hash !== binding.hash) {
    throw new Error(
      `decide: ${sig}'s reviewer verdict is for contract ${review.contract_hash}, but the bound contract is ${binding.hash} — re-review what is actually being ratified`,
    );
  }
}
