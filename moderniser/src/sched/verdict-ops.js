/**
 * The node VERDICT operations (MODERNISER_DESIGN §3.2), split out of the scheduler loop so the
 * reducer file stays within the size limit. One cohesive concern — a node's verdict — across the
 * two lifecycle moves:
 *   - render*: the pure gate → verdict COMPOSITION (one coherent answer). The gate's SIGNED
 *     `atc_warn_delta` is what the verdict conjunct consumes, so gate and verdict can never
 *     disagree. Takes (planNode, checkpoint, evidence, baselines) — NO scheduler state.
 *   - record*: fold the rendered result into scheduler state AT the checkpoint (GATED live /
 *     PROVISIONAL_GATED offline). GREEN is EARNED, never asserted (GAN separation, §3.2).
 *
 * The record* verbs share the loop's fail-closed plan↔state `bind` guard (imported), so a state
 * from another plan can never record a verdict here either. One-way dependency (verdict-ops → loop:
 * the loop never calls these back), so no import cycle.
 */
import { bind } from "./loop.js";
import { VERDICT_WINDOW } from "../exception/oscillation.js";
import { ratchetGate, offlineRatchetGate } from "../state/ratchet.js";
import { nodeVerdict, offlineVerdict } from "../node/verdict.js";

/**
 * Record the rendered verdict for a node AT ITS CHECKPOINT (status must be GATED — a node
 * that has not reached the checkpoint has nothing to verdict, and baselines must never move
 * outside the lifecycle). `applyOutcome(GREEN)` refuses without a recorded GREEN verdict:
 * the reducer, not the orchestrating prose, decides GREEN (GAN separation, §3.2).
 */
export function recordVerdict(plan, state, sig, verdictResult) {
  bind(plan, state);
  if (state.status[sig] === undefined) throw new Error(`loop: unknown node ${sig}`);
  if (state.status[sig] !== "GATED") {
    throw new Error(`loop: verdict for ${sig} refused — the node is ${state.status[sig]}, not GATED`);
  }
  return {
    ...state,
    verdict_green: { ...state.verdict_green, [sig]: verdictResult.green === true },
    verdict_series: appendVerdict(state.verdict_series, sig, verdictResult.green === true),
    verdict_top_fail: topFail(state, sig, verdictResult),
  };
}

/**
 * The OFFLINE sibling of recordVerdict: record the offline verdict at PROVISIONAL_GATED (the
 * offline rest state — a node that has not reached the offline checkpoint has nothing to
 * verdict). Kept separate from recordVerdict's GATED-only guard so the live-GREEN record path is
 * untouched; offline NEVER GREENs (P6), so this records only a provisional-pass flag.
 */
export function recordProvisionalVerdict(plan, state, sig, verdictResult) {
  bind(plan, state);
  if (state.status[sig] === undefined) throw new Error(`loop: unknown node ${sig}`);
  if (state.status[sig] !== "PROVISIONAL_GATED") {
    throw new Error(`loop: provisional verdict for ${sig} refused — the node is ${state.status[sig]}, not PROVISIONAL_GATED`);
  }
  return {
    ...state,
    verdict_provisional: { ...state.verdict_provisional, [sig]: verdictResult.provisional === true },
    verdict_series: appendVerdict(state.verdict_series, sig, verdictResult.provisional === true),
    verdict_top_fail: topFail(state, sig, verdictResult),
  };
}

/**
 * Append one verdict token to the node's chronological series, capped at the detector window.
 *
 * BOUNDED on purpose: `isOscillating` reads only the last N, and an unbounded history would grow run state
 * without limit across a 100K-LOC corpus for evidence nothing consumes. Tokens rather than booleans so the
 * series reads plainly in a state file a human may have to open.
 */
function appendVerdict(series, sig, passed) {
  const prior = series?.[sig] ?? [];
  return { ...series, [sig]: [...prior, passed ? "pass" : "fail"].slice(-VERDICT_WINDOW) };
}

/**
 * The ROOT SIGNATURE of a failing verdict: the first reason, normalised to its rule id.
 *
 * Clustering is what keeps one generator weakness from becoming N escalations (§3.4 #3), and it groups on
 * this. `final-review-fix:<rule_id> (3 hits, first z.clas.abap:7)` must reduce to `<rule_id>` or two nodes
 * failing the SAME rule in different places would never cluster. A PASSING verdict leaves the prior
 * signature standing: it is the cause the node keeps returning to, and that is the thing worth grouping.
 */
function topFail(state, sig, result) {
  if (result?.provisional === true || result?.green === true) return state.verdict_top_fail ?? {};
  const first = (result?.reasons ?? [])[0];
  if (first === undefined) return state.verdict_top_fail ?? {};
  const id = String(first).replace(/^final-review-(?:fix|unanalysable):/, "").split(" (")[0];
  return { ...(state.verdict_top_fail ?? {}), [sig]: id };
}

/**
 * The ratchetGate → nodeVerdict composition (one coherent answer): the gate's SIGNED
 * `atc_warn_delta` is what the verdict conjunct consumes — never the absolute count.
 * @returns {{gate: object, verdict: object, green: boolean, reasons: string[]}}
 */
export function renderVerdict(planNode, checkpoint, evidence, baselines) {
  const gate = ratchetGate(planNode, evidence, baselines);
  const verdict = nodeVerdict(checkpoint, { atc_warn_delta: gate.atc_warn_delta });
  return {
    gate,
    verdict,
    green: gate.verdict === "PASS" && verdict.verdict === "GREEN",
    reasons: [...new Set([...gate.reasons, ...verdict.reasons])],
  };
}

/**
 * The OFFLINE composition (Phase 2, Option A): offlineRatchetGate → offlineVerdict with the SIGNED
 * `atc_warn_delta`, mirroring renderVerdict. Both partition out their DEV-only conjuncts (ratchet:
 * coverage/bite; verdict: activated/reconciled/unit), so a full pass rests in `provisional` — never
 * `green` (offline NEVER GREENs, P6). The warn/checkpoint evidence is fed by the gap-2b extractor.
 * @returns {{gate: object, verdict: object, provisional: boolean, reasons: string[]}}
 */
export function renderOfflineVerdict(planNode, checkpoint, evidence, baselines) {
  const gate = offlineRatchetGate(planNode, evidence, baselines);
  const verdict = offlineVerdict(checkpoint, { atc_warn_delta: gate.atc_warn_delta });
  return {
    gate,
    verdict,
    provisional: gate.verdict === "PASS" && verdict.verdict === "PROVISIONAL",
    reasons: [...new Set([...gate.reasons, ...verdict.reasons])],
  };
}
