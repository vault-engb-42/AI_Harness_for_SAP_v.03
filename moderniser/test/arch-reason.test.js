import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  reasonArchitecture, needsReasoning, validateSelection, entryKey,
  ARCH_REASON_CONFIDENCE_CEILING, ARCH_REASON_BLAST_BOUND, freezeHumanSelection,
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

// P3: an operator-overridden node has NO classifier confidence — the human rejected the classifier's
// recommendation, so there is no number to carry. Absence propagates and the existing `?? 0` coercion
// escalates on its own; the predicate never reads decision provenance. (Same doctrine as F1/F5 elsewhere:
// a fabricated value is indistinguishable from a real one, so absence must reach the guard intact.)
test("needsReasoning: an ABSENT classifier confidence escalates — the bypass needs an established number, not a default", () => {
  const lowBlast = { ZFOO: { grade: "B", complexity: 2, blast: 1 } }; // every other bypass condition is met
  for (const absent of [null, undefined]) {
    const n = node({ disposition_confidence: absent, disposition_source: "operator_override", member_meta: lowBlast });
    assert.equal(needsReasoning(n, [cand("rap_bo_headless")]), true, `confidence ${absent} must not buy a deterministic bypass`);
  }
  // and it escalates on the ABSENCE alone — the predicate must not need to know who decided
  const noProvenance = node({ disposition_confidence: null, member_meta: lowBlast });
  assert.equal(needsReasoning(noProvenance, [cand("rap_bo_headless")]), true, "no special case on disposition_source");
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

test("reasonArchitecture: NO candidate → 'no_shape', because the judge route is a dead end", () => {
  // This test used to assert `await_arch` — "a bespoke/other decision the judge must make". That route
  // cannot complete: the request carries an empty `candidates` list, the judge is bound to select from it,
  // and its only remaining answer `other` passes validateSelection but then throws in freezeJudgeSelection
  // ("cannot be frozen — add it to the patterns corpus first"). So the node rested at
  // await_human/arch_ratification with no shape any human could ratify. The intent was sound; the mechanism
  // to deliver it was never built. `no_shape` says the true thing instead, and routes the human to
  // re-disposition the object rather than to invent a shape.
  const res = reasonArchitecture({ id: "s1", disposition: "re_architect" }, { object_kind: "class" }, [], {}, {});
  assert.equal(res.status, "no_shape");
  assert.ok(!res.request, "no judge request — there is nothing to choose from");
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

// An object whose facts justify NO shape is not a judge question — the judge would be handed an empty
// candidate list, could only answer "other", and `freezeJudgeSelection` refuses that ("add it to the
// patterns corpus first"). Before this, such a node sat at await_human/arch_ratification with no shape any
// human could pick: a gate nobody can clear. It surfaced the moment `rap_bo_headless` stopped accepting
// silence — 11 of TALV's 24 arch-gated nodes land here, which is the honest count of objects the harness
// cannot place, and it must READ as that rather than as a pending judgment.
test("a node no shape fits is reported as unplaceable, not sent to the judge with nothing to choose", () => {
  const node = { id: "sig-unplaceable", disposition: "re_architect" };
  const fact = {
    object_kind: "class", graph_kind: "object", finding_families: [], driving_rule_ids: [],
    disposition_hints: [], disposition: "re_architect", consumption: ["no_surface_evidence"],
    modernization_target: "RAP Business Object",
    member_summary: { members: 1, worst_grade: "unknown", max_complexity: 0, total_blast: 0 },
    dependency_count: 0,
  };
  const res = reasonArchitecture(node, fact, [], {}, {});
  assert.equal(res.status, "no_shape", `got ${res.status}`);
  assert.ok(res.reason && /shape|evidence|place/i.test(res.reason), `it must say why: ${res.reason}`);
  assert.ok(!res.request, "no judge request is issued — there is nothing to select from");
});

test("a node WITH candidates still escalates to the judge as before", () => {
  const node = { id: "sig-normal", disposition: "re_architect" };
  const fact = { object_kind: "class", consumption: ["ui_salv"], disposition: "re_architect" };
  const res = reasonArchitecture(node, fact, [{ id: "rap_bo_fiori", score: 3 }], {}, {});
  assert.notEqual(res.status, "no_shape", "a placeable node must not be diverted");
});

// APP-LEVEL GROUPING. `mergeShared` builds the app blueprint from `recommendation.shared`, but only
// `freezeJudgeSelection` ever attaches that field — the deterministic path's `recommend()` emits none. So a
// grouping could only ever come from a JUDGED row, and every matcher-resolved row was locked out of the
// app-level question entirely. On TALV that was 24 of 34 rows, which is why every blueprint so far came back
// {services:[],projections:[],fiori_apps:[]} — not because the answer was empty, but because most objects
// were never able to answer.
//
// A shape that implies cross-object structure now escalates even when the matcher settled it. The shape is
// NOT reopened: with a single candidate, validateSelection admits only that same id, so the judge can add
// the grouping and nothing else.
test("a shape implying cross-object structure escalates for the grouping, even when the matcher settled it", () => {
  for (const shape of ["rap_bo_fiori", "rap_bo_odata", "analytical_cds"]) {
    const node = { id: `sig-${shape}`, disposition: "re_architect", disposition_confidence: 0.99 };
    const res = reasonArchitecture(node, { object_kind: "class" }, [{ id: shape, score: 5 }], {}, {});
    assert.equal(res.status, "await_arch", `${shape} must reach the judge for its app-level grouping`);
    assert.deepEqual(res.request.candidates.map((c) => c.id), [shape],
      "and it is offered exactly one shape, so the judge cannot re-pick it");
  }
});

test("a self-contained shape is still settled by the matcher — no needless judge round-trip", () => {
  const node = { id: "sig-headless", disposition: "re_architect", disposition_confidence: 0.99 };
  const res = reasonArchitecture(node, { object_kind: "class" }, [{ id: "rap_bo_headless", score: 5 }], {}, {});
  assert.equal(res.status, "deterministic", "a headless BO shares nothing — asking would be waste");
});

// A HUMAN-SUPPLIED shape cannot go through freezeJudgeSelection: that validates against the matcher's
// CANDIDATES, and an unplaceable node has none by definition. The human is overruling the absence, not
// choosing among offers, so the corpus is the only thing their choice must satisfy.

test("freezeHumanSelection builds a contract for a shape the matcher offered NO candidates for", () => {
  const node = { id: "A".repeat(64), object: "ZFI_C0002", object_kind: "function", disposition: "re_architect" };
  const rec = freezeHumanSelection(node, { target_shape: "rap_bo_odata", decided_by: "panos" });
  assert.equal(rec.target_shape, "rap_bo_odata");
  assert.equal(rec.source, "human", "never `judge` — the proof bundle must not claim a judge chose this");
  assert.equal(rec.decided_by, "panos", "a shape the evidence could not justify carries a name");
  assert.ok((rec.components?.length ?? 0) > 0, "and the corpus components the generator will build");
});

test("freezeHumanSelection still refuses a shape the CORPUS does not contain", () => {
  const node = { id: "A".repeat(64), object: "ZX", object_kind: "function", disposition: "re_architect" };
  assert.throws(
    () => freezeHumanSelection(node, { target_shape: "rap_bo_invented", decided_by: "panos" }),
    /corpus|rap_bo_invented/i,
    "overruling an objection is a judgement; naming a shape nothing can build is not",
  );
});
