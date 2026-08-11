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

/** Either UI-capable shape — the transactional BO, or the read-only list report (R2). */
const UI_SHAPES = ["rap_bo_fiori", "fiori_list_report"];
const someUiShape = (ids) => ids.some((i) => UI_SHAPES.includes(i));

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

test("adding a UI consumption fact surfaces a UI-capable shape (S14 TDD)", () => {
  const base = { persistence: ["reads_sap_table"] };
  const headless = matchTargetShapes(fact({ ...base, consumption: ["batch_report"] })).map((c) => c.id);
  const withUi = matchTargetShapes(fact({ ...base, consumption: ["batch_report", "ui_salv"] })).map((c) => c.id);
  assert.ok(!someUiShape(headless), "no UI shape without a UI surface");
  assert.ok(someUiShape(withUi), `a UI-consumption fact surfaces a UI shape: ${JSON.stringify(withUi)}`);
  // Which ONE it is depends on whether the object owns and mutates data (R2/R3a): this one only reads.
  assert.ok(withUi.includes("fiori_list_report"), "a reader gets the read-only list report");
});

// Updated for R1: `remote_bapi`/`remote_rfc` say what the object CALLS, and `rap_bo_odata` claims the object
// IS CALLED. The two are not the same fact, and reading one as the other is what put an OData binding on a
// report that merely calls a BAPI outbound (abap_fico ZCREATE_ASSET). An externally-callable kind is the
// evidence the pipeline can actually supply.
test("remote consumption without UI → rap_bo_odata for an externally-callable kind; IDoc → rap_bo_events", () => {
  const odata = matchTargetShapes(fact({ object_kind: "function", consumption: ["remote_bapi"] })).map((c) => c.id);
  assert.ok(odata.includes("rap_bo_odata"));
  assert.ok(!odata.includes("rap_bo_fiori"), "no Fiori without a UI surface");

  const notExposed = matchTargetShapes(fact({ object_kind: "class", consumption: ["remote_bapi"] })).map((c) => c.id);
  assert.ok(!notExposed.includes("rap_bo_odata"), "a class making an outbound BAPI call is not remotely consumed");

  const events = matchTargetShapes(fact({ consumption: ["remote_idoc"] })).map((c) => c.id);
  assert.ok(events.includes("rap_bo_events"));
});

