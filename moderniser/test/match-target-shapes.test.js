import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { matchTargetShapes, loadPatternCorpus, PATTERN_IDS } from "../src/plan/patterns/match.js";
import { consumptionFacts } from "../src/plan/consumption-facts.js";
import { factStream } from "../src/plan/arch-facts.js";
import { assemblePlan } from "../src/sched/assemble.js";

// B3.5 seam 2 (BUILD_PLAN S11/S14): the extensible patterns corpus + the PURE deterministic matcher.
// match.js PROPOSES ranked target_shape candidates from the fact stream; the LLM judge (S14) SELECTS
// among them only for the escalated subset. Deterministic, closed over the corpus, no I/O per call.

const fact = (o = {}) => ({
  object_kind: "class", graph_kind: "object", finding_families: [], driving_rule_ids: [],
  disposition_hints: [], disposition: "re_architect", consumption: [], modernization_target: null,
  member_summary: { members: 1, worst_grade: "D", max_complexity: 1, total_blast: 0 }, dependency_count: 0, ...o,
});

test("the corpus is a well-formed, closed set of pattern entries (id/name/when_signals/components/…)", () => {
  const corpus = loadPatternCorpus();
  assert.ok(Array.isArray(corpus.patterns) && corpus.patterns.length >= 8, "≥8 seed patterns");
  const seeds = corpus.patterns.map((p) => p.id).sort();
  for (const required of ["rap_bo_headless", "rap_bo_odata", "rap_bo_fiori", "rap_bo_events", "released_replace"]) {
    assert.ok(seeds.includes(required), `corpus seeds ${required}`);
  }
  for (const p of corpus.patterns) {
    for (const k of ["id", "name", "when_signals", "components", "grounding_refs", "invariants", "example"]) {
      assert.ok(k in p, `pattern ${p.id} declares ${k}`);
    }
    assert.ok(Array.isArray(p.components) && p.components.length > 0, `${p.id} has components`);
  }
  assert.deepEqual(PATTERN_IDS, seeds, "PATTERN_IDS is the sorted id set");
});

test("matchTargetShapes returns ranked candidates whose ids are all corpus members; scores are numbers", () => {
  const out = matchTargetShapes(fact({ consumption: ["ui_salv"] }));
  assert.ok(out.length >= 1);
  for (const c of out) {
    assert.ok(PATTERN_IDS.includes(c.id), `${c.id} ∈ corpus`);
    assert.equal(typeof c.score, "number");
    assert.ok(Array.isArray(c.components));
  }
});

test("a re_architect node with NO UI and NO remote consumption → rap_bo_headless is the top candidate (S14 TDD)", () => {
  const out = matchTargetShapes(fact({ disposition: "re_architect", consumption: ["batch_report"] }));
  assert.equal(out[0].id, "rap_bo_headless");
  // headless must NOT drag in a service/metadata shape when there is no UI/remote surface
  assert.ok(!out.some((c) => c.id === "rap_bo_fiori"), "no Fiori candidate without a UI surface");
  assert.ok(!out.some((c) => c.id === "rap_bo_odata"), "no OData candidate without remote consumption");
});

test("adding a UI consumption fact adds rap_bo_fiori as a candidate (S14 TDD)", () => {
  const headless = matchTargetShapes(fact({ consumption: ["batch_report"] }));
  const withUi = matchTargetShapes(fact({ consumption: ["batch_report", "ui_salv"] }));
  assert.ok(!headless.some((c) => c.id === "rap_bo_fiori"));
  assert.ok(withUi.some((c) => c.id === "rap_bo_fiori"), "a UI-consumption fact surfaces the Fiori shape");
});

test("remote consumption without UI → rap_bo_odata; IDoc → rap_bo_events", () => {
  const odata = matchTargetShapes(fact({ consumption: ["remote_bapi"] })).map((c) => c.id);
  assert.ok(odata.includes("rap_bo_odata"));
  assert.ok(!odata.includes("rap_bo_fiori"), "no Fiori without a UI surface");
  const events = matchTargetShapes(fact({ consumption: ["remote_idoc"] })).map((c) => c.id);
  assert.ok(events.includes("rap_bo_events"));
});

