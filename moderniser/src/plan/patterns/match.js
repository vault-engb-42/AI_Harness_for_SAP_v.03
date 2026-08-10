/**
 * The PURE target-shape matcher (BUILD_PLAN S11/S14). Given the deterministic fact stream
 * (arch-facts.js), it PROPOSES ranked `target_shape` candidates from the patterns corpus — never
 * decides. The LLM judge (S14) SELECTS among these candidates only for the escalated subset; a
 * high-confidence single-candidate node takes the top candidate directly, with no model call.
 *
 * Deterministic, closed over the corpus, no per-call I/O (the corpus loads lazily, once). The
 * `when_signals` predicate reads the STRUCTURAL fact stream (consumption booleans + families +
 * disposition + object_kind), so a coarse analyser `modernization_target` never dictates the shape.
 * An unknown signal type is a corpus authoring error and throws (fail-closed — never a silent match).
 */
import { readFileSync } from "node:fs";

let _corpus = null;

/** Lazily load + cache the bundled patterns corpus (no module-level I/O side effect). */
export function loadPatternCorpus() {
  if (_corpus === null) {
    _corpus = JSON.parse(readFileSync(new URL("./target-patterns.json", import.meta.url), "utf8"));
  }
  return _corpus;
}

/** The sorted set of corpus pattern ids (the closed target_shape vocabulary). */
export const PATTERN_IDS = loadPatternCorpus().patterns.map((p) => p.id).sort();

/**
 * @param {object} fact the fact stream (arch-facts.js `factStream`)
 * @param {{patterns: Array<object>}} [corpus] the patterns corpus (injectable for tests)
 * @returns {Array<{id: string, name: string, score: number, components: string[], grounding_refs: string[], invariants: string[]}>}
 *   ranked candidates (score desc, then id asc — a total order)
 */
export function matchTargetShapes(fact, corpus = loadPatternCorpus()) {
  const scored = [];
  for (const p of corpus.patterns) {
    const { matched, score } = evalWhen(p.when_signals, fact);
    if (matched) {
      scored.push({ id: p.id, name: p.name, score, components: p.components, grounding_refs: p.grounding_refs ?? [], invariants: p.invariants ?? [] });
    }
  }
  scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return scored;
}

/**
 * Evaluate a when-signals predicate against the fact stream.
 * `all` — every signal must hold; `any` — at least one must hold; `none` — none may hold.
 * The match SCORE is the count of satisfied POSITIVE signals (all + any) — `none` is a constraint,
 * not evidence, so it does not contribute to the score.
 */
function evalWhen(when, fact) {
  const all = when?.all ?? [];
  const any = when?.any ?? [];
  const none = when?.none ?? [];

  const allOk = all.every((s) => signalHolds(s, fact));
  const anyOk = any.length === 0 || any.some((s) => signalHolds(s, fact));
  const noneOk = !none.some((s) => signalHolds(s, fact));
  if (!(allOk && anyOk && noneOk)) return { matched: false, score: 0 };

  const score = all.filter((s) => signalHolds(s, fact)).length + any.filter((s) => signalHolds(s, fact)).length;
  return { matched: true, score };
}

/** Evaluate one `type:value` signal against the fact stream. Throws on an unknown type (fail-closed). */
function signalHolds(signal, fact) {
  const idx = String(signal).indexOf(":");
  const type = idx === -1 ? signal : signal.slice(0, idx);
  const value = idx === -1 ? "" : signal.slice(idx + 1);
  switch (type) {
    case "consumption": return (fact.consumption ?? []).includes(value);
    case "hint": return (fact.disposition_hints ?? []).includes(value);
    // The analyser's own rule verdict. `driving_rule_ids` has been in the fact stream since S14 with no
    // signal type able to read it, and it is the ONLY evidence for a surface that leaves no CPG edge: a
    // dynpro is a screen, not a call, so `talos-cloud-014-classic-dynpro` is what sees it at all. It is
    // preferred over `hint:ui_rearch` because that hint collapses a screen and a WRITE list into one token.
    case "rule": return (fact.driving_rule_ids ?? []).includes(value);
    case "family": return (fact.finding_families ?? []).includes(value);
    case "disposition": return fact.disposition === value;
    case "target": return fact.modernization_target === value;
    case "object_kind": return fact.object_kind === value;
    default: throw new Error(`match: unknown signal type '${type}' in corpus signal '${signal}'`);
  }
}
