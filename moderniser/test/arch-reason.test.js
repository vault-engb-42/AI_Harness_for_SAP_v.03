import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  reasonArchitecture, needsReasoning, validateSelection, entryKey,
  ARCH_REASON_CONFIDENCE_CEILING, ARCH_REASON_BLAST_BOUND,
} from "../src/plan/arch-reason.js";
import { factStream, factHash } from "../src/plan/arch-facts.js";
import { consumptionFacts } from "../src/plan/consumption-facts.js";
import { matchTargetShapes } from "../src/plan/patterns/match.js";
import { assemblePlan } from "../src/sched/assemble.js";

// B3.5 seam 4 (BUILD_PLAN S14): the PURE arch-reason engine. It NEVER calls the model — on the
// deterministic subset it returns the top candidate; on the escalated subset it returns a cached
// recommendation (cache hit) or an `await_arch` request (cache miss) the FULFILLER acts on (spawns the
// judge). Mirrors the S8 renderOfflineNodeVerdict → driveOfflineVerdict split.

const node = (o = {}) => ({
  id: "sigA", object: "ZFOO", kind: "object", object_kind: "class",
  members: ["ZFOO"], finding_families: ["clean-core"], driving_rule_ids: ["r1"], disposition_hints: ["ui_rearch"],
  disposition: "re_architect", disposition_confidence: 0.7,
  member_meta: { ZFOO: { grade: "D", complexity: 5, blast: 2 } }, modernization_target: "RAP Business Object", dependencies: [], ...o,
});
const cand = (id, score = 1) => ({ id, name: id, score, components: ["cds_interface"], invariants: ["dcl_authorization"] });

test("ARCH_REASON_CONFIDENCE_CEILING ∈ (0,1]; ARCH_REASON_BLAST_BOUND is a positive number", () => {
  assert.ok(ARCH_REASON_CONFIDENCE_CEILING > 0 && ARCH_REASON_CONFIDENCE_CEILING <= 1);
  assert.ok(ARCH_REASON_BLAST_BOUND > 0);
});

// ---- needsReasoning (the escalation predicate) ----

test("needsReasoning: a non-arch disposition (refactor/replace/retire/seal) never reasons", () => {
  for (const d of ["refactor", "replace", "retire", "seal"]) {
    assert.equal(needsReasoning(node({ disposition: d, disposition_confidence: 0.2 }), [cand("x")]), false, d);
  }
});

test("needsReasoning: re_architect below the confidence ceiling → escalate", () => {
  assert.equal(needsReasoning(node({ disposition_confidence: 0.7 }), [cand("rap_bo_headless")]), true);
});

test("needsReasoning: re_architect, high confidence, single candidate, low blast → NO reasoning (bypass)", () => {
  const n = node({ disposition_confidence: 0.95, member_meta: { ZFOO: { grade: "B", complexity: 2, blast: 1 } } });
  assert.equal(needsReasoning(n, [cand("rap_bo_headless")]), false);
});

test("needsReasoning: ambiguity (>1 candidate) forces reasoning even at high confidence", () => {
  const n = node({ disposition_confidence: 0.99 });
  assert.equal(needsReasoning(n, [cand("rap_bo_fiori"), cand("rap_bo_odata")]), true);
});

test("needsReasoning: high blast radius forces reasoning even for a single high-confidence candidate", () => {
  const n = node({ disposition_confidence: 0.99, member_meta: { ZFOO: { grade: "D", complexity: 5, blast: ARCH_REASON_BLAST_BOUND + 1 } } });
  assert.equal(needsReasoning(n, [cand("rap_bo_headless")]), true);
});

test("needsReasoning: rebuild is a reasoning disposition like re_architect", () => {
  assert.equal(needsReasoning(node({ disposition: "rebuild", disposition_confidence: 0.7 }), [cand("x")]), true);
});

// ---- reasonArchitecture (the 4 outcomes) ----

test("reasonArchitecture: a non-arch disposition → status 'skip' (no fact hash needed, no model)", () => {
  const res = reasonArchitecture(node({ disposition: "refactor" }), factStream(node(), {}), [cand("x")], {}, { model_id: "m", prompt_hash: "p" });
  assert.equal(res.status, "skip");
});

test("reasonArchitecture: high-confidence single candidate → 'deterministic' (top candidate, NO model)", () => {
  const n = node({ disposition_confidence: 0.95, member_meta: { ZFOO: { grade: "B", complexity: 1, blast: 0 } } });
  const f = factStream(n, {});
  const res = reasonArchitecture(n, f, [cand("rap_bo_headless")], {}, { model_id: "m", prompt_hash: "p" });
  assert.equal(res.status, "deterministic");
  assert.equal(res.recommendation.target_shape, "rap_bo_headless");
  assert.equal(res.recommendation.source, "deterministic");
  assert.equal(res.fact_hash, factHash(n, {}));
});

