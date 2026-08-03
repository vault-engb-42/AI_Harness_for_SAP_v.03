/**
 * The plan-time ARCHITECTURE verb for the /modernise CLI (BUILD_PLAN S12/S14, §4c). Runs after the
 * disposition gate, before the first `drive`. For each re_architect / rebuild node it reasons a target_shape
 * (deterministic top candidate | cached judge verdict | an `await_arch` request the SKILL fulfils by spawning
 * the judge), reasons the APP-LEVEL blueprint and proves it internally consistent BEFORE any freeze (S12
 * build order), freezes one COARSE Architecture Contract per RESOLVED node, binds it into run state, emits the
 * architecture-manifest (with a fit_to_standard advisory + a prompt-options set per row), and raises one
 * ARCH_REVIEW per RESOLVED node for human ratification.
 *
 * P8: the model input is only the sig-free `factStream` carried on each `await_arch` request; this verb never
 * feeds source/finding prose to a model — it does not call the model at all (the pure reasoner surfaces the
 * request; the fulfiller acts). Idempotent: a re-run rebuilds identical contracts (deterministic hash), the
 * bus dedupes an already-open ARCH_REVIEW, and a re-bind PRESERVES an existing ratification when the hash is
 * unchanged (a re-run never silently un-ratifies).
 *
 * Reviewer corrections wired here: F1 (the app-blueprint tier is mandatory), F2 (augment-safe
 * source_hash/config_hash doc check, not a plan_hash re-assemble), F4 (a fit_to_standard manifest slot),
 * F5 (grounded_apis provenance is the pattern, handled in arch-contract.js), LOW (raise ARCH_REVIEW for
 * RESOLVED nodes only). Single-candidate reality: the abap_fico headless nodes match exactly one shape, so
 * buildPromptOptions (which needs >= 1 alternative) is used only when a competing shape exists; otherwise the
 * honest 2-option set (the sole shape + the freeform refine escape) is surfaced.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { consumptionFacts } from "./plan/consumption-facts.js";
import { factStream, hashFactStream } from "./plan/arch-facts.js";
import { matchTargetShapes, loadPatternCorpus, PATTERN_IDS } from "./plan/patterns/match.js";
import { reasonArchitecture, validateSelection, freezeJudgeSelection } from "./plan/arch-reason.js";
import { toLookup, putEntry } from "./state/arch-verdict-cache.js";
import { buildArchContract, bindArchContract } from "./plan/arch-contract.js";
import { buildAppBlueprint } from "./plan/app-blueprint.js";
import { checkBlueprint } from "./plan/blueprint-conformance.js";
import { standardTablesByObject, fitToStandardAdvisory } from "./plan/fit-to-standard.js";
import { buildPromptOptions } from "./plan/prompt-options.js";
import { raiseArchReviews } from "./plan/arch-gate.js";
import {
  loadRun, readEscalations, saveEscalations, saveState, log,
  readArchVerdictCache, saveArchVerdictCache, saveArchContract, archContractRef, saveArchManifest, readArchManifest,
} from "./cli-io.js";

const REASONING_DISPOSITIONS = new Set(["re_architect", "rebuild"]);
const PROMPT_PATH = new URL("./plan/patterns/arch-reason-prompt.md", import.meta.url);

export function cmdArch(io, pos, flags) {
  const [runId] = pos;
  const { plan, state } = loadRun(io, runId);
  const doc = readVerifiedDoc(pos[1] ?? flags.findings, state);
  const cons = consumptionFacts(doc);
  const std = standardTablesByObject(doc);
  const corpus = loadPatternCorpus();
  const opts = { model_id: flags.model ?? null, prompt_hash: flags["prompt-hash"] ?? defaultPromptHash() };
  const cacheLookup = toLookup(readArchVerdictCache(io));

  const { resolved, pending } = reasonArchNodes(plan, cons, corpus, cacheLookup, opts);
  const blueprint = assertBlueprintOk(runId, resolved, corpus); // F1: consistent BEFORE any freeze
  const { nextState, rows } = freezeContracts(io, runId, resolved, std, corpus, state);

  const archManifest = { run_id: runId, plan_hash: plan.plan_hash, rows, pending, shared: blueprint.shared };
  saveArchManifest(io, runId, archManifest);
  saveState(io, runId, nextState); // state BEFORE escalations: a crash residue leaves a bound-but-unraised node, healed on re-run
  saveEscalations(io, raiseArchReviews(readEscalations(io), archManifest, { ts: new Date().toISOString() }));
  log(io, runId, "arch", { resolved: rows.length, pending: pending.length });
  return {
    run_id: runId,
    resolved: rows.length,
    pending: pending.length,
    rows: rows.map((r) => ({ sig: r.sig, target_shape: r.target_shape, contract_hash: r.arch_contract_hash })),
  };
}

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
  if (!REASONING_DISPOSITIONS.has(node.disposition)) {
    throw new Error(`arch-verdict: node ${sig} has disposition '${node.disposition}' — only re_architect/rebuild nodes are judged`);
  }
  const corpus = loadPatternCorpus();
  const fact = factStream(node, consumptionFacts(doc));
  // --shared-json carries the judge's APP-LEVEL grouping ({services|projections|fiori_apps}: [{id, members}])
  // — the cross-object half of the two-level judgment, which the blueprint conformance tier checks.
  const shared = flags["shared-json"] ? JSON.parse(readFileSync(flags["shared-json"], "utf8")) : undefined;
  const recommendation = freezeJudgeSelection(node, { target_shape: flags.shape, shared }, matchTargetShapes(fact, corpus));
  const model_id = flags.model ?? null;
  const prompt_hash = flags["prompt-hash"] ?? defaultPromptHash();
  const fact_hash = hashFactStream(fact);
  assertServesRequest(io, runId, sig, { fact_hash, model_id, prompt_hash });
  saveArchVerdictCache(io, putEntry(readArchVerdictCache(io), fact_hash, model_id, prompt_hash, { ...recommendation, judged_by: flags.by }));
  log(io, runId, "arch-verdict", { sig, target_shape: recommendation.target_shape, judged_by: flags.by });
  return { run_id: runId, sig, target_shape: recommendation.target_shape, fact_hash, model_id, prompt_hash };
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

/** Read the findings doc + verify it is the SAME source the run was planned on (augment-safe, reviewer F2). */
function readVerifiedDoc(path, state) {
  if (!path) throw new Error("arch: a findings doc is required (positional <findings.json> or --findings)");
  const doc = JSON.parse(readFileSync(path, "utf8"));
  // Identity must be POSITIVELY established, never merely "not mismatched" (M2): an absent hash normalises
  // to null on BOTH sides, and `null !== null` is false — so an unidentified doc would verify against a run
  // planned from any other unidentified doc. Require the hashes to be present, then require them to match.
  for (const field of ["source_hash", "config_hash"]) {
    const value = doc[field];
    if (typeof value !== "string" || value === "") {
      throw new Error(
        `arch: the findings doc carries no ${field} — re-run /abap-analyser; an unidentified doc cannot be verified against the planned run`,
      );
    }
    if (state[field] !== value) {
      throw new Error(
        `arch: findings doc ${field} ${value} does not match the planned run (${state[field] ?? "∅"}) — REPLAN; do not re-architect against drifted findings`,
      );
    }
  }
  return doc;
}

