import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzePackage } from "../src/orchestrator.js";

// §10 fail-closed: a malformed object that crashes abaplint's registry-wide run
// (e.g. the abapdoc rule on a condensed single-line class) must degrade to a
// per-object diagnostic, never abort the whole scan. Real pipeline, no mocks.

const FIXED = "2026-01-01T00:00:00.000Z";
// This condensed class (definition + implementation) triggers an abaplint-internal
// TypeError in the abapdoc rule (rows[previousRow] is undefined).
const CRASHER =
  "CLASS zcl_x DEFINITION PUBLIC. PUBLIC SECTION. METHODS run. ENDCLASS.\n" +
  "CLASS zcl_x IMPLEMENTATION. METHOD run.\n  SELECT SINGLE * FROM t001 INTO @DATA(w).\nENDMETHOD. ENDCLASS.";

test("a malformed object that crashes abaplint does not abort the scan (§10 fail-closed)", () => {
  let doc;
  assert.doesNotThrow(() => {
    doc = analyzePackage([{ filename: "zcl_x.clas.abap", source: CRASHER }], { package: "ZX", generated_at: FIXED });
  }, "malformed source must not crash analyzePackage");
  assert.ok(Array.isArray(doc.findings), "the scan still produced a findings document");
});

test("well-formed objects alongside a crasher are still analyzed (per-object isolation)", () => {
  const good = "REPORT zr.\nSTART-OF-SELECTION.\n  SELECT SINGLE * FROM t001 INTO @DATA(w).";
  const doc = analyzePackage(
    [{ filename: "zcl_x.clas.abap", source: CRASHER }, { filename: "zr.prog.abap", source: good }],
    { package: "ZX", generated_at: FIXED },
  );
  assert.ok(doc.findings.some((f) => f.object === "ZR"), "the good object's findings survive the crasher");
});
