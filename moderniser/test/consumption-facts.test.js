import { test } from "node:test";
import assert from "node:assert/strict";
import { consumptionFacts, consumptionEvidence, NO_EVIDENCE } from "../src/plan/consumption-facts.js";

// F-1 (ARCH_REVIEW independent reviewer, equalize-idoc demo 2026-08-09; CONFIRMED against source and the
// real corpus). Two independent defects made the moderniser fabricate a consumption surface, and the
// consequence was not a wrong label — it was a manufactured architecture:
//
//   `rap_bo_headless` EXCLUDES on `consumption:remote_idoc`. A fabricated remote_idoc therefore deletes the
//   only lighter candidate, leaving `rap_bo_events` as the SOLE candidate — which then presents as a
//   "single candidate, nothing to judge" row. 7 of 9 equalize-idoc shapes were manufactured this way.
//
// Defect 1 — STRUCTURAL. classifyConstruct ran on EVERY graph edge with no kind filter, so a function
// group's own INCLUDEs and an object's calls to its own private methods counted as things it CONSUMES. On
// the real corpus 107 of 150 edges matched remote_idoc: 73 `call-method`, 12 `includes`, 7 `inherits`, 4
// `uses-table` — and only 11 `call-function` edges were genuine ALE calls. NOTE: `inherits` is deliberately
// NOT excluded — see the SAP-framework test below, where excluding it cost real signal.
//
// Defect 2 — NAMING. `remote_idoc` matched /(^|_)IDOC(_|$)/ against the target NAME, so any object called
// Z*_IDOC_* matched itself. The corpus is an IDoc framework: every object is named that way, so the
// detector triggered on the customer's naming convention rather than on SAP's ALE API.

const graph = (edges, nodes = []) => ({ graph: { nodes, edges } });

test("a function group's own INCLUDEs are structure, not something it consumes", () => {
  const out = consumptionFacts(graph([
    { source: "ZBC_FG_IDOC_FW", target: "LZBC_FG_IDOC_FWTOP", kind: "includes" },
    { source: "ZBC_FG_IDOC_FW", target: "LZBC_FG_IDOC_FWUXX", kind: "includes" },
  ]));
  assert.deepEqual(out.ZBC_FG_IDOC_FW ?? [], [], `an INCLUDE is not a consumption surface: ${JSON.stringify(out)}`);
});

test("a CUSTOMER superclass is internal decomposition, not a consumed surface", () => {
  const out = consumptionFacts(graph([
    { source: "ZCL_IDOC_INPUT", target: "ZCL_IDOC_BASE", kind: "inherits" },
  ]));
  assert.deepEqual(out.ZCL_IDOC_INPUT, [NO_EVIDENCE], `a Z-named superclass is not a surface: ${JSON.stringify(out)}`);
});

test("an object calling its OWN method consumes nothing external", () => {
  const out = consumptionFacts(graph([
    { source: "ZCL_IDOC_DB_BUFFER.LOOKUP_KNA1", target: "ZCL_IDOC_DB_BUFFER.RETURN_FIELDVALUE_DYNAMICALLY", kind: "call-method" },
  ]));
  assert.deepEqual(out.ZCL_IDOC_DB_BUFFER ?? [], [], `an intra-object call is not consumption: ${JSON.stringify(out)}`);
});

test("the real SAP ALE APIs are still detected — the fix must not blind the detector", () => {
  // Every one of these is a genuine call-function edge in the equalize-idoc corpus.
  for (const target of [
    "IDOC_INPUT_MBGMCR", "IDOC_INPUT_MBGMCA", "IDOC_INPUT_SALESORDER_CREATEFR",
    "IDOC_INBOUND_ASYNCHRONOUS", "IDOC_OUTPUT_INVOIC", "IDOC_ERROR_WORKFLOW_START",
    "EDI_DOCUMENT_OPEN_FOR_PROCESS", "EDI_DOCUMENT_CLOSE_PROCESS", "EDI_DOCUMENT_STATUS_SET",
    "EDI_SEGMENTS_GET_ALL",
  ]) {
    const out = consumptionFacts(graph([{ source: "ZCL_X", target, kind: "call-function" }]));
    assert.deepEqual(out.ZCL_X, ["remote_idoc"], `${target} is a real ALE API and must still register`);
  }
});

