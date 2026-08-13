import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { consumptionFacts, CONSUMPTION_FACTS } from "../src/plan/consumption-facts.js";
import { persistenceFacts } from "../src/plan/persistence-facts.js";
import { factStream, factHash } from "../src/plan/arch-facts.js";

// B3.5 seam 1 (BUILD_PLAN S14/S11): the CPG consumption detector + the bounded-LLM JUDGMENT I/O
// boundary. `plan/consumption-facts.js` is the deterministic CPG detector (structural symbols →
// a CLOSED enum); `plan/arch-facts.js` `factStream` is the SINGLE P8 boundary — the ONLY thing the
// judge prompt is built from — and `factHash` its content-hash preimage (same method as plan_hash).

// ---------------------------------------------------------------------------
// consumptionFacts — the CPG consumption detector (S11)
// ---------------------------------------------------------------------------

test("CONSUMPTION_FACTS is the closed, sorted 11-value enum", () => {
  // `no_surface_evidence` joined the enum rather than sitting outside it. It reaches the judge's prompt
  // exactly like every other fact, so it must satisfy the same P8 injection-closure; an absence marker that
  // bypassed the closed vocabulary would be the one free-form string able to escape this module.
  assert.deepEqual(CONSUMPTION_FACTS, [
    "batch_report", "classic_api_surface", "no_surface_evidence", "remote_bapi", "remote_idoc",
    "remote_idoc_inbound", "remote_idoc_outbound", "remote_rfc", "ui_dynpro", "ui_frontend", "ui_salv",
  ]);
  assert.deepEqual([...CONSUMPTION_FACTS].sort(), CONSUMPTION_FACTS, "the enum stays sorted");
});

test("consumptionFacts: a cl_gui_alv_grid call → ui_salv (S14 TDD)", () => {
  const doc = { graph: { nodes: [], edges: [{ source: "ZX", target: "CL_GUI_ALV_GRID.SET_TABLE_FOR_FIRST_DISPLAY", kind: "call-method" }] } };
  assert.ok(consumptionFacts(doc).ZX.includes("ui_salv"));
});

test("consumptionFacts: SALV factory + REUSE_ALV also → ui_salv", () => {
  const doc = { graph: { nodes: [], edges: [
    { source: "ZA", target: "CL_SALV_TABLE.FACTORY", kind: "call-method" },
    { source: "ZB", target: "REUSE_ALV_GRID_DISPLAY", kind: "call-function" },
  ] } };
  assert.ok(consumptionFacts(doc).ZA.includes("ui_salv"));
  assert.ok(consumptionFacts(doc).ZB.includes("ui_salv"));
});

test("consumptionFacts: a CALL FUNCTION with a DESTINATION → remote_rfc (S14 TDD)", () => {
  const doc = { graph: { nodes: [], edges: [{ source: "ZY", target: "Z_POST_DOC", kind: "call-function", destination: "PRODCLNT100" }] } };
  assert.ok(consumptionFacts(doc).ZY.includes("remote_rfc"));
});

test("consumptionFacts: an RFC-conventional function name → remote_rfc (no destination field needed)", () => {
  const doc = { graph: { nodes: [], edges: [{ source: "ZR", target: "RFC_READ_TABLE", kind: "call-function" }] } };
  assert.ok(consumptionFacts(doc).ZR.includes("remote_rfc"));
});

test("consumptionFacts: BAPI_* → remote_bapi; IDoc FM → remote_idoc; report node → batch_report", () => {
  const doc = { graph: { nodes: [
    { id: "ZREP", object: "ZREP", kind: "report" },
  ], edges: [
    { source: "ZREP", target: "BAPI_SALESORDER_CREATEFROMDAT2", kind: "call-function" },
    { source: "ZREP", target: "MASTER_IDOC_DISTRIBUTE", kind: "call-function" },
  ] } };
  const c = consumptionFacts(doc).ZREP;
  assert.ok(c.includes("remote_bapi"), "BAPI_ → remote_bapi");
  assert.ok(c.includes("remote_idoc"), "IDoc FM → remote_idoc");
  assert.ok(c.includes("batch_report"), "report node → batch_report");
});

