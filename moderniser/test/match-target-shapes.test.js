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

// H-3 (independent ARCH_REVIEW, TALV 2026-08-10; CONFIRMED). ZFUNG_TALV was frozen `rap_bo_headless` while
// its own plan node carried `talos-cloud-014-classic-dynpro` + `talos-s4-004-screen-flow`. A dynpro is a
// SCREEN, not a call, so the CPG holds no edge for `consumption:ui_*` to fire on — and `driving_rule_ids`
// was in the fact stream all along with no signal type able to read it. The analyser's own screen verdict
// was the one piece of evidence that could see the object, and the matcher was blind to it.
//
// The signal is the RULE, not the coarse `ui_rearch` hint. Measured on the fixtures: the hint also fires on
// abap_fico's ZFICO_BTC_CSV_GL, whose UI rules are `talos-cloud-006-write` +
// `talos-s4-003-classic-list-output` — a batch report that WRITEs a list, which is not an interactive app
// and must stay headless. The rule ids separate a screen from a list; the hint collapses them.
test("a classic-dynpro rule is UI evidence even when the CPG holds no UI edge", () => {
  const fact = {
    object_kind: "function-group", graph_kind: "object", finding_families: ["clean_core"],
    driving_rule_ids: ["talos-cloud-014-classic-dynpro", "talos-s4-004-screen-flow"],
    disposition_hints: ["ui_rearch"], disposition: "re_architect", consumption: ["no_surface_evidence"],
    modernization_target: "OData V4 Service",
    member_summary: { members: 1, worst_grade: "D", max_complexity: 4, total_blast: 3 },
    dependency_count: 2,
  };
  const ids = matchTargetShapes(fact, loadPatternCorpus()).map((c) => c.id);
  assert.ok(ids.includes("rap_bo_fiori"), `a dynpro is a UI surface: ${JSON.stringify(ids)}`);
});

test("headless refuses an object the analyser found a screen in", () => {
  const fact = {
    object_kind: "report", graph_kind: "object", finding_families: ["clean_core"],
    driving_rule_ids: ["talos-s4-004-screen-flow"], disposition_hints: [], disposition: "re_architect",
    consumption: ["batch_report"], modernization_target: "RAP Business Object",
    member_summary: { members: 1, worst_grade: "C", max_complexity: 2, total_blast: 1 },
    dependency_count: 0,
  };
  const ids = matchTargetShapes(fact, loadPatternCorpus()).map((c) => c.id);
  assert.ok(!ids.includes("rap_bo_headless"), `a screen contradicts headless: ${JSON.stringify(ids)}`);
  assert.ok(ids.includes("rap_bo_fiori"), `and the UI shape must be on offer instead: ${JSON.stringify(ids)}`);
});

// The guard against the over-reach the measurement caught: a WRITE list is batch OUTPUT, not an interactive
// application, and the coarse `ui_rearch` hint cannot tell the two apart. This is abap_fico's real
// ZFICO_BTC_CSV_GL fact shape.
test("a WRITE-list batch report stays headless — a list is not a screen", () => {
  const fact = {
    object_kind: "report", graph_kind: "object", finding_families: ["clean_core"],
    driving_rule_ids: ["talos-cloud-006-write", "talos-legacy-ui-rollup", "talos-s4-003-classic-list-output"],
    disposition_hints: ["db_refactor", "style", "ui_rearch"], disposition: "re_architect",
    consumption: ["batch_report", "ui_frontend"], modernization_target: "RAP Business Object",
    member_summary: { members: 1, worst_grade: "D", max_complexity: 5, total_blast: 4 },
    dependency_count: 1,
  };
  const ids = matchTargetShapes(fact, loadPatternCorpus()).map((c) => c.id);
  assert.ok(ids.includes("rap_bo_headless"), `a batch list output is still headless: ${JSON.stringify(ids)}`);
  assert.ok(!ids.includes("rap_bo_fiori"), `and must NOT be handed a Fiori app: ${JSON.stringify(ids)}`);
});

