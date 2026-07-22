import { invariantDiff } from "./invariants.js";
import { parity } from "./parity.js";
import { invariantInput } from "../extract/bundle.js";
import { diffBundles } from "../extract/bundle-diff.js";
import { renderOfflineVerdict } from "../sched/verdict-ops.js";

/**
 * gap-2b B5 — the offline verdict seam's PRODUCER. Everything downstream of this file already
 * exists (Phase 2): the `PROVISIONAL_GATED` FSM status, the `offlineVerdict` reducer, the
 * `offlineRatchetGate`, `renderOfflineVerdict` and `recordProvisionalVerdict`. What was missing was
 * an offline producer — nothing built the checkpoint, so the seam had no input but synthetic
 * fixtures. This closes it: B4's before/after bundles → `invariantDiff` + `parity` → the checkpoint
 * and the ratchet evidence → `renderOfflineVerdict`.
 *
 * THE §4.4 SPLIT IS LOAD-BEARING. `invariantDiff` returns `{intact, violations, auth_coverage,
 * auth_delta}`, but the verdict reads `cp.invariants.auth_delta` AND `cp.auth_coverage` as a
 * TOP-LEVEL SIBLING (verdict.js:73). Assigning the whole return to `cp.invariants` type-checks,
 * reads naturally, and SILENTLY DISABLES the auth-coverage conjunct — a node that lost authorization
 * coverage would rest provisional. The split below is deliberate, and a test proves the conjunct
 * still bites rather than merely asserting the shape.
 *
 * ATC counts are ASSERTED, never recomputed. By the time a node reaches the offline checkpoint the
 * gap-2a rule gate has already run `analyzePackage` and established its findings; this reads that
 * document. Wiring a second `analyzePackage` call here would be the devepos O(N²) anti-pattern the
 * build contract forbids. The caller passes the AFTER-side findings — the generated artifact is
 * what is being judged.
 *
 * Pure. No I/O.
 */

const asArray = (x) => (Array.isArray(x) ? x : []);
const findingsOf = (doc) => asArray(doc?.findings);

/**
 * Steps 1–2: the two bundles → the checkpoint `offlineVerdict` consumes.
 * @param {object} before an `assembleBundle` bundle
 * @param {object} after an `assembleBundle` bundle
 * @param {{findings?: object, attestations?: object, block_reason?: string, touched_files?: string[]}} opts
 * @returns {object} the checkpoint, split per §4.4
 */
export function offlineCheckpoint(before, after, opts = {}) {
  const inv = invariantDiff(invariantInput(before ?? {}), invariantInput(after ?? {}));
  const counts = atcCounts(opts.findings);
  const checkpoint = {
    atc_p1: counts.atc_p1,
    atc_p2: counts.atc_p2,
    // §4.4: exactly these three — NOT the whole invariantDiff return.
    invariants: { intact: inv.intact, violations: inv.violations, auth_delta: inv.auth_delta },
    // …because THIS is where the verdict looks for coverage (verdict.js:73).
    auth_coverage: inv.auth_coverage,
    parity: parity(diffBundles(before, after, { touched_files: opts.touched_files })),
  };
  if (opts.attestations !== undefined) checkpoint.attestations = opts.attestations;
  if (opts.block_reason !== undefined) checkpoint.block_reason = opts.block_reason;
  return checkpoint;
}

/**
 * The offline ratchet's evidence. `atc_warns` is the priority-3 NOTIFY tier only: priority-1 and
 * priority-2 hard-block through `atc_p1`/`atc_p2` (C3), and `info` sits below the ratchet entirely.
 * Warns whose file/line cannot join to a changed line are DROPPED rather than passed through — the
 * gate shape-validates and fails closed on a malformed entry, so emitting one would block the node
 * on the analyser's own metadata gap rather than on its code.
 * @param {{findings?: object, beforeFiles?: Array<{filename: string, source: string}>, afterFiles?: Array<{filename: string, source: string}>}} opts
 * @returns {{atc_p1: number, atc_p2: number, atc_warns: Array<{file: string, line: number}>, diff_changed_lines: Array<{file: string, lines: number[]}>}}
 */