/** Reason a target_shape per re_architect/rebuild node; partition resolved (deterministic|cached) vs pending. */
function reasonArchNodes(plan, cons, corpus, cacheLookup, opts) {
  const resolved = [];
  const pending = [];
  for (const node of plan.nodes) {
    if (!REASONING_DISPOSITIONS.has(node.disposition)) continue;
    const fact = factStream(node, cons);
    const cands = matchTargetShapes(fact, corpus);
    const res = reasonArchitecture(node, fact, cands, cacheLookup, opts);
    // M3: re-validate a CACHED judge verdict against THIS run's candidates before trusting it. entry_hash
    // proves the cache file was not edited after it was written; it says nothing about whether the shape it
    // carries is one this node was ever offered. Fail-closed here keeps the judge-output boundary honest.
    if (res.status === "cached") validateSelection(res.recommendation, cands);
    if (res.status === "deterministic" || res.status === "cached") resolved.push({ node, recommendation: res.recommendation });
    else if (res.status === "await_arch") pending.push(res.request); // the P8 request the fulfiller judges
  }
  return { resolved, pending };
}

/**
 * F1: assemble the app-level verdict from the RESOLVED nodes and prove the blueprint consistent BEFORE any
 * contract freezes. M4: `shared` is the judge's real cross-object grouping merged across recommendations —
 * hardcoding `{}` here made checkBlueprint's cross-object checks (3+4) unreachable, so the "mandatory" tier
 * could never detect a violation. A group naming a member that is not in the app now blocks the freeze.
 * @returns {object} the checked blueprint (its `shared` is carried onto the manifest)
 */
