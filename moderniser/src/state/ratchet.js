/**
 * Deterministic ratchet gate (MODERNISER_DESIGN §3.3 #4, §6.4 — L6, L10). Quality only
 * tightens FROM AN ESTABLISHED BASELINE:
 *
 *   - `atc_p1 == 0` — the hard, non-overridable clean-core conjunct (separate from and
 *     orthogonal to the WARN-delta ratchet).
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
 * @param {Array<{file: string, line: number}>} atcWarns priority-2/3 findings
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
 * @param {{canonical_sig: string, parity_required?: boolean, diff_changed_lines?: Array<{file: string, lines: number[]}>}} node internal typed record (scope.js emits boolean parity_required)
 * @param {{atc_p1?: number, atc_warns?: Array<{file: string, line: number}>, coverage?: {pct?: number, bite_proven?: boolean}}} evidence
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

  if (node.parity_required === true && evidence.coverage?.bite_proven !== true) reasons.push("bite-not-proven");

  let delta = 0;
  let atc_warn_delta = 1; // fail-closed default: a downstream verdict must also block
  if (!Array.isArray(evidence.atc_warns)) {
    reasons.push("atc-warns-missing"); // tool returned nothing → fail-closed
  } else if (!evidence.atc_warns.every((w) => typeof w.file === "string" && Number.isInteger(w.line))) {
    reasons.push("atc-warns-malformed"); // unmatchable entries would silently join to delta 0 → fail-closed
  } else {
    delta = warnOnChangedLines(node.diff_changed_lines, evidence.atc_warns);
    const ceiling = baselines.atcBaseline.per_object?.[key] ?? Infinity; // L10 seed ∞
    atc_warn_delta = Number.isFinite(ceiling) ? delta - ceiling : 0; // establish-pass → 0
    if (delta > ceiling) reasons.push(`warn-delta-regressed:${delta}>${ceiling}`);
  }

  const pct = evidence.coverage?.pct;
  const covEntry = baselines.covBaseline.per_object?.[key];
  if (!Number.isFinite(pct)) {
    reasons.push("coverage-missing"); // fail-closed
  } else if (covEntry !== undefined && !Number.isFinite(covEntry.pct)) {
    reasons.push("baseline-corrupt"); // an entry with no finite pct must not fall back to the floor
  } else {
    const floor = covEntry?.pct ?? baselines.covBaseline.coverage_floor_pct ?? 0;
    if (pct < floor) reasons.push(`coverage-regressed:${pct}<${floor}`);
  }

  return { verdict: reasons.length === 0 ? "PASS" : "BLOCK", reasons, delta, atc_warn_delta };
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
