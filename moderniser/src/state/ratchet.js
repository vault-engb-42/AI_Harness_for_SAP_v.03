/**
 * Deterministic ratchet gate (MODERNISER_DESIGN §3.3 #4, §6.4 — L6, L10). Quality only
 * tightens FROM AN ESTABLISHED BASELINE:
 *
 *   - `atc_p1 == 0` AND `atc_p2 == 0` — the hard, non-overridable clean-core conjuncts (C3/P6:
 *     SAP blocks transport on ATC priority-1 AND priority-2; both separate from and orthogonal
 *     to the WARN-delta ratchet, which is now the priority-3 notify tier).
 *   - WARN delta = warns on THIS node's changed lines only (L6(2) — pre-existing package
 *     debt is carried, not counted). Compared to `atcBaseline.per_object[sig] ?? ∞`: a node
 *     with no prior baseline has no ceiling to violate (seed ∞ — L10, establish-then-tighten,
 *     NOT a retry count); every later pass must be ≤ the recorded value (only-down).
 *   - Coverage only-up vs `covBaseline.per_object[sig].pct`, falling back to the shipped
 *     harness-wide `coverage_floor_pct` (else 0). A parity-required node's coverage counts
 *     only after a PROVEN bite (L6(1): the characterization test must have FAILED against
 *     the pre-modernisation mutant).
 *
 * Missing evidence fails CLOSED (a tool that errors or returns nothing is a FAIL, §3.2 5.3).
 * Tolerates the shipped baseline file shapes (`atc-baseline.json` has no `per_object` map
 * yet → treated as empty → seed ∞ everywhere). No decay/embedding/LLM signal reaches this
 * gate — deterministic inputs only (L6).
 *
 * Pure: baselines in → verdict (+ NEW baselines from `onPass`) out. Never mutates inputs;
 * fsync → atomic-rename → git-add persistence is the scheduler loop's job. Baselines are
 * never touched on BLOCK — `onPass` re-runs the gate and throws if it would not pass.
 */

/**
 * Count WARNs landing on this node's changed lines (L6(2)).
 * @param {Array<{file: string, lines: number[]}>} diffChangedLines
 * @param {Array<{file: string, line: number}>} atcWarns priority-3 (WARN/notify-tier) findings — priority-2 hard-gates via atc_p2 (C3)
 * @returns {number}
 */
export function warnOnChangedLines(diffChangedLines, atcWarns) {
  const changed = new Set();
  for (const d of diffChangedLines ?? []) {
    for (const line of d.lines ?? []) changed.add(`${d.file}:${line}`);
  }
  let count = 0;
  for (const w of atcWarns ?? []) if (changed.has(`${w.file}:${w.line}`)) count += 1;
  return count;
}

/**
 * Both sides of the warn/diff join MUST share one canonical file-key space — the evidence
 * assembler normalises paths before calling; a mismatched convention here would silently
 * fail-open, which is why warn elements are shape-VALIDATED (fail-closed) below.
 *
 * @param {{canonical_sig: string, parity_required?: boolean, diff_changed_lines: Array<{file: string, lines: number[]}>}} node internal typed record (scope.js emits boolean parity_required); the diff is REQUIRED — absence fails closed (F1)
 * @param {{atc_p1?: number, atc_p2?: number, atc_warns?: Array<{file: string, line: number}>, coverage?: {pct?: number, bite_proven?: boolean}}} evidence
 * @param {{atcBaseline: {per_object?: Record<string, number>}, covBaseline: {per_object?: Record<string, {pct: number, bite_proven: boolean}>, coverage_floor_pct?: number}}} baselines
 * @returns {{verdict: "PASS"|"BLOCK", reasons: string[], delta: number, atc_warn_delta: number}}
 *   `delta` = absolute changed-line warn count; `atc_warn_delta` = the SIGNED delta-vs-own-
 *   baseline (§6.4: seed ∞ → 0 on an establish-pass) — THE value `nodeVerdict`'s
 *   `ratchet.atc_warn_delta ≤ 0` conjunct consumes, so gate and verdict can never disagree.
 */
export function ratchetGate(node, evidence = {}, baselines) {
  const key = node.canonical_sig;
  const reasons = [];

  if (evidence.atc_p1 !== 0) reasons.push("atc-p1-nonzero"); // hard invariant; missing → fail-closed
  if (evidence.atc_p2 !== 0) reasons.push("atc-p2-nonzero"); // C3 (P6): SAP blocks transport on P1 AND P2; missing → fail-closed

  if (node.parity_required === true && evidence.coverage?.bite_proven !== true) reasons.push("bite-not-proven");

  // The diff-validity + WARNs-on-changed-lines ratchet — shared with the offline gate.
  const wd = warnDelta(node, evidence, baselines);
  reasons.push(...wd.reasons);

  const pct = evidence.coverage?.pct;
  const covEntry = baselines.covBaseline.per_object?.[key];
  const rawFloor = baselines.covBaseline.coverage_floor_pct;
  if (!Number.isFinite(pct)) {
    reasons.push("coverage-missing"); // fail-closed
  } else if (covEntry !== undefined && !Number.isFinite(covEntry.pct)) {
    reasons.push("baseline-corrupt"); // an entry with no finite pct must not fall back to the floor
  } else if (rawFloor !== undefined && !Number.isFinite(rawFloor)) {
    reasons.push("baseline-corrupt"); // a corrupt shipped floor must not silently read as floor-0
  } else {
    const floor = covEntry?.pct ?? rawFloor ?? 0;
    if (pct < floor) reasons.push(`coverage-regressed:${pct}<${floor}`);
  }

  return { verdict: reasons.length === 0 ? "PASS" : "BLOCK", reasons, delta: wd.delta, atc_warn_delta: wd.atc_warn_delta };
}