export function offlineEvidence(opts = {}) {
  return {
    ...atcCounts(opts.findings),
    atc_warns: findingsOf(opts.findings)
      .filter((f) => f.severity === "priority-3" && typeof f.file === "string" && Number.isInteger(f.line))
      .map((f) => ({ file: f.file, line: f.line })),
    diff_changed_lines: changedLines(opts.beforeFiles, opts.afterFiles),
  };
}

/**
 * The warn/diff join key: which AFTER lines are new, so the ratchet counts only THIS node's debt
 * and never the package's carried debt (L6(2)).
 *
 * A MULTISET difference, not an LCS diff. Per file, each after-line is "changed" unless the before
 * file still has an unconsumed identical line. That is O(n+m) rather than O(n·m) — the 100K+ LOC
 * NFR makes a quadratic per-file diff untenable — and it encodes the right semantics: a line that
 * merely MOVED is not a change, so its pre-existing warn stays carried debt. Duplicates are handled
 * by consuming counts, so adding a second copy of an existing line does register.
 * @returns {Array<{file: string, lines: number[]}>} sorted by file; only files with changed lines
 */
export function changedLines(beforeFiles, afterFiles) {
  const before = new Map(asArray(beforeFiles).map((f) => [f.filename, lineCounts(f.source)]));
  const out = [];
  for (const f of asArray(afterFiles)) {
    const available = before.get(f.filename) ?? new Map();
    const remaining = new Map(available); // consumed per file; never mutate the shared map
    const lines = [];
    String(f.source ?? "").split(/\r?\n/).forEach((raw, i) => {
      const key = raw.trim();
      if (key === "") return; // a blank line carries no finding
      const left = remaining.get(key) ?? 0;
      if (left > 0) remaining.set(key, left - 1);
      else lines.push(i + 1);
    });
    if (lines.length > 0) out.push({ file: f.filename, lines });
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/**
 * Step 3: the whole seam in one call — bundles + findings → `renderOfflineVerdict`. Calls the
 * COMPOSITION, never the raw `offlineVerdict` reducer: `renderOfflineVerdict` joins
 * `offlineRatchetGate` to it so the gate's SIGNED `atc_warn_delta` is what the verdict conjunct
 * consumes and the two can never disagree. Calling the reducer directly would bypass the ratchet.
 *
 * Note the gate node carries no `parity_required`: the bite conjunct is DEV-only and the offline
 * gate partitions it out, so passing it would be inert at best and misleading at worst.
 *
 * @param {{canonical_sig: string}} node
 * @param {{before: object, after: object, findings?: object, baselines: object, beforeFiles?: Array<object>, afterFiles?: Array<object>, attestations?: object, block_reason?: string, touched_files?: string[]}} inputs
 * @returns {{gate: object, verdict: object, provisional: boolean, reasons: string[]}} — `provisional`,
 *   never `green`: offline NEVER GREENs (P6).
 */
export function renderOfflineNodeVerdict(node, inputs) {
  const evidence = offlineEvidence(inputs);
  const checkpoint = offlineCheckpoint(inputs.before, inputs.after, inputs);
  const gateNode = { canonical_sig: node.canonical_sig, diff_changed_lines: evidence.diff_changed_lines };
  return renderOfflineVerdict(gateNode, checkpoint, evidence, inputs.baselines);
}

/** priority-1 / priority-2 counts — the two hard-blocking tiers (C3). */
function atcCounts(findings) {
  let atc_p1 = 0;
  let atc_p2 = 0;
  for (const f of findingsOf(findings)) {
    if (f.severity === "priority-1") atc_p1 += 1;
    else if (f.severity === "priority-2") atc_p2 += 1;
  }
  return { atc_p1, atc_p2 };
}

/** Trimmed non-blank line → occurrence count. */
function lineCounts(source) {
  const counts = new Map();
  for (const raw of String(source ?? "").split(/\r?\n/)) {
    const key = raw.trim();
    if (key === "") continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