test("reasonArchitecture: escalated + cache MISS → 'await_arch' with the request the fulfiller acts on", () => {
  const n = node({ disposition_confidence: 0.7 });
  const f = factStream(n, {});
  const cands = [cand("rap_bo_headless")];
  const res = reasonArchitecture(n, f, cands, {}, { model_id: "opus", prompt_hash: "ph1" });
  assert.equal(res.status, "await_arch");
  assert.deepEqual(res.request.fact, f, "the request carries the P8 fact stream — the ONLY prompt input");
  assert.equal(res.request.model_id, "opus");
  assert.equal(res.request.prompt_hash, "ph1");
  assert.ok(res.request.prompt_ref.endsWith("arch-reason-prompt.md"));
  assert.equal(res.request.candidates[0].id, "rap_bo_headless");
});

test("reasonArchitecture: escalated + cache HIT → 'cached' (frozen recommendation, no request, byte-identical)", () => {
  const n = node({ disposition_confidence: 0.7 });
  const f = factStream(n, {});
  const fh = factHash(n, {});
  const frozen = { sig: "sigA", target_shape: "rap_bo_headless", components: ["cds_interface"], invariants: [], candidates: [{ id: "rap_bo_headless", score: 1 }], source: "judge" };
  const cache = { [entryKey(fh, "opus", "ph1")]: frozen };
  const res = reasonArchitecture(n, f, [cand("rap_bo_headless")], cache, { model_id: "opus", prompt_hash: "ph1" });
  assert.equal(res.status, "cached");
  assert.deepEqual(res.recommendation, frozen);
  assert.equal(res.request, undefined);
});

test("reasonArchitecture: a cache entry under a DIFFERENT model_id/prompt_hash is a MISS (surfaced, never silent)", () => {
  const n = node({ disposition_confidence: 0.7 });
  const f = factStream(n, {});
  const fh = factHash(n, {});
  const cache = { [entryKey(fh, "opus", "ph1")]: { target_shape: "rap_bo_headless" } };
  assert.equal(reasonArchitecture(n, f, [cand("rap_bo_headless")], cache, { model_id: "opus", prompt_hash: "ph2" }).status, "await_arch", "prompt drift → miss");
  assert.equal(reasonArchitecture(n, f, [cand("rap_bo_headless")], cache, { model_id: "sonnet", prompt_hash: "ph1" }).status, "await_arch", "model drift → miss");
});

test("reasonArchitecture: escalated with NO candidate → 'await_arch' (a bespoke/other decision the judge must make)", () => {
  const n = node({ disposition_confidence: 0.7 });
  const res = reasonArchitecture(n, factStream(n, {}), [], {}, { model_id: "m", prompt_hash: "p" });
  assert.equal(res.status, "await_arch");
});

test("the await_arch request never carries the node sig into the fact (P8: the prompt is built from request.fact only)", () => {
  const n = node({ id: "sig-CUSTOMER-DERIVED", disposition_confidence: 0.7 });
  const res = reasonArchitecture(n, factStream(n, {}), [cand("rap_bo_headless")], {}, { model_id: "m", prompt_hash: "p" });
  assert.ok(!JSON.stringify(res.request.fact).includes("sig-CUSTOMER-DERIVED"), "the fact stream (the prompt source) is sig-free");
});

// ---- validateSelection (fulfiller guard) + entryKey ----

test("validateSelection: an in-candidate shape passes; 'other' passes; an out-of-candidate shape throws (fail-closed)", () => {
  const cands = [cand("rap_bo_fiori"), cand("rap_bo_odata")];
  assert.ok(validateSelection({ target_shape: "rap_bo_fiori" }, cands));
  assert.ok(validateSelection({ target_shape: "other" }, cands));
  assert.throws(() => validateSelection({ target_shape: "cap_side_by_side" }, cands), /outside the match candidates/i);
  assert.throws(() => validateSelection({}, cands), /missing target_shape/i);
});

test("entryKey is a deterministic function of (fact_hash, model_id, prompt_hash)", () => {
  assert.equal(entryKey("fh", "m", "p"), entryKey("fh", "m", "p"));
  assert.notEqual(entryKey("fh", "m", "p"), entryKey("fh", "m", "p2"));
});

// ---- integration: real abap_fico nodes escalate (low classifier confidence) ----

test("INTEGRATION abap_fico: each re_architect node escalates to the judge (confidence < ceiling), candidates top = rap_bo_headless", () => {
  const doc = JSON.parse(readFileSync("moderniser/test/fixtures/analyser-findings.json", "utf8"));
  const cons = consumptionFacts(doc);
  const { plan } = assemblePlan(doc);
  for (const n of plan.nodes) {
    const f = factStream(n, cons);
    const res = reasonArchitecture(n, f, matchTargetShapes(f), {}, { model_id: "opus", prompt_hash: "ph1" });
    assert.equal(res.status, "await_arch", "a 0.7–0.85-confidence coarse classification is escalated, not rubber-stamped");
    assert.equal(res.request.candidates[0].id, "rap_bo_headless", "the judge is offered the structural headless candidate");
  }
});