test("a UI + remote node yields MULTIPLE candidates (ambiguity → the LLM will be escalated to select)", () => {
  // An externally-callable kind, so both the UI surface and the remote surface can legitimately propose.
  const out = matchTargetShapes(fact({ object_kind: "function", consumption: ["ui_salv", "remote_bapi"], persistence: ["reads_sap_table"] }));
  const ids = out.map((c) => c.id);
  assert.ok(someUiShape(ids) && ids.includes("rap_bo_odata"), `both surfaces propose their shape: ${JSON.stringify(ids)}`);
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
  assert.ok(someUiShape(ids), `a dynpro is a UI surface: ${JSON.stringify(ids)}`);
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
  assert.ok(someUiShape(ids), `and a UI shape must be on offer instead: ${JSON.stringify(ids)}`);
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

// R1 (independent ARCH_REVIEW, abap_fico 2026-08-11): "remote_bapi is invented: the BAPI is an OUTBOUND
// call; a REPORT has no inbound RFC surface, and an OData binding cannot serve it. The rationale inverts the
// dependency direction." Verified in source — zcreate_asset.prog.abap:77 is `CALL FUNCTION
// 'BAPI_FIXEDASSET_CREATE1'`, an outbound call this report makes.
//
// `remote_bapi` and `remote_rfc` describe what the object CALLS. `rap_bo_odata`'s premise is the opposite —
// that the object IS consumed remotely — and nothing in the pipeline emits an inbound-exposure marker (no
// RFC-enabled flag reaches the CPG, checked across the corpora). It was therefore firing on the inverse of
// its own claim, which is the same class of defect as reading IDOC_INBOUND_ASYNCHRONOUS as inbound.
//
// The honest available evidence of an external entry point is the object KIND: a function module is callable
// from outside its group by construction. A report is not. That is coarse, and it is the right kind of coarse
// — it never claims more than the pipeline can see.
test("R1 a REPORT that calls a BAPI is not a remotely-consumed object", () => {
  const fact = {
    object_kind: "report", graph_kind: "object", finding_families: ["clean-core"], driving_rule_ids: [],
    disposition_hints: ["style"], disposition: "re_architect",
    consumption: ["batch_report", "remote_bapi", "ui_salv"], persistence: ["reads_sap_table"],
    modernization_target: "RAP Business Object",
    member_summary: { members: 1, worst_grade: "D", max_complexity: 2, total_blast: 1 }, dependency_count: 1,
  };
  const ids = matchTargetShapes(fact, loadPatternCorpus()).map((c) => c.id);
  assert.ok(!ids.includes("rap_bo_odata"), `an outbound BAPI call is not inbound exposure: ${JSON.stringify(ids)}`);
});

test("R1 a FUNCTION MODULE with a remote surface is still an OData candidate", () => {
  const fact = {
    object_kind: "function", graph_kind: "object", finding_families: ["clean-core"], driving_rule_ids: [],
    disposition_hints: ["rfc_rebuild"], disposition: "re_architect",
    consumption: ["remote_rfc"], persistence: ["owns_customer_table"],
    modernization_target: "OData V4 Service",
    member_summary: { members: 1, worst_grade: "C", max_complexity: 2, total_blast: 1 }, dependency_count: 1,
  };
  const ids = matchTargetShapes(fact, loadPatternCorpus()).map((c) => c.id);
  assert.ok(ids.includes("rap_bo_odata"), `an FM is externally callable by construction: ${JSON.stringify(ids)}`);
});

// R2 (independent ARCH_REVIEW, 2026-08-11 — four of seven fails). `rap_bo_fiori` carries `draft_enabled` and
// `commit_entities_only` unconditionally, and those were being mandated for objects that never write:
// "the contract mandates bdef_managed + behavior_pool and invariants commit_entities_only + draft_enabled on
// all 9 objects — transactional save and draft for a read-only display".
//
// A read-only Fiori list report over a CDS view is not a degraded BO; it is its own extremely common ABAP
// Cloud target — CDS + service + annotations, no behaviour pool, no draft, nothing to commit. So this is a
// corpus addition rather than conditional code ("grow the corpus, not the code"), and R3a's write evidence is
// what finally makes the two separable.
test("R2 a read-only UI object gets a list report, not a draft-enabled managed BO", () => {
  const fact = {
    object_kind: "report", graph_kind: "object", finding_families: ["clean-core"],
    driving_rule_ids: ["talos-cloud-015-salv-table-factory"], disposition_hints: ["ui_rearch"],
    disposition: "re_architect", consumption: ["ui_salv", "batch_report"],
    persistence: ["reads_sap_table"], modernization_target: "Fiori Elements App",
    member_summary: { members: 1, worst_grade: "D", max_complexity: 3, total_blast: 2 }, dependency_count: 1,
  };
  const out = matchTargetShapes(fact, loadPatternCorpus());
  const ids = out.map((c) => c.id);
  assert.ok(ids.includes("fiori_list_report"), `a read-only grid is a list report: ${JSON.stringify(ids)}`);
  assert.ok(!ids.includes("rap_bo_fiori"), "and NOT a managed draft BO it cannot satisfy");

  const lr = out.find((c) => c.id === "fiori_list_report");
  assert.ok(!lr.invariants.includes("draft_enabled"), "draft on a read-only object is meaningless");
  assert.ok(!lr.invariants.includes("commit_entities_only"), "there is nothing to commit");
  assert.ok(lr.invariants.includes("dcl_authorization"), "but it publishes data, so it owes an auth contract");
  assert.ok(!lr.components.includes("bdef_managed"), "no behaviour definition without behaviour");
});

test("R2 a UI object that WRITES its own data still gets the transactional BO", () => {
  const fact = {
    object_kind: "class", graph_kind: "object", finding_families: ["clean-core"],
    driving_rule_ids: ["talos-cloud-014-classic-dynpro"], disposition_hints: ["ui_rearch"],
    disposition: "re_architect", consumption: ["ui_dynpro"],
    persistence: ["owns_customer_table"], modernization_target: "Fiori Elements App",
    member_summary: { members: 1, worst_grade: "D", max_complexity: 4, total_blast: 3 }, dependency_count: 2,
  };
  const ids = matchTargetShapes(fact, loadPatternCorpus()).map((c) => c.id);
  assert.ok(ids.includes("rap_bo_fiori"), `an object that owns and mutates data is a real BO: ${JSON.stringify(ids)}`);
});