test("consumptionFacts: a dynpro/screen node → ui_dynpro; a frontend-services call → ui_frontend", () => {
  const doc = { graph: { nodes: [{ id: "ZUI", object: "ZUI", kind: "screen" }], edges: [
    { source: "ZUI.HANDLE", target: "CL_GUI_FRONTEND_SERVICES.GUI_UPLOAD", kind: "call-method" },
  ] } };
  const c = consumptionFacts(doc).ZUI;
  assert.ok(c.includes("ui_dynpro"), "screen node → ui_dynpro");
  assert.ok(c.includes("ui_frontend"), "CL_GUI_FRONTEND_SERVICES → ui_frontend");
});

test("consumptionFacts: attributes a construct to the OWNER object (id before the first dot)", () => {
  // a form/method sub-part `OWNER.SUB` calling a construct attributes to OWNER, not the sub-part
  const doc = { graph: { nodes: [], edges: [{ source: "ZOWNER.UPLOAD_FORM", target: "CL_GUI_FRONTEND_SERVICES.GUI_DOWNLOAD", kind: "call-method" }] } };
  const c = consumptionFacts(doc);
  assert.ok(c.ZOWNER && c.ZOWNER.includes("ui_frontend"));
  assert.equal(c["ZOWNER.UPLOAD_FORM"], undefined, "no key for the sub-part");
});

test("consumptionFacts: ONLY closed-enum values are ever emitted; unknown constructs drop; per-object sorted-distinct", () => {
  const doc = { graph: { nodes: [{ id: "ZQ", object: "ZQ", kind: "report" }], edges: [
    { source: "ZQ", target: "POPUP_TO_INFORM", kind: "call-function" },      // not a consumption construct → drop
    { source: "ZQ", target: "CL_GUI_ALV_GRID.REFRESH", kind: "call-method" },
    { source: "ZQ", target: "CL_GUI_ALV_GRID.SET_TABLE", kind: "call-method" }, // duplicate signal → one value
    { source: "ZQ", target: "SOME_UTIL", kind: "call-function" },             // unknown → drop
  ] } };
  const c = consumptionFacts(doc).ZQ;
  assert.deepEqual(c, [...c].sort(), "sorted");
  assert.equal(new Set(c).size, c.length, "distinct");
  for (const f of c) assert.ok(CONSUMPTION_FACTS.includes(f), `${f} is a closed-enum value`);
  assert.deepEqual(c, ["batch_report", "ui_salv"], "only the classified constructs, deduped");
});

test("consumptionFacts is deterministic and injection-closed on the real abap_fico CPG", () => {
  const doc = JSON.parse(readFileSync("moderniser/test/fixtures/analyser-findings.json", "utf8"));
  const a = consumptionFacts(doc);
  const b = consumptionFacts(doc);
  assert.equal(JSON.stringify(a), JSON.stringify(b), "deterministic");
  for (const facts of Object.values(a)) for (const f of facts) assert.ok(CONSUMPTION_FACTS.includes(f), `${f} closed`);
  // abap_fico is a batch report doing a frontend file upload — never an ALV/dynpro/remote surface
  assert.ok((a.ZFICO_BTC_CSV_GL ?? []).includes("batch_report"), "GL is a batch report");
  assert.ok((a.ZFICO_BTC_CSV_GL ?? []).includes("ui_frontend"), "GL does a GUI_UPLOAD (frontend file)");
  assert.ok(!(a.ZFICO_BTC_CSV_GL ?? []).includes("ui_salv"), "no ALV in abap_fico");
});

// ---------------------------------------------------------------------------
// factStream + factHash — the P8 JUDGMENT boundary (S14)
// ---------------------------------------------------------------------------