test("a customer object whose NAME contains IDOC is not an ALE call", () => {
  // The corpus is called Z*_IDOC_*, so a name-derived rule triggers on the naming convention itself.
  for (const target of ["ZBC_FG_IDOC_FW", "ZCL_IDOC_BASE", "ZBC_IDOC_CFG", "LZBC_IDOC_CFGF00"]) {
    const out = consumptionFacts(graph([{ source: "ZCL_X", target, kind: "call-function" }]));
    assert.deepEqual(out.ZCL_X, [NO_EVIDENCE], `${target} is a customer object, not SAP's ALE API`);
  }
});

test("the SM30 view processor is not an ALE call, though its name carries the view's", () => {
  // VIEWPROC_ZBC_V_IDOC_OPT is a genuine call-function edge — so an edge-kind filter alone does not save
  // us. It is SAP's generated view-maintenance FM for a customer view that happens to be named *_IDOC_*.
  const out = consumptionFacts(graph([{ source: "ZBC_IDOC_CFG", target: "VIEWPROC_ZBC_V_IDOC_OPT", kind: "call-function" }]));
  assert.deepEqual(out.ZBC_IDOC_CFG, [NO_EVIDENCE], "SM30 maintenance is not ALE consumption");
});

test("the other consumption surfaces still register from real call edges", () => {
  const cases = [
    ["CL_SALV_TABLE", "call-method", "ui_salv"],
    ["CL_GUI_FRONTEND_SERVICES", "call-method", "ui_frontend"],
    ["BAPI_SALESORDER_CREATEFROMDAT2", "call-function", "remote_bapi"],
  ];
  for (const [target, kind, expected] of cases) {
    const out = consumptionFacts(graph([{ source: "ZCL_X", target, kind }]));
    assert.deepEqual(out.ZCL_X, [expected], `${target} must still classify as ${expected}`);
  }
});

test("an explicit CALL FUNCTION DESTINATION is still a remote RFC whatever the callee is named", () => {
  const out = consumptionFacts(graph([
    { source: "ZCL_X", target: "Z_SOME_LOCAL_LOOKING_FM", kind: "call-function", destination: "PRD_CLNT100" },
  ]));
  assert.deepEqual(out.ZCL_X, ["remote_rfc"], "a DESTINATION is explicit remote consumption");
});

test("a node kind that IS a consumption surface still registers without any edge", () => {
  const out = consumptionFacts(graph([], [{ id: "ZREPORT_X", kind: "report" }]));
  assert.deepEqual(out.ZREPORT_X, ["batch_report"]);
});

// The three tests above are corpus-realistic regression pins, but with `remote_idoc` now anchored they
// would pass on the anchoring alone — so they do not exercise the structural guard. These two isolate it:
// the target genuinely matches a consumption pattern, and only the edge's nature makes it not consumption.

test("inheriting from an SAP FRAMEWORK class adopts its surface — a subclass of an ALV grid IS classic UI", () => {
  // Corrected after the first version of this fix over-reached. Excluding `inherits` wholesale suppressed a
  // real signal: the TALV corpus contains `ZCL_GUI_ALV_GRID --inherits--> CL_GUI_ALV_GRID`, a customer class
  // extending SAP's ALV control. That object has no ABAP Cloud form and must re-architect to Fiori; calling
  // it headless would be wrong. Dropping the edge cost the corpus its only rap_bo_fiori node.
  //
  // The exclusion is unnecessary for name collisions anyway, because the patterns are anchored to SAP
  // constructs — a Z-named superclass cannot match one. So `inherits` stays IN, and only a function group's
  // own INCLUDEs (its literal body, whose own edges are attributed separately) stay out.
  for (const kind of ["inherits", "call-method"]) {
    const out = consumptionFacts(graph([{ source: "ZCL_MY_GRID", target: "CL_GUI_ALV_GRID", kind }]));
    assert.deepEqual(out.ZCL_MY_GRID, ["ui_salv"], `extending or calling an SAP ALV control is a UI surface (${kind})`);
  }
});

