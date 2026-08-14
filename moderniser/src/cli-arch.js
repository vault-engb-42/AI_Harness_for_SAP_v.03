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
import { persistenceFacts } from "./plan/persistence-facts.js";
import { factStream } from "./plan/arch-facts.js";
import { matchTargetShapes, loadPatternCorpus } from "./plan/patterns/match.js";
import { reasonArchitecture, validateSelection } from "./plan/arch-reason.js";
import { toLookup } from "./state/arch-verdict-cache.js";
import { buildArchContract, bindArchContract, isArchRatified, ARCH_GATED_DISPOSITIONS } from "./plan/arch-contract.js";
import { buildAppBlueprint } from "./plan/app-blueprint.js";
import { groupingDecision, archOptions } from "./plan/arch-row.js";
import { buildAdjacency } from "./plan/group-evidence.js";
import { checkBlueprint } from "./plan/blueprint-conformance.js";
import { standardTablesByObject, standardCapabilitiesByObject, fitToStandardAdvisory } from "./plan/fit-to-standard.js";
import { raiseArchReviews, raiseNoTargetShape } from "./plan/arch-gate.js";
import {
  loadRun, readEscalations, saveEscalations, saveState, log,
  readArchVerdictCache, saveArchContract, archContractRef, saveArchManifest,
} from "./cli-io.js";

const PROMPT_PATH = new URL("./plan/patterns/arch-reason-prompt.md", import.meta.url);
const CORPUS_PATH = new URL("./plan/patterns/target-patterns.json", import.meta.url);
// Domain separator between the two hashed inputs. NUL is the correct choice — it cannot occur in either
// UTF-8 input, so no (template, corpus) pair can collide by shifting the boundary between them — but it is
// CONSTRUCTED, never typed. A literal 0x00 byte in a source file makes grep report the file as binary,
// which has already cost time twice in this repo (cpg.js, and this line: the first version of it carried a
// raw NUL that silently made every hand-reconstruction of this hash disagree with the real one).
// Same idiom as `extract/bundle-diff.js`.
const SEP = String.fromCharCode(0);

export function cmdArch(io, pos, flags) {
  const [runId] = pos;
  const { plan, state } = loadRun(io, runId);
  const doc = readVerifiedDoc(pos[1] ?? flags.findings, state);
  const cons = consumptionFacts(doc);
  const pers = persistenceFacts(doc);
  const std = standardTablesByObject(doc);
  const caps = standardCapabilitiesByObject(doc); // the second fit-to-standard channel (RC-3)
  const corpus = loadPatternCorpus();
  const opts = { model_id: flags.model ?? null, prompt_hash: flags["prompt-hash"] ?? defaultPromptHash() };
  const cacheLookup = toLookup(readArchVerdictCache(io));

  const { resolved, pending, unplaceable } = reasonArchNodes(plan, cons, pers, corpus, cacheLookup, opts);
  const blueprint = assertBlueprintOk(runId, resolved, corpus); // F1: consistent BEFORE any freeze
  const groupCtx = { plan, adjacency: buildAdjacency(plan) };
  const { nextState, rows } = freezeContracts(io, runId, resolved, std, caps, corpus, state, blueprint, groupCtx);

  const archManifest = { run_id: runId, plan_hash: plan.plan_hash, rows, pending, unplaceable, shared: blueprint.shared };
  saveArchManifest(io, runId, archManifest);
  saveState(io, runId, nextState); // state BEFORE escalations: a crash residue leaves a bound-but-unraised node, healed on re-run
  // Raise ONLY for contracts that still need a human (G). A re-run preserves the ratification of an
  // unchanged contract, so re-raising would show the operator a gate for work they already approved — one
  // the driver correctly ignores, accumulating duplicate rows and eroding what an open ARCH_REVIEW means.
  // A CHANGED contract has had its ratification voided by `rebind`, so it reappears here, which is the
  // promise the lane makes: re-ratify exactly what changed.
  const unratified = { rows: rows.filter((r) => !isArchRatified(nextState, r.sig)) };
  const ts = new Date().toISOString();
  // …and one NO_TARGET_SHAPE per node no shape fits. Naming it in the manifest was never enough: the
  // documented remedy is `decide <esc_id> override:<disposition>`, so without a raised row the id that
  // remedy names does not exist and the node rests at await_human/arch_ratification with no gate to clear.
  saveEscalations(io, raiseNoTargetShape(raiseArchReviews(readEscalations(io), unratified, { ts }), unplaceable, { ts }));
  log(io, runId, "arch", { resolved: rows.length, pending: pending.length, unplaceable: unplaceable.length });
  return {
    run_id: runId,
    resolved: rows.length,
    pending: pending.length,
    rows: rows.map((r) => ({ sig: r.sig, target_shape: r.target_shape, contract_hash: r.arch_contract_hash })),
    // Objects no target shape fits. Neither resolved nor pending, so they must be named here or they leave
    // no trace at all — the silent disappearance this whole arc exists to stop.
    unplaceable,
  };
}