// H-4 (independent ARCH_REVIEW, TALV 2026-08-10; CONFIRMED). `analytical_cds` was the one shape with NO
// `none` list, and its `any` accepts the analyser's coarse `modernization_target` alone — which is exactly
// what the corpus note forbids ("a coarse analyser modernization_target never dictates the shape"). On the
// two corpora it fired on four objects: ZTALV_FIELDS_SET, ZTALV_SERVICE, ZTALV_LAYOUT_SET and
// ZBC_IDOC_OPTIONS — every one a config/DDIC table with empty finding_families and no surface evidence at
// all. The harness proposed an analytical cube + query for a settings table because the analyser had
// written "CDS View Entity" in a field.
//
// A shape may not be justified on silence, whatever the coarse target says. `family:analytics` — real
// evidence — still selects it.
test("an analytical model is not conjured for an object with no evidence at all", () => {
  const fact = {
    object_kind: "table", graph_kind: "object", finding_families: [], driving_rule_ids: [],
    disposition_hints: [], disposition: "re_architect", consumption: ["no_surface_evidence"],
    modernization_target: "CDS View Entity",
    member_summary: { members: 1, worst_grade: "unknown", max_complexity: 0, total_blast: 0 },
    dependency_count: 0,
  };
  const ids = matchTargetShapes(fact, loadPatternCorpus()).map((c) => c.id);
  assert.ok(!ids.includes("analytical_cds"), `a coarse target is not analytics evidence: ${JSON.stringify(ids)}`);
});

test("an analytical model IS offered when the findings show analytics", () => {
  const fact = {
    object_kind: "report", graph_kind: "object", finding_families: ["analytics"], driving_rule_ids: [],
    disposition_hints: [], disposition: "re_architect", consumption: ["batch_report"],
    modernization_target: "CDS View Entity",
    member_summary: { members: 1, worst_grade: "C", max_complexity: 3, total_blast: 2 },
    dependency_count: 1,
  };
  const ids = matchTargetShapes(fact, loadPatternCorpus()).map((c) => c.id);
  assert.ok(ids.includes("analytical_cds"), `evidenced analytics must still match: ${JSON.stringify(ids)}`);
});

// The second half of H-4: `analytical_cds` published a query and declared only `analytics_annotations`,
// dropping `dcl_authorization` — the invariant every other data-exposing shape in the corpus carries, and
// one of the harness's immutable invariants (P4a). A shape that hands data to a consumer owes an
// authorization contract; this asserts it for the whole corpus so the next added pattern cannot repeat it.
test("every shape that exposes data to a consumer requires dcl_authorization", () => {
  const EXPOSING = new Set(["service_binding", "cds_analytical_query", "query_provider_class"]);
  for (const p of loadPatternCorpus().patterns) {
    if (!(p.components ?? []).some((c) => EXPOSING.has(c))) continue;
    assert.ok(
      (p.invariants ?? []).includes("dcl_authorization"),
      `'${p.id}' exposes data via [${p.components.filter((c) => EXPOSING.has(c))}] and must require dcl_authorization, has [${p.invariants}]`,
    );
  }
});

// GENERALISATION (operator, 2026-08-11: "as long as you do not overfit it to these two demos, it must
// generalise well"). The screen rules were chosen from what TALV and equalize-idoc happen to EMIT, which is a
// property of those two corpora rather than of ABAP. The catalogue carries five rules that evidence a classic
// UI surface: CLOUD-014 (classic dynpro), S4-004 (screen flow), S4-005 (Web Dynpro), CLOUD-028 (legacy-UI
// rollup, catalogued but with no detector yet — an analyser gap, logged) and ABAP-PERF-77 (CALL SCREEN inside
// a RAP handler, which is about the NEW code's quality and is deliberately not UI evidence about the legacy
// object). A Web Dynpro application is a UI surface by any reading, and neither demo contains one.
test("a Web Dynpro application is UI evidence too — not just the two rules these corpora emit", () => {
  const fact = {
    object_kind: "class", graph_kind: "object", finding_families: ["deprecation"],
    driving_rule_ids: ["talos-s4-005-web-dynpro"], disposition_hints: ["ui_rearch"],
    disposition: "re_architect", consumption: ["no_surface_evidence"], persistence: ["owns_customer_table"],
    modernization_target: "Fiori Elements App",
    member_summary: { members: 1, worst_grade: "D", max_complexity: 3, total_blast: 2 },
    dependency_count: 1,
  };
  const ids = matchTargetShapes(fact, loadPatternCorpus()).map((c) => c.id);
  assert.ok(ids.includes("rap_bo_fiori"), `Web Dynpro is an interactive UI: ${JSON.stringify(ids)}`);
  assert.ok(!ids.includes("rap_bo_headless"), "and it contradicts headless exactly as a dynpro does");
});
