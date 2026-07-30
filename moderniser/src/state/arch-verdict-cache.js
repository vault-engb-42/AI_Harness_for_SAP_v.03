/**
 * The arch-reason verdict cache (BUILD_PLAN S14 / ADDITION A) — pure hash + integrity layer. Keyed on
 * (fact_hash, model_id, prompt_hash), it freezes the LLM judge's recommendation so a re-analyse with
 * unchanged facts reuses it — no re-invocation, no human re-ratify — and makes the ARCH-DESIGN PHASE
 * idempotent + audit-reproducible. A pinned model swap or a committed-prompt edit is a MISS, surfaced.
 *
 * Integrity: `entry_hash = sha256(canonicalJSON({fact_hash, model_id, prompt_hash, recommendation}))`;
 * every read verifies it and REJECTS a mismatch (fail-closed, like loadPlan). Pure — the durable read/save
 * live in cli-io.js (readArchVerdictCache/saveArchVerdictCache) at io.stateDir (CROSS-RUN).
 */
import { createHash } from "node:crypto";
import { canonicalJSON } from "./canonical-json.js";

/** The cache key — MUST match arch-reason.js `entryKey` (a unit test asserts it). */
export function cacheKey(factHash, modelId, promptHash) {
  return `${factHash}:${modelId}:${promptHash}`;
}

/** The integrity hash over the entry's identity + payload. */
export function entryHash({ fact_hash, model_id, prompt_hash, recommendation }) {
  return createHash("sha256").update(canonicalJSON({ fact_hash, model_id, prompt_hash, recommendation })).digest("hex");
}

/** Build a self-verifying entry. */
export function makeEntry(factHash, modelId, promptHash, recommendation) {
  const base = { fact_hash: factHash, model_id: modelId, prompt_hash: promptHash, recommendation };
  return { ...base, entry_hash: entryHash(base) };
}

/** Insert/replace an entry (copy-on-write). */
export function putEntry(cache, factHash, modelId, promptHash, recommendation) {
  const entry = makeEntry(factHash, modelId, promptHash, recommendation);
  return { ...cache, entries: { ...(cache?.entries ?? {}), [cacheKey(factHash, modelId, promptHash)]: entry } };
}

/** The recommendation for a key, or null; throws on an entry_hash mismatch (corrupt/tampered — fail-closed). */
export function getRecommendation(cache, factHash, modelId, promptHash) {
  const key = cacheKey(factHash, modelId, promptHash);
  const entry = cache?.entries?.[key];
  if (!entry) return null;
  if (entry.entry_hash !== entryHash(entry)) {
    throw new Error(`arch-verdict-cache: entry_hash mismatch for '${key}' — corrupt or tampered cache`);
  }
  return entry.recommendation;
}

/**
 * Flatten the durable cache to the plain `{ key -> recommendation }` lookup arch-reason.js consumes,
 * verifying every entry_hash first (fail-closed on any tamper). This is the seam between the persisted,
 * integrity-checked cache and the pure reasoner.
 */
export function toLookup(cache) {
  const out = {};
  for (const [key, entry] of Object.entries(cache?.entries ?? {})) {
    if (entry.entry_hash !== entryHash(entry)) {
      throw new Error(`arch-verdict-cache: entry_hash mismatch for '${key}' — corrupt or tampered cache`);
    }
    out[key] = entry.recommendation;
  }
  return out;
}
