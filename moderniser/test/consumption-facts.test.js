import { test } from "node:test";
import assert from "node:assert/strict";
import { consumptionFacts } from "../src/plan/consumption-facts.js";

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
  assert.deepEqual(out.ZCL_IDOC_INPUT ?? [], [], `a Z-named superclass is not a surface: ${JSON.stringify(out)}`);
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
    assert.deepEqual(out.ZCL_X ?? [], [], `${target} is a customer object, not SAP's ALE API`);
  }
});

test("the SM30 view processor is not an ALE call, though its name carries the view's", () => {
  // VIEWPROC_ZBC_V_IDOC_OPT is a genuine call-function edge — so an edge-kind filter alone does not save
  // us. It is SAP's generated view-maintenance FM for a customer view that happens to be named *_IDOC_*.
  const out = consumptionFacts(graph([{ source: "ZBC_IDOC_CFG", target: "VIEWPROC_ZBC_V_IDOC_OPT", kind: "call-function" }]));
  assert.deepEqual(out.ZBC_IDOC_CFG ?? [], [], "SM30 maintenance is not ALE consumption");
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