const node = (o = {}) => ({
  id: "sig-abc", object: "ZFOO", kind: "object", object_kind: "class",
  members: ["ZFOO"], finding_families: ["clean-core"], driving_rule_ids: ["talos-cloud-006-write"],
  disposition_hints: ["ui_rearch"], disposition: "re_architect", disposition_confidence: 0.85,
  member_meta: { ZFOO: { grade: "D", complexity: 12, blast: 3 } },
  modernization_target: "RAP Business Object", dependencies: ["sig-1", "sig-2"], ...o,
});

test("factStream emits ONLY declared closed fields — never the object name or any finding message", () => {
  const s = factStream(node(), { ZFOO: ["ui_salv"] });
  const json = JSON.stringify(s);
  assert.ok(!json.includes("ZFOO"), "the raw object NAME never enters the stream (P8)");
  assert.ok(!json.includes("sig-abc"), "the node id (a customer-derived sig) does not enter the stream");
  const allowed = new Set([
    "object_kind", "graph_kind", "finding_families", "driving_rule_ids", "disposition_hints",
    "disposition", "consumption", "persistence", "modernization_target", "member_summary", "dependency_count",
  ]);
  for (const k of Object.keys(s)) assert.ok(allowed.has(k), `field ${k} is declared`);
});

test("factStream + factHash are deterministic (byte-identical over two runs)", () => {
  const n = node(), cache = { ZFOO: ["ui_salv", "batch_report"] };
  assert.equal(JSON.stringify(factStream(n, cache)), JSON.stringify(factStream(n, cache)));
  assert.equal(factHash(n, cache), factHash(n, cache));
  assert.match(factHash(n, cache), /^[0-9a-f]{64}$/, "sha256 hex");
});

test("adding a dynpro consumption fact flips ui_dynpro AND factHash (S14 TDD)", () => {
  const n = node();
  const before = factHash(n, { ZFOO: ["ui_salv"] });
  const after = factHash(n, { ZFOO: ["ui_salv", "ui_dynpro"] });
  assert.notEqual(before, after, "a structural consumption change moves the fact hash");
  assert.ok(factStream(n, { ZFOO: ["ui_salv", "ui_dynpro"] }).consumption.includes("ui_dynpro"));
});

test("a finding-only change the stream never reads does NOT change factHash (S14 TDD)", () => {
  const cache = { ZFOO: ["ui_salv"] };
  const base = factHash(node(), cache);
  // fields the stream deliberately excludes: object name, id, transport, an arbitrary extra field —
  // none may perturb the hash (the preimage is closed over the declared structural fields only)
  const perturbed = factHash(node({ object: "ZBAR", id: "sig-zzz", transport_id: "K900123", raw_message: "arbitrary-extra-text" }), cache);
  assert.equal(base, perturbed, "the fact hash is closed over the declared structural fields only");
});

test("factStream is injection-closed: an object name / un-allowlisted target cannot reach the judge", () => {
  const canaryName = "ZLEAKCANARY_OBJECT_NAME";
  const canaryTarget = "leakcanary-untrusted-target-text";
  const s = factStream(node({ object: canaryName, modernization_target: canaryTarget }), {});
  const json = JSON.stringify(s);
  assert.ok(!json.includes(canaryName), "no object-name leak into the stream");
  assert.ok(!json.includes(canaryTarget), "an un-allowlisted target string is dropped, not passed through");
  assert.equal(s.modernization_target, "unknown", "a target outside the analyser vocabulary → 'unknown' (fail-closed)");
});

test("modernization_target is allowlist-validated against the analyser vocabulary; null stays null", () => {
  assert.equal(factStream(node({ modernization_target: "RAP Business Object" }), {}).modernization_target, "RAP Business Object");
  assert.equal(factStream(node({ modernization_target: "OData V4 Service" }), {}).modernization_target, "OData V4 Service");
  assert.equal(factStream(node({ modernization_target: null }), {}).modernization_target, null);
  assert.equal(factStream(node({ modernization_target: "Custom Nonsense" }), {}).modernization_target, "unknown");
});