/**
 * Read the findings doc + verify it is the SAME source the run was planned on (augment-safe, reviewer F2).
 * @param {string} verb the calling verb, so a failure names the command the operator actually ran
 */
export function readVerifiedDoc(path, state, verb = "arch") {
  if (!path) throw new Error(`${verb}: a findings doc is required (positional <findings.json> or --findings)`);
  const doc = JSON.parse(readFileSync(path, "utf8"));
  // Identity must be POSITIVELY established, never merely "not mismatched" (M2): an absent hash normalises
  // to null on BOTH sides, and `null !== null` is false — so an unidentified doc would verify against a run
  // planned from any other unidentified doc. Require the hashes to be present, then require them to match.
  for (const field of ["source_hash", "config_hash"]) {
    const value = doc[field];
    if (typeof value !== "string" || value === "") {
      throw new Error(
        `${verb}: the findings doc carries no ${field} — re-run /abap-analyser; an unidentified doc cannot be verified against the planned run`,
      );
    }
    if (state[field] !== value) {
      throw new Error(
        `${verb}: findings doc ${field} ${value} does not match the planned run (${state[field] ?? "∅"}) — REPLAN; do not re-architect against drifted findings`,
      );
    }
  }
  return doc;
}

/** Reason a target_shape per re_architect/rebuild node; partition resolved (deterministic|cached) vs pending. */
function reasonArchNodes(plan, cons, pers, corpus, cacheLookup, opts) {
  const entries = [];
  const known = new Set(plan.nodes.map((n) => n.id));
  for (const node of plan.nodes) {
    if (!ARCH_GATED_DISPOSITIONS.has(node.disposition)) continue;
    const fact = factStream(node, cons, pers);
    const cands = matchTargetShapes(fact, corpus);
    let res = reasonArchitecture(node, fact, cands, cacheLookup, opts);
    // M3: re-validate a CACHED judge verdict against THIS run's candidates before trusting it. entry_hash
    // proves the cache file was not edited after it was written; it says nothing about whether the shape it
    // carries is one this node was ever offered. Fail-closed here keeps the judge-output boundary honest.
    if (res.status === "cached") {
      validateSelection(res.recommendation, cands);
      // V1: the same argument, applied to the OTHER half of a cached verdict. The cache is cross-run by
      // design and `factStream` is sig-free for P8, so two structurally identical objects in different
      // packages share a fact hash while their sigs are disjoint — which means a cached `shared` grouping
      // can name sigs that mean nothing here. Those foreign sigs reached checkBlueprint and threw the whole
      // verb BEFORE the manifest was written, leaving no pending request for `arch-verdict` to serve: an
      // unrecoverable run. An entry whose grouping does not fit this plan was frozen for a different one,
      // which is precisely a MISS — re-escalate to the judge by re-reasoning with an empty cache.
      if (!sharedFitsPlan(res.recommendation, known)) res = reasonArchitecture(node, fact, cands, {}, opts);
    }
    entries.push({ node, fact, cands, res });
  }

  // V1b: the plan-wide check above is only the CHEAP first filter. checkBlueprint grades `shared` against
  // the RESOLVED subset (blueprint-conformance.js builds objectSigs from the `assignments` this function's
  // caller derives from `resolved`), so a member that IS a plan node but is NOT resolved this run passed the
  // first filter and still threw the whole verb — the same unrecoverable state V1 set out to close, reached
  // by the ordinary incremental shape of one node judged while its siblings are still pending.
  // Converge on the predicate the tier actually applies: each pass demotes one cached entry, and a demoted
  // entry can never be `cached` again, so this terminates in at most one pass per arch-gated node.
  for (;;) {
    const resolvedSigs = new Set(entries.filter((e) => isResolved(e.res)).map((e) => e.node.id));
    const stale = entries.find((e) => e.res.status === "cached" && !sharedFitsPlan(e.res.recommendation, resolvedSigs));
    if (!stale) break;
    stale.res = reasonArchitecture(stale.node, stale.fact, stale.cands, {}, opts);
  }

  return {
    resolved: entries.filter((e) => isResolved(e.res)).map((e) => ({ node: e.node, recommendation: e.res.recommendation })),
    pending: entries.filter((e) => e.res.status === "await_arch").map((e) => e.res.request), // the P8 requests the fulfiller judges
    // Nodes no target shape fits. They are neither resolved nor pending, so without this they would vanish
    // from the manifest entirely — the same silent-disappearance this arc exists to stop. The human
    // re-dispositions them (`decide … override:<disposition>` → `replan`); they are not a judge question.
    unplaceable: entries.filter((e) => e.res.status === "no_shape").map((e) => ({ sig: e.node.id, reason: e.res.reason })),
  };
}

