/**
 * The CONTRACT ENFORCEMENT seam — S6's `loadContract` read path plus the verb that finally uses it (H).
 *
 * A ratified Architecture Contract was previously INERT: `checkConformance` (S7) had no production caller
 * anywhere, and `loadContract` existed only as two JSDoc references. So a contract could be frozen,
 * independently reviewed and human-ratified, and nothing ever checked that what got generated was the thing
 * that had been approved. The gate produced a decision no downstream step consumed.
 *
 * `conformance <run_id> <sig> --generated <file>` closes the loop:
 *   1. LOAD through the S6 seam — read the contract at the ref bound in run state and verify its
 *      `contract_hash` against the hash the human ratified. An edited contract therefore FAILS CLOSED rather
 *      than being silently enforced; per S6 that is what re-opens ARCH_REVIEW.
 *   2. REQUIRE ratification — checking output against architecture no human approved proves nothing.
 *   3. CHECK `output ⊨ contract` via the shipped pure gate, and exit 2 on a violation (the same blocking
 *      convention as the gap-2a rule gate).
 *
 * On the generated set being fulfiller-declared: that is not self-grading. The contract was frozen and
 * ratified BEFORE generation and is hash-pinned here, so a generator cannot retroactively widen what it is
 * measured against. What this gate proves is "you built exactly what was ratified — no more, no less". It
 * does NOT prove an invariant is correctly implemented; that is the abap-security-reviewer's job (P4), and
 * the two are complementary, not substitutes.
 */
import { readFileSync } from "node:fs";
import { checkConformance } from "./sched/conformance.js";
import { isArchRatified } from "./plan/arch-contract.js";
import { loadRun, archContractPath, archContractPathFromRef, log } from "./cli-io.js";

export function cmdConformance(io, pos, flags) {
  const [runId, sig] = pos;
  const { plan, state } = loadRun(io, runId);
  if (typeof flags.generated !== "string" || !flags.generated) {
    throw new Error("conformance: --generated <file> is required (the objects the fulfiller produced for this node)");
  }
  if (!plan.nodes.some((n) => n.id === sig)) throw new Error(`conformance: unknown node ${sig}`);

  const contract = loadContract(io, runId, sig, state);
  const generated = JSON.parse(readFileSync(flags.generated, "utf8"));
  const { ok, violations } = checkConformance(generated, contract);
  log(io, runId, "conformance", { sig, ok, violations: violations.length });
  // `blocked` is the CLI's non-zero-exit convention (cli.js turns it into exit 2), so a conformance failure
  // stops the SELF_CHECK exactly like a rule-gate hit rather than being a line of JSON nobody reads.
  return { run_id: runId, sig, contract_hash: contract.contract_hash, ok, violations, ...(ok ? {} : { blocked: true }) };
}

/**
 * The S6 READ SEAM (impure): hydrate the ratified contract for a node, fail-closed on anything that would
 * make enforcement meaningless — no binding, no human ratification, a missing file, or an on-disk
 * `contract_hash` that is not the one the human approved.
 *
 * @param {{runsDir: string}} io @param {string} runId @param {string} sig @param {object} state the run state
 * @returns {object} the ratified contract
 */
export function loadContract(io, runId, sig, state) {
  const binding = state.arch_contracts?.[sig];
  if (!binding?.hash) {
    throw new Error(`conformance: ${sig} has no bound Architecture Contract — run \`arch\` first`);
  }
  if (!isArchRatified(state, sig)) {
    throw new Error(`conformance: ${sig}'s Architecture Contract is not human-ratified — checking output against unapproved architecture proves nothing`);
  }
  // Resolve the BOUND ref, not a path re-derived from the current run (R5). The binding survives a replan
  // while the contract file stays in the run it was frozen under, so re-deriving looked in a directory
  // nothing had written yet and failed closed on a path the operator had never seen. sched/drive.js already
  // hands the fulfiller this same `ref` — one binding must have one resolution rule, or the two readers
  // disagree about which file the human actually ratified. The derived path remains the fallback for a
  // binding written before refs were recorded.
  const path = binding.ref ? archContractPathFromRef(io, binding.ref) : archContractPath(io, runId, sig);
  let contract;
  try {
    contract = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    // Narrow, deliberate: an unreadable/unparseable contract is a fail-closed condition, and the operator
    // needs the path plus the underlying reason to act on it.
    throw new Error(`conformance: cannot read the Architecture Contract at ${path} — ${e.message}`);
  }
  if (contract.contract_hash !== binding.hash) {
    throw new Error(
      `conformance: the contract at ${path} has hash ${contract.contract_hash}, but ${binding.hash} was ratified — the contract drifted after approval; re-open ARCH_REVIEW and re-ratify what changed`,
    );
  }
  return contract;
}
