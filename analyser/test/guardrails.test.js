import { test } from "node:test";
import assert from "node:assert/strict";
import { DependencyGraph } from "../src/cpg.js";
import { analyzePackage } from "../src/orchestrator.js";
import { validateFindings } from "../src/validate-findings.js";

// Resource guardrails (spec §10.2): a runaway input must degrade with an
// explicit coverage note, never exhaust memory silently. abaplint's parse()
// is synchronous and cannot be preempted, so the honest protections are
// input-size caps plus a recorded soft budget.

test("DependencyGraph honors a node cap and reports truncation", () => {
  const g = new DependencyGraph({ maxNodes: 10 });
  for (let i = 0; i < 25; i++) g.addNode({ id: `N${i}`, kind: "class", object: `N${i}` });
  assert.equal(g.nodeCount(), 10);
  assert.equal(g.truncated, true);
  const unlimited = new DependencyGraph();
  for (let i = 0; i < 25; i++) unlimited.addNode({ id: `N${i}`, kind: "class", object: `N${i}` });
  assert.equal(unlimited.nodeCount(), 25);
  assert.equal(unlimited.truncated, false);
});

test("a graph-node cap surfaces in the document's coverage_note", () => {
  process.env.MAX_GRAPH_NODES = "2";
  try {
    const doc = analyzePackage(
      [
        {
          filename: "zcl_a.clas.abap",
          source: `CLASS zcl_a DEFINITION PUBLIC FINAL.
  PUBLIC SECTION.
    METHODS m1.
    METHODS m2.
ENDCLASS.
CLASS zcl_a IMPLEMENTATION.
  METHOD m1.
    SELECT SINGLE * FROM t000 INTO @DATA(s1).
  ENDMETHOD.
  METHOD m2.
    SELECT SINGLE * FROM t005 INTO @DATA(s2).
  ENDMETHOD.
ENDCLASS.`,
        },
      ],
      { generated_at: "2026-07-03T00:00:00Z" },
    );
    assert.ok(doc.graph.nodes.length <= 2, "cap enforced");
    assert.match(doc.coverage_note ?? "", /graph truncated/i, "truncation is stated, never silent");
    assert.ok(validateFindings(doc).valid);
  } finally {
    delete process.env.MAX_GRAPH_NODES;
  }
});

test("an oversized source file is skipped with an explicit coverage note", () => {
  process.env.ANALYSER_MAX_FILE_BYTES = "100";
  try {
    const doc = analyzePackage(
      [
        { filename: "zr_small.prog.abap", source: "REPORT zr_small." },
        { filename: "zr_big.prog.abap", source: `REPORT zr_big.\n${"* filler line\n".repeat(50)}` },
      ],
      { generated_at: "2026-07-03T00:00:00Z" },
    );
    assert.ok(doc.graph.nodes.some((n) => n.id === "ZR_SMALL"), "small file analysed");
    assert.ok(!doc.graph.nodes.some((n) => n.id === "ZR_BIG"), "oversized file skipped");
    assert.match(doc.coverage_note ?? "", /zr_big\.prog\.abap/, "skip is named in the coverage note");
  } finally {
    delete process.env.ANALYSER_MAX_FILE_BYTES;
  }
});