test("a UI + remote node yields MULTIPLE candidates (ambiguity → the LLM will be escalated to select)", () => {
  const out = matchTargetShapes(fact({ consumption: ["ui_salv", "remote_bapi"] }));
  const ids = out.map((c) => c.id);
  assert.ok(ids.includes("rap_bo_fiori") && ids.includes("rap_bo_odata"), "both surfaces propose their shape");
  assert.ok(out.length > 1, "|candidates| > 1 (escalation trigger)");
});

test("replace disposition → released_replace candidate (fit-to-standard adopt)", () => {
  const out = matchTargetShapes(fact({ disposition: "replace", modernization_target: null })).map((c) => c.id);
  assert.ok(out.includes("released_replace"));
});

test("matchTargetShapes is deterministic and stable-ranked (byte-identical over two runs)", () => {
  const f = fact({ consumption: ["ui_salv", "remote_bapi", "batch_report"] });
  assert.equal(JSON.stringify(matchTargetShapes(f)), JSON.stringify(matchTargetShapes(f)));
  // rank is score desc then id asc — a total order, no ties left unresolved
  const out = matchTargetShapes(f);
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i - 1].score > out[i].score || (out[i - 1].score === out[i].score && out[i - 1].id < out[i].id), "stable total order");
  }
});

test("an unknown signal type in the corpus fails closed (never silently matches)", () => {
  const badCorpus = { patterns: [{ id: "x", name: "x", when_signals: { any: ["bogus:foo"] }, components: ["c"], grounding_refs: [], invariants: [], example: "" }] };
  assert.throws(() => matchTargetShapes(fact(), badCorpus), /unknown signal type/i);
});

// Integration: the real abap_fico node, end-to-end through the seam-1 fact stream.
test("INTEGRATION abap_fico: the real node's fact stream → exactly [rap_bo_headless] (single candidate, no LLM needed)", () => {
  const doc = JSON.parse(readFileSync("moderniser/test/fixtures/analyser-findings.json", "utf8"));
  const cons = consumptionFacts(doc);
  const { plan } = assemblePlan(doc);
  for (const node of plan.nodes) {
    const f = factStream(node, cons);
    const out = matchTargetShapes(f);
    assert.equal(out[0].id, "rap_bo_headless", `abap_fico node ${node.id.slice(0, 8)} tops at rap_bo_headless`);
    assert.ok(!out.some((c) => c.id === "rap_bo_fiori" || c.id === "rap_bo_odata"), "a batch/file BO stays headless — no service/metadata shape");
  }
});

// The failure mode the reachability + absence work exists to close: `rap_bo_headless` matched on
// `none: [ui_*, remote_*]`, so an object the detector could not read scored identically to one proven to
// have no surface. On TALV that produced 23 headless nodes for an interactive ALV table-maintenance
// framework, 20 of them recorded by the matcher with no judge involved. Now that silence is expressible,
// the pattern can refuse it: headless is a claim about evidence, not about quiet.
test("headless is NOT offered for an object the detector could not read", () => {
  const fact = {
    object_kind: "class", graph_kind: "object", finding_families: [], driving_rule_ids: [],
    disposition_hints: [], disposition: "re_architect", consumption: ["no_surface_evidence"],
    modernization_target: "RAP Business Object",
    member_summary: { members: 1, worst_grade: "unknown", max_complexity: 0, total_blast: 0 },
    dependency_count: 0,
  };
  const ids = matchTargetShapes(fact, loadPatternCorpus()).map((c) => c.id);
  assert.ok(
    !ids.includes("rap_bo_headless"),
    `silence must not select a shape: ${JSON.stringify(ids)}`,
  );
});

test("headless IS still offered when the evidence positively shows no surface", () => {
  // A batch report with a real, read consumption surface and no UI/remote facts is genuinely headless —
  // the guard must reject silence, not reject headless.
  const fact = {
    object_kind: "class", graph_kind: "object", finding_families: ["performance"], driving_rule_ids: [],
    disposition_hints: [], disposition: "re_architect", consumption: ["batch_report"],
    modernization_target: "RAP Business Object",
    member_summary: { members: 1, worst_grade: "D", max_complexity: 3, total_blast: 2 },
    dependency_count: 1,
  };
  const ids = matchTargetShapes(fact, loadPatternCorpus()).map((c) => c.id);
  assert.ok(ids.includes("rap_bo_headless"), `evidenced headless must still match: ${JSON.stringify(ids)}`);
});