const isResolved = (res) => res.status === "deterministic" || res.status === "cached";

/** Every sig in a recommendation's cross-object grouping must be a node of THIS plan (V1). */
function sharedFitsPlan(recommendation, known) {
  for (const groups of Object.values(recommendation?.shared ?? {})) {
    for (const g of groups ?? []) {
      for (const m of g?.members ?? []) if (!known.has(m)) return false;
    }
  }
  return true;
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
function freezeContracts(io, runId, resolved, std, caps, corpus, state, blueprint, groupCtx) {
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
      // F-2: WHO selected this shape. `freezeJudgeSelection` stamps source:"judge" on every recorded
      // verdict, so `options[].rationale` says "judge" whether a judge reasoned about the node or a caller
      // recorded the only candidate the matcher left standing. The `--by` identity was already stored on
      // the cache entry and in the run log; it was simply absent from the manifest — the one artifact the
      // human reads at the ratification gate. Absent means `deterministic` (the matcher decided alone,
      // no verdict was ever recorded).
      judged_by: recommendation.judged_by ?? null,
      // WHY, beside WHO. `judged_by` alone asked the human to ratify by exception against a field that
      // names the decider and never the decision's reason — and the prompt has always required that reason.
      // `null` on a matcher-resolved row: no judge reasoned about it, so inventing a rationale would be a
      // fabricated confidence exactly like the ones this arc keeps finding.
      judged_rationale: recommendation.rationale ?? null,
      judged_confidence: recommendation.confidence ?? null,
      // The APP-LEVEL decisions, offered rather than assumed. "These objects become ONE Fiori app" is the
      // largest architectural call a run makes, and it used to reach the manifest unreviewed: checkBlueprint
      // proves the blueprint is internally CONSISTENT, never that a human agreed to it. The human ratified
      // each object's shape without being shown what it was grouped WITH. Now every membership rides the row
      // they are already ratifying, in the same recommended + alternatives + freeform shape the target-shape
      // decision uses, so each can be validated or overridden. Empty when the object joins nothing — a
      // headless BO shares nothing by definition, and manufacturing a question there would be noise.
      groupings: groupingDecision(node.id, blueprint, groupCtx),
      fit_to_standard: fitToStandardAdvisory(node, std, caps),
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

/** The committed judge prompt's content hash — the default prompt_hash when the skill does not pin one. */
export function defaultPromptHash() {
  // F-8.1 — the CORPUS is part of the prompt in every sense that matters. The verdict cache is keyed on
  // (fact_hash, model_id, prompt_hash), and the judge does not choose freely: it picks from the ranked
  // CANDIDATE LIST the patterns corpus produced for those facts. Hashing the template alone left the corpus
  // outside the key, so tightening a guard or adding a shape left every frozen verdict still addressable —
  // and served — carrying a candidate list that no longer exists. The human then ratifies alternatives the
  // corpus can no longer produce. Same facts + same model + same template but a different corpus is a
  // DIFFERENT question, and must miss.
  return createHash("sha256")
    .update(readFileSync(PROMPT_PATH, "utf8"))
    .update(SEP)
    .update(readFileSync(CORPUS_PATH, "utf8"))
    .digest("hex");
}
