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
import { factStream } from "./plan/arch-facts.js";
import { matchTargetShapes, loadPatternCorpus, PATTERN_IDS } from "./plan/patterns/match.js";
import { reasonArchitecture } from "./plan/arch-reason.js";
import { toLookup } from "./state/arch-verdict-cache.js";
import { buildArchContract, bindArchContract } from "./plan/arch-contract.js";
import { buildAppBlueprint } from "./plan/app-blueprint.js";
import { checkBlueprint } from "./plan/blueprint-conformance.js";
import { standardTablesByObject, fitToStandardAdvisory } from "./plan/fit-to-standard.js";
import { buildPromptOptions } from "./plan/prompt-options.js";
import { raiseArchReviews } from "./plan/arch-gate.js";
import {
  loadRun, readEscalations, saveEscalations, saveState, log,
  readArchVerdictCache, saveArchContract, archContractPath, saveArchManifest,
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
  assertBlueprintOk(runId, resolved, corpus); // F1: prove the app blueprint consistent BEFORE any freeze
  const { nextState, rows } = freezeContracts(io, runId, resolved, std, corpus, state);

  const archManifest = { run_id: runId, plan_hash: plan.plan_hash, rows, pending };
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

/** Read the findings doc + verify it is the SAME source the run was planned on (augment-safe, reviewer F2). */
function readVerifiedDoc(path, state) {
  if (!path) throw new Error("arch: a findings doc is required (positional <findings.json> or --findings)");
  const doc = JSON.parse(readFileSync(path, "utf8"));
  const s = (v) => v ?? "∅";
  if ((doc.source_hash ?? null) !== (state.source_hash ?? null) || (doc.config_hash ?? null) !== (state.config_hash ?? null)) {
    throw new Error(
      `arch: findings doc (source_hash ${s(doc.source_hash)}, config_hash ${s(doc.config_hash)}) does not match ` +
      `the planned run (${s(state.source_hash)} / ${s(state.config_hash)}) — REPLAN; do not re-architect against drifted findings`,
    );
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
    if (res.status === "deterministic" || res.status === "cached") resolved.push({ node, recommendation: res.recommendation });
    else if (res.status === "await_arch") pending.push(res.request); // the P8 request the fulfiller judges
  }
  return { resolved, pending };
}

/** F1: assemble the app-level verdict from the RESOLVED nodes and prove the blueprint consistent pre-freeze. */
function assertBlueprintOk(runId, resolved, corpus) {
  const verdict = {
    app_id: runId,
    assignments: resolved.map((r) => ({ sig: r.node.id, target_shape: r.recommendation.target_shape })),
    shared: {},
  };
  const { ok, violations } = checkBlueprint(buildAppBlueprint(verdict, corpus), corpus);
  if (!ok) throw new Error(`arch: the app blueprint is not internally consistent — ${violations.join("; ")}`);
}

/** Freeze one coarse contract per resolved node, bind it (preserving an unchanged ratification), build rows. */
function freezeContracts(io, runId, resolved, std, corpus, state) {
  let nextState = state;
  const rows = [];
  for (const { node, recommendation } of resolved) {
    const contract = buildArchContract(node, recommendation, corpus);
    saveArchContract(io, runId, node.id, contract);
    nextState = rebind(nextState, node.id, archContractPath(io, runId, node.id), contract.contract_hash);
    rows.push({
      sig: node.id,
      target_shape: recommendation.target_shape,
      arch_contract_ref: archContractPath(io, runId, node.id),
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
