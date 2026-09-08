import { test } from "node:test";
import assert from "node:assert/strict";
import { CONSUMPTION_FACTS } from "../src/plan/consumption-facts.js";
import { PERSISTENCE_FACTS } from "../src/plan/persistence-facts.js";
import { matchTargetShapes, loadPatternCorpus } from "../src/plan/patterns/match.js";

// THE DECISION-MUTATION CENSUS.
//
// One property, stated once: EVERY DECISION MUST BE TRACEABLE TO AN INPUT THAT COULD HAVE CHANGED IT.
// It has two failure directions, and this repository has now shipped both:
//
//   INERT INPUT      a declared fact that changes no decision. It reaches the judge in the fact stream and
//                    is therefore "referenced", but no possible value of it moves any outcome — so it can
//                    never contradict a claim. `remote_idoc_inbound` (three inbound ALE handlers prescribed
//                    an event emitter) and `ui_frontend` (a file-exchange program certified as having no
//                    surface at all) were both live wrong answers hiding behind exactly this.
//
//   UNGROUNDED       a verdict that no input can move. `ownsName` once returned "customer" for any
//   VERDICT          registered /NS/ namespace regardless of evidence — a claim manufactured from silence
//                    rather than derived. Grounding it in SAP's own registry is what fixed it, and this
//                    half of the census is what stops it silently un-grounding again.
//
// Why MUTATION and not a reference scan, measured rather than assumed:
//   - every fact reaches the judge via factStream, so "is it referenced?" is true of everything and
//     asserts nothing;
//   - a scan for "referenced in code" reports all 16 corpus COMPONENTS as dead, because their consumer is
//     an LLM generator reading the frozen contract, not code. Sixteen false positives on day one is how a
//     guard gets weakened and then deleted.
// Mutation asks the question we actually care about and is immune to both.
//
// CONTEXTS ARE DERIVED, NOT IMAGINED. A fact that only matters in a context nobody enumerated would read as
// inert, so the base contexts below are the fact-shapes the corpora actually produce (measured over
// abap_fico / equalize-idoc / talv / zapcommander), not shapes invented to make the test pass.

const corpus = loadPatternCorpus();

const base = (o = {}) => ({
  object_kind: "class", graph_kind: "object", finding_families: [], driving_rule_ids: [],
  disposition_hints: [], disposition: "re_architect", consumption: [], persistence: [],
  modernization_target: null, dependency_count: 0,
  member_summary: { members: 1, worst_grade: "D", max_complexity: 1, total_blast: 0 }, ...o,
});

/** Every outcome the deterministic matcher produces — id, rank, score AND the prescribed artifacts. */
const outcome = (f) => JSON.stringify(matchTargetShapes(f, corpus).map((c) => [c.id, c.score, (c.components ?? []).join("|"), (c.invariants ?? []).join("|")]));

// Observed on the corpora: object kinds that occur, and the persistence/consumption backdrops a fact
// realistically lands against. A fact is inert only if it moves NOTHING in EVERY one of these.
const CONTEXTS = [
  {}, { object_kind: "function" }, { object_kind: "program" }, { object_kind: "report" },
  { persistence: ["owns_customer_table"] }, { persistence: ["reads_sap_table"] },
  { persistence: ["writes_via_sap_api"] }, { persistence: ["no_persistence_evidence"] },
  { consumption: ["ui_salv"] }, { consumption: ["ui_dynpro"] }, { consumption: ["remote_bapi"] },
  { consumption: ["remote_idoc"] }, { consumption: ["no_surface_evidence"] },
  { disposition: "rebuild" }, { disposition: "refactor" },
];

/**
 * Facts that move no outcome BY DESIGN. Typed, never free text — and every type is checked below, so an
 * entry is an argument the test can audit rather than a rubber stamp. Removing a fact's entry when it
 * finally becomes load-bearing is enforced too: a stale acknowledgement is how these tables rot into noise.
 */
const ACKNOWLEDGED = {
  // Pinned by a passing test ("a WRITE-list batch report stays headless — a list is not a screen"): every
  // classic report/program carries it (consumption-facts NODE_KIND_FACT), and a batch surface deliberately
  // does not veto headless. It rides the fact stream so the judge can weigh it; no shape gates on it.
  batch_report: { type: "judge_only" },
  // ui_frontend is CL_GUI_FRONTEND_SERVICES / GUI_UPLOAD / WS_DOWNLOAD — presentation-server FILE I/O in a
  // batch job, not a rendered screen. The name invites the opposite reading, and acting on that reading is
  // how this entry was earned: gating headless on it stripped the shape from ZFICO_BTC_CSV_GL (real,
  // ["batch_report","ui_frontend"]) and from the passing test that pins "a WRITE-list batch report stays
  // headless — a list is not a screen". The corpus had already decided this deliberately. Its Clean-Core
  // consequence is carried where it belongs — the talos-legacy-ui-rollup finding and the `ui_rearch` hint —
  // not by reclassifying a batch job as having a UI.
  ui_frontend: { type: "judge_only" },
  // Required IMPLICITLY and provably: `fiori_list_report` vetoes persistence:no_persistence_evidence, and
  // every non-veto persistence fact is a read — so read evidence is already mandatory for the read-only
  // shape. Naming reads positively would be a second way to say the same thing. The `redundant_via` type is
  // VERIFIED below, not trusted: the named signal must itself be live.
  reads_sap_table: { type: "redundant_via", signal: "persistence:no_persistence_evidence" },
  reads_customer_table: { type: "redundant_via", signal: "persistence:no_persistence_evidence" },
};