test("member_meta is REDUCED to a deterministic summary (count / worst_grade / max_complexity / total_blast)", () => {
  const n = node({ members: ["ZA", "ZB"], member_meta: {
    ZA: { grade: "B", complexity: 4, blast: 2 }, ZB: { grade: "D", complexity: 9, blast: 5 },
  } });
  const { member_summary: m } = factStream(n, {});
  assert.deepEqual(m, { members: 2, worst_grade: "D", max_complexity: 9, total_blast: 7 });
});

test("member_summary worst_grade is 'unknown' only when NO member is graded", () => {
  const n = node({ members: ["ZA"], member_meta: { ZA: { grade: "unknown", complexity: 1, blast: 0 } } });
  assert.equal(factStream(n, {}).member_summary.worst_grade, "unknown");
});

test("consumption is the sorted UNION over node.members only (non-members excluded)", () => {
  const n = node({ members: ["ZA", "ZB"] });
  const s = factStream(n, { ZA: ["ui_salv"], ZB: ["batch_report", "ui_salv"], ZC: ["remote_bapi"] });
  assert.deepEqual(s.consumption, ["batch_report", "ui_salv"], "union over members ZA,ZB; ZC is not a member so remote_bapi is excluded");
});

test("consumption lookup is case-insensitive on the member id (graph vs plan id casing)", () => {
  const n = node({ members: ["zfoo"] }); // member id lower-case; cache key upper-case
  assert.deepEqual(factStream(n, { ZFOO: ["ui_frontend"] }).consumption, ["ui_frontend"]);
});

test("dependency_count is the cardinality of node.dependencies (opaque sigs never enter the stream)", () => {
  assert.equal(factStream(node({ dependencies: ["a", "b", "c"] }), {}).dependency_count, 3);
  assert.equal(factStream(node({ dependencies: [] }), {}).dependency_count, 0);
  const json = JSON.stringify(factStream(node({ dependencies: ["sig-secret"] }), {}));
  assert.ok(!json.includes("sig-secret"), "the raw dependency sigs are reduced to a count");
});

// M6 (Rule-11 review): the case-fold index is memoised per map INSTANCE — factStream runs once per plan
// node with the SAME consumption map, so rebuilding it inside made the pass O(nodes × objects), quadratic
// at 100K+ LOC. The cache must not leak between maps, and repeated calls must stay stable.
test("M6 the memoised case-fold index is per-map and never bleeds between consumption maps", () => {
  const n = node({ object: "ZFOO", members: ["ZFOO"] });
  assert.deepEqual(factStream(n, { zfoo: ["ui_salv"] }).consumption, ["ui_salv"], "lower-cased key resolves");
  assert.deepEqual(factStream(n, { ZFOO: ["batch_report"] }).consumption, ["batch_report"], "a DIFFERENT map is indexed independently");
  const shared = { ZfOo: ["remote_rfc"] };
  assert.deepEqual(factStream(n, shared).consumption, factStream(n, shared).consumption, "repeat calls on one map are stable");
  assert.deepEqual(factStream(n, shared).consumption, ["remote_rfc"], "mixed-case key still resolves via the cached index");
});

// GRADE (surfaced while investigating the frontier ordering): the fact stream's grade scale must be the
// ANALYSER's real vocabulary — A–D + unknown, as analyser/src/compare.js and the findings docs emit it.
// It previously declared A–F, inventing E/F grades the system never produces: unreachable entries, and a
// second conflicting scale in a codebase whose scheduler (sched/risk.js) already ranks A–D.
test("GRADE worst_grade ranks the analyser's real A–D vocabulary, and `unknown` never reads as the worst", () => {
  const meta = (grades) => Object.fromEntries(grades.map((g, i) => [`M${i}`, { grade: g, complexity: 1, blast: 0 }]));
  const worst = (grades) => factStream(node({ member_meta: meta(grades) }), {}).member_summary.worst_grade;
  assert.equal(worst(["A", "D", "B"]), "D", "D is the worst real grade");
  assert.equal(worst(["A", "B"]), "B");
  assert.equal(worst(["unknown", "C"]), "C", "a graded member outranks an ungraded one");
  assert.equal(worst(["unknown"]), "unknown", "…but an all-ungraded node reports unknown, not a fabricated grade");
  assert.equal(worst(["D", "unknown"]), "D", "absence of a grade is never evidence of a worse one");
});