function assertBlueprintOk(runId, resolved, corpus) {
  const verdict = {
    app_id: runId,
    assignments: resolved.map((r) => ({ sig: r.node.id, target_shape: r.recommendation.target_shape })),
    shared: mergeShared(resolved),
  };
  const blueprint = buildAppBlueprint(verdict, corpus);
  const { ok, violations } = checkBlueprint(blueprint, corpus);
  if (!ok) throw new Error(`arch: the app blueprint is not internally consistent — ${violations.join("; ")}`);
  return blueprint;
}

/** Union the per-recommendation cross-object groups by id (members deduped, order canonical). */
function mergeShared(resolved) {
  const out = { services: [], projections: [], fiori_apps: [] };
  for (const { recommendation } of resolved) {
    for (const kind of Object.keys(out)) {
      for (const g of recommendation.shared?.[kind] ?? []) {
        const existing = out[kind].find((x) => x.id === g.id);
        if (existing) existing.members = [...new Set([...existing.members, ...(g.members ?? [])])];
        else out[kind].push({ id: g.id, members: [...new Set(g.members ?? [])] });
      }
    }
  }
  return out;
}

/** Freeze one coarse contract per resolved node, bind it (preserving an unchanged ratification), build rows. */
function freezeContracts(io, runId, resolved, std, corpus, state) {
  let nextState = state;
  const rows = [];
  for (const { node, recommendation } of resolved) {
    const contract = buildArchContract(node, recommendation, corpus);
    saveArchContract(io, runId, node.id, contract);
    nextState = rebind(nextState, node.id, archContractRef(runId, node.id), contract.contract_hash);
    rows.push({
      sig: node.id,
      target_shape: recommendation.target_shape,
      arch_contract_ref: archContractRef(runId, node.id),
      arch_contract_hash: contract.contract_hash,
      reviewer_verdict: null, // the abap-arch-reviewer verdict is attached by the skill fulfiller (offline: null)
      fit_to_standard: fitToStandardAdvisory(node, std),
      options: archOptions(recommendation),
    });
  }
  return { nextState, rows };
}

/** Bind the contract, PRESERVING an existing ratification iff the hash is unchanged (idempotent re-run safety). */
function rebind(state, sig, ref, hash) {
  const prior = state.arch_contracts?.[sig];
  // Hash-guarded: an UNCHANGED contract keeps its human ratification (a re-run must never silently
  // un-ratify — that would re-block the driver on work the human already approved); a CHANGED contract
  // voids it, so the human re-ratifies exactly what changed.
  const keep = prior && prior.hash === hash
    ? { ratified_by: prior.ratified_by ?? null, reviewer_verdict: prior.reviewer_verdict ?? null }
    : { ratified_by: null, reviewer_verdict: null };
  return bindArchContract(state, sig, { ref, hash, ...keep });
}

/** The prompt-options for a row: buildPromptOptions when a competing shape exists, else an honest 2-option set. */
function archOptions(recommendation) {
  const alts = (recommendation.candidates ?? [])
    .filter((c) => c.id !== recommendation.target_shape)
    .map((c) => ({ target_shape: c.id, rationale: `alternative shape (match score ${c.score})` }));
  if (alts.length === 0) {
    // A single-candidate node has no competing shape — the operator's choice is approve | refine | reject,
    // so surface the sole shape + the freeform 'other' (refine) escape without the >= 3 buildPromptOptions rule.
    return [
      { target_shape: recommendation.target_shape, recommended: true, rationale: recommendation.source ?? "sole grounded shape" },
      { target_shape: "other", recommended: false, rationale: "operator-specified — refine or reject", freeform: true },
    ];
  }
  return buildPromptOptions(
    { target_shape: recommendation.target_shape, rationale: recommendation.source ?? "recommended shape" },
    alts,
    { labelField: "target_shape", isValid: (s) => PATTERN_IDS.includes(s) },
  );
}

/** The committed judge prompt's content hash — the default prompt_hash when the skill does not pin one. */
function defaultPromptHash() {
  return createHash("sha256").update(readFileSync(PROMPT_PATH, "utf8")).digest("hex");
}
