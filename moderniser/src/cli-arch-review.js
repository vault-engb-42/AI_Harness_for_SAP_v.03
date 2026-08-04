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
 * and `cmdDecide` refuses to ratify without one. The verdict's CONTENT does not decide anything — a human
 * may ratify over a reviewer's concerns, which is their call — but it must exist and must be about the
 * contract being ratified.
 */
import { readFileSync } from "node:fs";
import { bindArchContract } from "./plan/arch-contract.js";
import { loadRun, saveState, log } from "./cli-io.js";

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
  saveState(io, runId, bindArchContract(state, sig, { ...binding, reviewer_verdict }));
  log(io, runId, "arch-review", { sig, verdict: payload.verdict, flags: payload.flags, reviewed_by: flags.by });
  return { run_id: runId, sig, verdict: payload.verdict, flags: payload.flags, contract_hash: binding.hash };
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
