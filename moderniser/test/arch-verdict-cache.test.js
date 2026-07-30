import { test } from "node:test";
import assert from "node:assert/strict";
import { cacheKey, makeEntry, entryHash, putEntry, getRecommendation, toLookup } from "../src/state/arch-verdict-cache.js";
import { entryKey, reasonArchitecture } from "../src/plan/arch-reason.js";
import { factStream, factHash } from "../src/plan/arch-facts.js";

// B3.5a (BUILD_PLAN S14 / ADDITION A): the verdict cache integrity layer. Keyed on
// (fact_hash, model_id, prompt_hash); entry_hash rejects a tampered cache (fail-closed).

const REC = { sig: "sigA", target_shape: "rap_bo_headless", components: ["cds_interface"], invariants: [], candidates: [{ id: "rap_bo_headless", score: 1 }], source: "judge" };

test("cacheKey matches arch-reason.js entryKey exactly (the cache and the reasoner agree)", () => {
  assert.equal(cacheKey("fh", "opus", "ph1"), entryKey("fh", "opus", "ph1"));
});

test("makeEntry produces a self-consistent entry_hash", () => {
  const e = makeEntry("fh", "opus", "ph1", REC);
  assert.equal(e.entry_hash, entryHash(e));
  assert.equal(e.fact_hash, "fh");
  assert.equal(e.model_id, "opus");
});

test("putEntry + getRecommendation round-trips; a miss returns null", () => {
  const cache = putEntry({ entries: {} }, "fh", "opus", "ph1", REC);
  assert.deepEqual(getRecommendation(cache, "fh", "opus", "ph1"), REC);
  assert.equal(getRecommendation(cache, "fh", "opus", "ph2"), null, "a prompt-hash miss");
  assert.equal(getRecommendation(cache, "fh", "sonnet", "ph1"), null, "a model miss");
});

test("getRecommendation FAILS CLOSED on an entry_hash mismatch (tampered recommendation)", () => {
  const cache = putEntry({ entries: {} }, "fh", "opus", "ph1", REC);
  cache.entries[cacheKey("fh", "opus", "ph1")].recommendation.target_shape = "rap_bo_fiori"; // tamper, hash unchanged
  assert.throws(() => getRecommendation(cache, "fh", "opus", "ph1"), /entry_hash mismatch/i);
});

test("toLookup flattens the durable cache to arch-reason's plain key→recommendation map, verifying every entry", () => {
  let cache = putEntry({ entries: {} }, "fh1", "opus", "ph1", REC);
  cache = putEntry(cache, "fh2", "opus", "ph1", { ...REC, sig: "sigB" });
  const lookup = toLookup(cache);
  assert.equal(Object.keys(lookup).length, 2);
  assert.deepEqual(lookup[cacheKey("fh1", "opus", "ph1")], REC);
  // tamper → toLookup throws (never silently serves a corrupt entry)
  cache.entries[cacheKey("fh2", "opus", "ph1")].fact_hash = "spoofed";
  assert.throws(() => toLookup(cache), /entry_hash mismatch/i);
});

test("INTEGRATION: a frozen entry drives reasonArchitecture to a 'cached' hit (no re-reason)", () => {
  const node = {
    id: "sigA", object: "ZFOO", kind: "object", object_kind: "class", members: ["ZFOO"],
    finding_families: [], driving_rule_ids: [], disposition_hints: [], disposition: "re_architect",
    disposition_confidence: 0.7, member_meta: { ZFOO: { grade: "D", complexity: 5, blast: 2 } },
    modernization_target: "RAP Business Object", dependencies: [],
  };
  const fact = factStream(node, {});
  const fh = factHash(node, {});
  const durable = putEntry({ entries: {} }, fh, "opus", "ph1", REC);
  const res = reasonArchitecture(node, fact, [{ id: "rap_bo_headless", score: 1 }], toLookup(durable), { model_id: "opus", prompt_hash: "ph1" });
  assert.equal(res.status, "cached");
  assert.deepEqual(res.recommendation, REC);
});