test("a method of my own class is not an external surface, whatever it is named", () => {
  // `(^|\.)CL_SALV` matches after a dot, so a privately-named helper `ZCL_X.CL_SALV_WRAP` matches ui_salv
  // on name alone. It is this object's own method; only the self-edge check tells them apart.
  const out = consumptionFacts(graph([
    { source: "ZCL_X.RUN", target: "ZCL_X.CL_SALV_WRAP", kind: "call-method" },
  ]));
  assert.deepEqual(out.ZCL_X ?? [], [], `an own-method call is not consumption: ${JSON.stringify(out)}`);

  // The same-named method on ANOTHER object is a real external call and must still register.
  const other = consumptionFacts(graph([
    { source: "ZCL_X.RUN", target: "ZCL_OTHER.CL_SALV_WRAP", kind: "call-method" },
  ]));
  assert.deepEqual(other.ZCL_X, ["ui_salv"]);
});

// ---------------------------------------------------------------------------------------------------
// REACHABILITY (arch-review, TALV corpus 2026-08-10, CONFIRMED by probe). Detection was direct-edge only,
// so a corpus that wraps its UI was invisible: TALV's graph holds 493 ALV/SALV references, and exactly
// THREE objects touch an SAP GUI class directly. The other fourteen reach the grid through the corpus's own
// `ZCL_GUI_ALV_GRID` / `ZCL_TALV_PARENT` wrappers, and the anchored pattern cannot match `ZCL_…` — so
// `ui_*` measured "objects one hop from SAP", a property of the DETECTOR, not of the corpus.
//
// It mattered because `rap_bo_headless` fires on the ABSENCE of ui_*/remote_* (target-patterns.json), so
// every blind spot silently became a confident shape: 23 of 24 TALV nodes came out headless for an
// interactive table-maintenance framework, and 20 of them were never judged at all.
//
// Facts now propagate over intra-corpus call edges. Provenance is kept — `direct` (I touch SAP myself) is
// not the same claim as `reached` (I use something that does), and the two lead to different dispositions:
// the wrapper retires, its callers re-architect.

test("a caller that reaches SAP UI through the corpus's own wrapper is not blind to it", () => {
  // The TALV shape exactly: ZAESOP_TALV_DEMO_01 -> ZCL_GUI_ALV_GRID -> CL_GUI_ALV_GRID.
  const out = consumptionFacts(graph([
    { source: "ZCL_GUI_ALV_GRID", target: "CL_GUI_ALV_GRID", kind: "inherits" },
    { source: "ZAESOP_TALV_DEMO_01.MAIN", target: "ZCL_GUI_ALV_GRID.FREE", kind: "call-method" },
  ]));
  assert.ok(out.ZCL_GUI_ALV_GRID.includes("ui_salv"), "the wrapper touches SAP directly");
  assert.ok(
    out.ZAESOP_TALV_DEMO_01?.includes("ui_salv"),
    `its caller reaches the same grid: ${JSON.stringify(out)}`,
  );
});

test("provenance is kept — reaching a surface is a different claim from being one", () => {
  const ev = consumptionEvidence(graph([
    { source: "ZCL_GUI_ALV_GRID", target: "CL_GUI_ALV_GRID", kind: "inherits" },
    { source: "ZAESOP_TALV_DEMO_01.MAIN", target: "ZCL_GUI_ALV_GRID.FREE", kind: "call-method" },
  ]));
  assert.deepEqual(ev.ZCL_GUI_ALV_GRID.direct, ["ui_salv"], "the wrapper's fact is first-hand");
  assert.deepEqual(ev.ZCL_GUI_ALV_GRID.reached, [], "and it reaches nothing further");
  assert.deepEqual(ev.ZAESOP_TALV_DEMO_01.direct, [], "the caller touches no SAP class itself");
  assert.deepEqual(
    ev.ZAESOP_TALV_DEMO_01.reached.map((r) => [r.fact, r.via]),
    [["ui_salv", "ZCL_GUI_ALV_GRID"]],
    "it reaches ui_salv, and the wrapper it went through is named",
  );
});

test("propagation is cycle-safe — mutually recursive wrappers terminate", () => {
  const out = consumptionFacts(graph([
    { source: "ZCL_A", target: "CL_SALV_TABLE", kind: "call-method" },
    { source: "ZCL_A.X", target: "ZCL_B.Y", kind: "call-method" },
    { source: "ZCL_B.Y", target: "ZCL_A.X", kind: "call-method" },
  ]));
  assert.ok(out.ZCL_B.includes("ui_salv"), "B reaches the grid through A");
  assert.ok(out.ZCL_A.includes("ui_salv"));
});