/**
 * The warn-delta ratchet core (L6(2)), shared by the live `ratchetGate` and the offline
 * `offlineRatchetGate`: diff-validity + WARNs-on-changed-lines vs the per-object ceiling (seed ∞
 * → establish-pass 0). Both sides of the warn/diff join are shape-validated fail-closed (review
 * F1: the warn side alone left a missing/malformed diff silently joining to delta 0 — a gated
 * node has by definition been regenerated, so an absent diff means the diff tool errored).
 * Returns its own reasons so both callers collect them in the same position; atc_p1 and the
 * DEV-only coverage/bite conjuncts stay in the callers.
 * @returns {{reasons: string[], delta: number, atc_warn_delta: number}}
 */
function warnDelta(node, evidence, baselines) {
  const key = node.canonical_sig;
  const reasons = [];
  const diff = node.diff_changed_lines;
  const diffValid =
    Array.isArray(diff) && diff.every((d) => typeof d.file === "string" && Array.isArray(d.lines) && d.lines.every(Number.isInteger));
  if (!Array.isArray(diff)) reasons.push("diff-changed-lines-missing");
  else if (!diffValid) reasons.push("diff-changed-lines-malformed");

  let delta = 0;
  let atc_warn_delta = 1; // fail-closed default: a downstream verdict must also block
  if (!Array.isArray(evidence.atc_warns)) {
    reasons.push("atc-warns-missing"); // tool returned nothing → fail-closed
  } else if (!evidence.atc_warns.every((w) => typeof w.file === "string" && Number.isInteger(w.line))) {
    reasons.push("atc-warns-malformed"); // unmatchable entries would silently join to delta 0 → fail-closed
  } else if (diffValid) {
    delta = warnOnChangedLines(diff, evidence.atc_warns);
    const ceiling = baselines.atcBaseline.per_object?.[key];
    if (ceiling !== undefined && !Number.isFinite(ceiling)) {
      reasons.push("baseline-corrupt"); // a present-but-corrupt ceiling must not read as seed-∞ bootstrap
    } else {
      atc_warn_delta = ceiling === undefined ? 0 : delta - ceiling; // L10 seed ∞ → establish-pass 0
      if (ceiling !== undefined && delta > ceiling) reasons.push(`warn-delta-regressed:${delta}>${ceiling}`);
    }
  }
  return { reasons, delta, atc_warn_delta };
}

/**
 * The OFFLINE ratchet (MODERNISER_DRIVER_AND_GAP2_DESIGN Phase 2, Option A): `ratchetGate`
 * PARTITIONED to the offline-computable conjuncts — atc_p1 + the shared warn-delta core. The
 * DEV-only coverage % and parity-bite conjuncts are EXCLUDED (offline can't run ABAP Unit),
 * exactly as `offlineVerdict` excludes activated/reconciled/unit. The warn EVIDENCE (atc_warns on
 * changed lines) is fed by the gap-2b offline extractor. Pure.
 * @returns {{verdict: "PASS"|"BLOCK", reasons: string[], delta: number, atc_warn_delta: number}}
 */
export function offlineRatchetGate(node, evidence = {}, baselines) {
  const reasons = [];
  if (evidence.atc_p1 !== 0) reasons.push("atc-p1-nonzero"); // hard invariant; missing → fail-closed
  if (evidence.atc_p2 !== 0) reasons.push("atc-p2-nonzero"); // C3 (P6): P1 AND P2 both hard-block; missing → fail-closed
  const wd = warnDelta(node, evidence, baselines);
  reasons.push(...wd.reasons);
  return { verdict: reasons.length === 0 ? "PASS" : "BLOCK", reasons, delta: wd.delta, atc_warn_delta: wd.atc_warn_delta };
}

/**
 * Record a PASSING node's new baselines (only ever called after a PASS — enforced here, so
 * a caller bug can never move a baseline on BLOCK). Returns NEW baselines with carried-over
 * per_object entries DEEP-copied (no aliasing back to the input); the recorded bite state is
 * the ACTUAL evidence, never assumed. Non-per_object fields (evaluator-owned, e.g.
 * `accepted_priority_2_3`, `coverage_floor_pct`) are carried through untouched.
 * @returns {{atcBaseline: object, covBaseline: object}}
 */
export function onPass(node, evidence, baselines) {
  const gate = ratchetGate(node, evidence, baselines);
  if (gate.verdict !== "PASS") {
    throw new Error(`ratchet onPass called on a BLOCK (${gate.reasons.join(", ")}) — baselines are never touched on BLOCK`);
  }
  const key = node.canonical_sig;
  const covEntries = Object.fromEntries(
    Object.entries(baselines.covBaseline.per_object ?? {}).map(([k, v]) => [k, { ...v }]), // per-entry copy
  );
  return {
    atcBaseline: {
      ...baselines.atcBaseline,
      per_object: { ...(baselines.atcBaseline.per_object ?? {}), [key]: gate.delta },
    },
    covBaseline: {
      ...baselines.covBaseline,
      per_object: {
        ...covEntries,
        [key]: { pct: evidence.coverage.pct, bite_proven: evidence.coverage.bite_proven === true },
      },
    },
  };
}