// RC-1: persistence rides the fact stream as its OWN field, not as more entries in `consumption`. The judge
// and the matcher must be able to ask "what does this object own" separately from "what surface does it
// present" — 13 of 15 recommendations were failed by the independent reviewer because only the second
// question could be asked, so a display utility and a business object were handed the same managed RAP BO.
test("the fact stream carries persistence as a separate dimension", () => {
  const doc = {
    graph: {
      nodes: [{ id: "ZCL_X", kind: "class", object: "ZCL_X" }],
      edges: [
        { source: "ZCL_X", target: "CL_SALV_TABLE", kind: "call-method" },
        { source: "ZCL_X", target: "ZTAB_MINE", kind: "uses-table", access: "write" },
      ],
    },
  };
  const fact = factStream({ id: "s", object: "ZCL_X", members: ["ZCL_X"] }, consumptionFacts(doc), persistenceFacts(doc));
  assert.deepEqual(fact.consumption, ["ui_salv"], "surface stays surface");
  assert.deepEqual(fact.persistence, ["owns_customer_table"], "ownership is its own answer");
});

test("an object that owns nothing says so in the persistence field, whatever its surface", () => {
  const doc = { graph: { nodes: [{ id: "ZCL_Y", kind: "class", object: "ZCL_Y" }], edges: [{ source: "ZCL_Y", target: "CL_SALV_TABLE", kind: "call-method" }] } };
  const fact = factStream({ id: "s", object: "ZCL_Y", members: ["ZCL_Y"] }, consumptionFacts(doc), persistenceFacts(doc));
  assert.deepEqual(fact.persistence, ["no_persistence_evidence"]);
});

test("persistence changes the fact hash — new evidence is a new question", () => {
  const node = { id: "s", object: "ZCL_X", members: ["ZCL_X"] };
  const owns = { ZCL_X: ["owns_customer_table"] };
  const none = { ZCL_X: ["no_persistence_evidence"] };
  assert.notEqual(factHash(node, {}, owns), factHash(node, {}, none), "two different objects must not share a cached verdict");
});

// F-9.4 — a super-node is a condensed SCC that ships as ONE unit, and its facts are the union over its
// members. Unioned raw, a silent member's absence marker lands in the same set as a sibling's positive
// evidence, so the node simultaneously claims "owns a customer table" and "has no persistence evidence".
// The `none:` guards in the patterns corpus read that absence and veto the shape — a quiet member
// out-votes an evidenced one. Absence is the conclusive answer for ONE object; across a group it is
// merely the members that had nothing to say.

test("F-9.4: a silent member does not veto a sibling's evidence in the union", () => {
  const n = node({ object: "ZA", members: ["ZA", "ZB"] });
  const consumption = { ZA: ["ui_salv"], ZB: ["no_surface_evidence"] };
  const persistence = { ZA: ["no_persistence_evidence"], ZB: ["owns_customer_table"] };
  const f = factStream(n, consumption, persistence);
  assert.deepEqual(f.consumption, ["ui_salv"], "ZB had nothing to say; that is not evidence ZA has no surface");
  assert.deepEqual(f.persistence, ["owns_customer_table"], "nor that the group owns nothing");
});

test("F-9.4: a group where EVERY member is silent still says so — absence survives when it is the whole truth", () => {
  const n = node({ object: "ZA", members: ["ZA", "ZB"] });
  const f = factStream(n, { ZA: ["no_surface_evidence"], ZB: ["no_surface_evidence"] },
    { ZA: ["no_persistence_evidence"], ZB: ["no_persistence_evidence"] });
  assert.deepEqual(f.consumption, ["no_surface_evidence"]);
  assert.deepEqual(f.persistence, ["no_persistence_evidence"]);
});