test("structural edges do not propagate either — an INCLUDE is still not a consumption path", () => {
  const out = consumptionFacts(graph([
    { source: "ZCL_W", target: "CL_SALV_TABLE", kind: "call-method" },
    { source: "ZFUGR_X", target: "ZCL_W", kind: "includes" },
  ]));
  assert.deepEqual(out.ZFUGR_X ?? [], [], "an INCLUDE is the object's own body, not a call");
});

// ---------------------------------------------------------------------------------------------------
// ABSENCE IS NOT EVIDENCE. `rap_bo_headless` matches on `none: [ui_*, remote_*]`, so an object the detector
// simply could not read scored identically to one proven to have no surface. Silence now says so out loud.
// ---------------------------------------------------------------------------------------------------

test("an object with no surface evidence at all says so, rather than reading as proven-headless", () => {
  const out = consumptionFacts(graph([{ source: "ZCL_LONELY.M", target: "ZCL_OTHER.N", kind: "call-method" }]));
  assert.ok(
    out.ZCL_LONELY.includes("no_surface_evidence"),
    `silence must be explicit: ${JSON.stringify(out)}`,
  );
});

test("no_surface_evidence is never emitted alongside a real fact", () => {
  const out = consumptionFacts(graph([{ source: "ZCL_X", target: "CL_SALV_TABLE", kind: "call-method" }]));
  assert.ok(out.ZCL_X.includes("ui_salv"));
  assert.ok(!out.ZCL_X.includes("no_surface_evidence"), "evidence and its absence are mutually exclusive");
});

// ---------------------------------------------------------------------------------------------------
// ORACLE SAFETY NET (TALV arch-review, MEDIUM). The construct vocabulary is six hand-written regexes, so it
// misses classic SAP GUI classes nobody thought to list: CL_DD_DOCUMENT, CL_GUI_SPLITTER_CONTAINER,
// CL_DEMO_OUTPUT, CL_GUI_CFW, CL_GUI_TIMER all appear in TALV and match nothing. A hand-maintained list
// will always lag; the harness already ships a SHA-pinned registry that answers "is this a classic SAP API
// with no Cloud successor?" — so an unrecognised callee is checked against it rather than dropped.
//
// It is a NET, not a replacement. The oracle returns `classicAPI` for CL_GUI_ALV_GRID and
// CL_GUI_FRONTEND_SERVICES alike, so it cannot tell ui_salv from ui_frontend — and that distinction drives
// shape selection. The specific patterns keep their precedence; the oracle only catches what falls through,
// turning silence into a stated, if coarser, fact.
// Measured: 5 recoveries on TALV, 0 on equalize-idoc — precise, not a flood.

test("a classic SAP API the patterns never listed is still recorded as a surface", () => {
  for (const target of ["CL_DD_DOCUMENT", "CL_GUI_SPLITTER_CONTAINER", "CL_DEMO_OUTPUT", "CL_GUI_CFW"]) {
    const out = consumptionFacts(graph([{ source: "ZCL_X", target: `${target}.RUN`, kind: "call-method" }]));
    assert.deepEqual(out.ZCL_X, ["classic_api_surface"], `${target} is a classic API, not silence`);
  }
});

test("the specific patterns keep precedence over the oracle net", () => {
  // Both are classicAPI to the registry; only the pattern knows one is a grid and the other a file dialog.
  const salv = consumptionFacts(graph([{ source: "ZCL_A", target: "CL_GUI_ALV_GRID.SET_TABLE", kind: "call-method" }]));
  assert.deepEqual(salv.ZCL_A, ["ui_salv"], "a grid stays ui_salv, not the coarse fallback");
  const front = consumptionFacts(graph([{ source: "ZCL_B", target: "CL_GUI_FRONTEND_SERVICES.FILE_OPEN", kind: "call-method" }]));
  assert.deepEqual(front.ZCL_B, ["ui_frontend"], "a frontend service stays ui_frontend");
});

test("a customer object is not a classic API — the net does not fire on Z-code", () => {
  const out = consumptionFacts(graph([{ source: "ZCL_X", target: "ZCL_GUI_ALV_GRID.FREE", kind: "call-method" }]));
  assert.ok(!out.ZCL_X.includes("classic_api_surface"), `Z-code is not SAP's API: ${JSON.stringify(out)}`);
});
