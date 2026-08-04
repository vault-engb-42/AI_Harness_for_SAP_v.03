/**
 * The JUDGE WRITE SEAM for the architecture gate — `arch-verdict` (H3), plus the two guards that keep it
 * honest: the outstanding-request key check (B) and the boundary validation of the judge's app-level
 * grouping (F). Split out of cli-arch.js, which owns the gate itself (`arch`), so both stay within the
 * file-size limit and the two responsibilities read separately: cli-arch.js ISSUES requests and freezes
 * contracts; this module RECORDS what the judge decided.
 */
import { readFileSync } from "node:fs";
import { factStream, hashFactStream } from "./plan/arch-facts.js";
import { matchTargetShapes, loadPatternCorpus } from "./plan/patterns/match.js";
import { freezeJudgeSelection } from "./plan/arch-reason.js";
import { putEntry } from "./state/arch-verdict-cache.js";
import { ARCH_GATED_DISPOSITIONS } from "./plan/arch-contract.js";
import { consumptionFacts } from "./plan/consumption-facts.js";
import { loadRun, log, readArchVerdictCache, saveArchVerdictCache, readArchManifest } from "./cli-io.js";
import { readVerifiedDoc, defaultPromptHash } from "./cli-arch.js";

/**
 * `arch-verdict <run_id> <findings.json> <sig> --shape <target_shape> --by <judge> [--model m] [--prompt-hash h]`
 *
 * The judge's WRITE seam (H3) — the counterpart to the `await_arch` requests `arch` emits. The fulfiller
 * spawns the judge on `manifest.pending[].fact` (the sig-free P8 fact stream, the ONLY prompt input) and
 * records the returned selection here; the next `arch` run then resolves that node from the cache. Without
 * this verb nothing could ever write the verdict cache, so every escalated node stayed `await_arch` forever
 * and the driver's arch precondition deadlocked the run on real findings.
 *
 * Fail-closed: the selection is validated against the candidates THIS run's facts produce (a shape outside
 * them — hallucinated, injected, or stale — is refused), the doc identity is re-verified exactly as `arch`
 * does, and a named judge is required for the audit trail.
 */
export function cmdArchVerdict(io, pos, flags) {
  const [runId, docPath, sig] = pos;
  const { plan, state } = loadRun(io, runId);
  const doc = readVerifiedDoc(docPath ?? flags.findings, state);
  if (typeof flags.by !== "string" || !flags.by) throw new Error("arch-verdict: --by <judge> is required (the named judge whose selection this is)");
  if (typeof flags.shape !== "string" || !flags.shape) throw new Error("arch-verdict: --shape <target_shape> is required");
  const node = plan.nodes.find((n) => n.id === sig);
  if (!node) throw new Error(`arch-verdict: unknown node ${sig}`);
  if (!ARCH_GATED_DISPOSITIONS.has(node.disposition)) {
    throw new Error(`arch-verdict: node ${sig} has disposition '${node.disposition}' — only re_architect/rebuild nodes are judged`);
  }
  const corpus = loadPatternCorpus();
  const fact = factStream(node, consumptionFacts(doc));
  // --shared-json carries the judge's APP-LEVEL grouping ({services|projections|fiori_apps}: [{id, members}])
  // — the cross-object half of the two-level judgment, which the blueprint conformance tier checks. It is
  // UNTRUSTED fulfiller input that gets frozen into the cross-run cache, so it is validated here (F).
  const shared = flags["shared-json"] ? validateShared(JSON.parse(readFileSync(flags["shared-json"], "utf8")), plan) : undefined;
  const recommendation = freezeJudgeSelection(node, { target_shape: flags.shape, shared }, matchTargetShapes(fact, corpus));
  const model_id = flags.model ?? null;
  const prompt_hash = flags["prompt-hash"] ?? defaultPromptHash();
  const fact_hash = hashFactStream(fact);
  assertServesRequest(io, runId, sig, { fact_hash, model_id, prompt_hash });
  saveArchVerdictCache(io, putEntry(readArchVerdictCache(io), fact_hash, model_id, prompt_hash, { ...recommendation, judged_by: flags.by }));
  log(io, runId, "arch-verdict", { sig, target_shape: recommendation.target_shape, judged_by: flags.by });
  return { run_id: runId, sig, target_shape: recommendation.target_shape, fact_hash, model_id, prompt_hash };
}

const SHARED_KINDS = ["services", "projections", "fiori_apps"];

/**
 * Validate the judge's cross-object grouping AT THE BOUNDARY, before anything is frozen (F).
 *
 * `--shared-json` is untrusted fulfiller output that `putEntry` freezes into the CROSS-RUN verdict cache.
 * Unvalidated, a malformed grouping is not a local error: it throws a raw TypeError out of `mergeShared` on
 * every subsequent `arch`, permanently, for every run sharing that cache — a wedge no operator could
 * diagnose from the message. Members are checked against the PLAN (not the resolved subset) so a dangling
 * sig is refused by the writer that produced it, rather than blocking the whole verb for everyone later.
 */
function validateShared(shared, plan) {
  const bad = (m) => { throw new Error(`arch-verdict: --shared-json ${m}`); };
  if (shared === null || typeof shared !== "object" || Array.isArray(shared)) {
    bad(`must be an object of {${SHARED_KINDS.join(" | ")}: [{id, members}]}`);
  }
  const known = new Set(plan.nodes.map((n) => n.id));
  for (const [kind, groups] of Object.entries(shared)) {
    if (!SHARED_KINDS.includes(kind)) bad(`has unknown group kind '${kind}' (expected ${SHARED_KINDS.join(" | ")})`);
    if (!Array.isArray(groups)) bad(`'${kind}' must be an array of {id, members}`);
    for (const g of groups) {
      if (!g || typeof g !== "object" || typeof g.id !== "string" || g.id === "") bad(`'${kind}' has a group with no non-empty string id`);
      if (!Array.isArray(g.members)) bad(`group '${g.id}' members must be an array of plan node sigs`);
      for (const m of g.members) {
        if (typeof m !== "string" || !known.has(m)) bad(`group '${g.id}' names member '${m}' which is not a plan node of this run`);
      }
    }
  }
  return shared;
}

/**
 * The write seam must SERVE AN OUTSTANDING REQUEST and prove its key matches it (B).
 *
 * The verdict cache is keyed on (fact_hash, model_id, prompt_hash). A verdict judged under a different model
 * or prompt than the request was ISSUED under lands on a key `arch` will never read: every step returns a
 * success JSON, no error surfaces anywhere, and the run silently deadlocks at await_human forever — which is
 * precisely the failure the judge write seam was built to close. Refusing here makes the seam self-proving:
 * a recorded verdict is, by construction, one the next `arch` will consume.
 */
function assertServesRequest(io, runId, sig, key) {
  const request = (readArchManifest(io, runId)?.pending ?? []).find((p) => p.sig === sig);
  if (!request) {
    throw new Error(
      `arch-verdict: no outstanding await_arch request for ${sig} — run \`arch\` first; a verdict nothing asked for would be frozen under a key no run reads`,
    );
  }
  for (const field of ["fact_hash", "model_id", "prompt_hash"]) {
    if ((request[field] ?? null) !== (key[field] ?? null)) {
      throw new Error(
        `arch-verdict: ${field} '${key[field] ?? "∅"}' does not match the outstanding request ('${request[field] ?? "∅"}') — ` +
        `the verdict would be frozen under a key \`arch\` never reads (a silent deadlock); judge under the request's model + prompt`,
      );
    }
  }
}
