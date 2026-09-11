import { readEscalations } from "./cli-io.js";
import { latestEvent } from "./exception/escalation-bus.js";

/**
 * Join an attestation from the AUDITED escalations register (ratified 2026-07-12/13). Shared by the
 * live `verdict` verb and the offline `drive --verdict` step so BOTH obey the same rule:
 * checkpoint-supplied attestation fields are never trusted, and the typed
 * `decide … <ATTEST-verb> --by <name>` verbs are the single path to attest.
 *
 * The LATEST EVENT governs, not the latest RAISE: an OPEN row's event is its `opened_at` (a
 * re-raise voids a prior attestation), a RESOLVED row's is its `resolved_at` — so the human's
 * temporally FINAL decision wins even across interleaved rows with overlapping node sets. Array
 * order breaks timestamp ties.
 *
 * The attestation is bound to this RUN (id + epoch) and this ARTIFACT (generation), so a
 * regenerated artifact, a --force-recreated run, or another run can never inherit one.
 *
 * @returns {string|null} the attester's name, or null when nothing valid applies
 */
export function registerAttestation(io, sig, runId, state, kind, attestDecision) {
  const rows = readEscalations(io).escalations.filter((e) => e.kind === kind && e.node_ids.includes(sig));
  const latest = latestEvent(rows); // EVERY row, OPEN included — a re-raise voids a prior attestation here
  if (latest?.status !== "RESOLVED" || latest?.decision !== attestDecision) return null;
  if (latest.run_id !== runId) return null;
  if ((latest.decided_epoch ?? null) !== (state.run_epoch ?? null)) return null;
  if ((latest.decided_generations?.[sig] ?? -1) !== (state.generation?.[sig] ?? 0)) return null;
  return latest.resolved_by;
}

/** Both attestation slots for a node, joined from the register only. */
export function attestationsOf(io, sig, runId, state) {
  return {
    parity_equivalence: registerAttestation(io, sig, runId, state, "PARITY_REVIEW", "ATTEST_EQUIVALENT"),
    auth_equivalence: registerAttestation(io, sig, runId, state, "AUTH_EQUIVALENCE", "ATTEST"),
    // R5: the artifact the analyser could not parse, read by a human instead. Same run+epoch+generation
    // binding as the other two, so a regenerated artifact voids it — a human who attested to code that has
    // since been rewritten has attested to nothing.
    artifact_reviewed: registerAttestation(io, sig, runId, state, "UNANALYSABLE_ARTIFACT", "ATTEST_REVIEWED"),
  };
}