function inertFacts(vocab, key) {
  return [...vocab].filter((fact) => CONTEXTS.every((ctx) => {
    const without = base(ctx);
    const withIt = base({ ...ctx, [key]: [...(ctx[key] ?? []), fact] });
    return outcome(without) === outcome(withIt);
  }));
}

test("census: every declared fact can change an outcome, or is acknowledged with a checkable reason", () => {
  const inert = [...inertFacts(CONSUMPTION_FACTS, "consumption"), ...inertFacts(PERSISTENCE_FACTS, "persistence")];
  const unacknowledged = inert.filter((f) => !ACKNOWLEDGED[f]);
  assert.deepEqual(
    unacknowledged, [],
    `these facts are produced and enum-closed but no value of them moves any outcome, so they can never `
    + `contradict a claim. Either gate a shape on them, or add a typed entry to ACKNOWLEDGED saying why not: ${unacknowledged}`,
  );
});

test("census: no acknowledgement is stale — a fact that became load-bearing must lose its entry", () => {
  const inert = new Set([...inertFacts(CONSUMPTION_FACTS, "consumption"), ...inertFacts(PERSISTENCE_FACTS, "persistence")]);
  const stale = Object.keys(ACKNOWLEDGED).filter((f) => !inert.has(f));
  assert.deepEqual(stale, [], `these facts now move an outcome — delete their ACKNOWLEDGED entries: ${stale}`);
});

test("census: a `redundant_via` acknowledgement names a signal that is itself live", () => {
  // The failure this closes: acknowledging fact A as redundant via signal B, where B is itself dead. Two
  // inert facts would then vouch for each other and the census would pass while nothing was checked.
  const corpusText = JSON.stringify(corpus);
  for (const [fact, ack] of Object.entries(ACKNOWLEDGED)) {
    if (ack.type !== "redundant_via") continue;
    assert.ok(ack.signal, `${fact}: redundant_via must name the signal that carries the duty`);
    assert.ok(corpusText.includes(ack.signal), `${fact}: its stand-in '${ack.signal}' is named by no shape — it cannot carry the duty`);
  }
});

test("census: every acknowledgement carries a known type — free text is not an argument", () => {
  const KNOWN = new Set(["judge_only", "redundant_via", "owed"]);
  for (const [fact, ack] of Object.entries(ACKNOWLEDGED)) {
    assert.ok(KNOWN.has(ack?.type), `${fact}: '${ack?.type}' is not one of [${[...KNOWN]}]`);
    if (ack.type === "owed") assert.ok(ack.arc, `${fact}: an 'owed' acknowledgement must name the arc that owes it`);
  }
});

// ---- the other direction: a verdict no input can move ----

test("census: namespace ownership is DERIVED from evidence, never asserted from silence", async () => {
  // The ungrounded-verdict half, driven through the PUBLIC seam — no test-only export, no injected config.
  // Before F-9.2 `ownsName` treated ANY registered /NS/ namespace as customer-owned, so the ownership
  // verdict was invariant: no input could move it, which is the definition of a claim manufactured from
  // silence. Mutating the INPUT is what proves it is now derived — three names that the configuration
  // distinguishes must produce three verdicts, and this assertion would have failed outright before F-9.2,
  // when all three returned "owned".
  const { persistenceFacts } = await import("../src/plan/persistence-facts.js");
  const docFor = (table) => ({
    graph: {
      nodes: [{ id: "ZCL_X", kind: "object" }],
      edges: [{ source: "ZCL_X.RUN", target: table, kind: "uses-table", access: "write" }],
    },
    findings: [],
  });
  const owns = (table) => (persistenceFacts(docFor(table))["ZCL_X"] ?? []).includes("owns_customer_table");

  assert.equal(owns("ZORDERS"), true, "a Z prefix IS the evidence — the name itself says customer");
  assert.equal(owns("/SCWM/ORDER"), false, "a namespace SAP's own registry knows is SAP's, whatever the object looks like");
  assert.equal(owns("/ACME/ORDER"), false, "an unknown registered namespace follows the declared fail-safe default, not an assumption");

  // And the default is declared rather than implied — omission is the silence this guards against.
  const owners = (await import("../src/plan/patterns/namespace-owners.json", { with: { type: "json" } })).default;
  assert.ok(["sap", "customer"].includes(owners.unresolved_default), "the unresolved default must be stated explicitly");
});
