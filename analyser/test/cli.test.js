import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { filesFromBundle } from "../src/modes.js";
import { analyzePackage } from "../src/orchestrator.js";
import { renderReport } from "../cli.js";

// The local CLI is the no-MCP way to run the analyser and read the result in one
// command. Real bundle dirs on disk, real pipeline, real subprocess — no mocks.

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "cli.js");

const SRC_A = `CLASS zcl_demo DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS run.
ENDCLASS.
CLASS zcl_demo IMPLEMENTATION.
  METHOD run.
    SELECT * FROM kna1 INTO TABLE @DATA(lt).
  ENDMETHOD.
ENDCLASS.`;
const SRC_B = `REPORT zbtc_demo.
START-OF-SELECTION.
  WRITE 'hi'.`;

/** A bundle with a nested subfolder (mirrors abapGit src/ + src/btc/). */
function bundleDir() {
  const dir = mkdtempSync(join(tmpdir(), "analyser-cli-"));
  writeFileSync(join(dir, "zcl_demo.clas.abap"), SRC_A, "utf8");
  mkdirSync(join(dir, "btc"));
  writeFileSync(join(dir, "btc", "zbtc_demo.prog.abap"), SRC_B, "utf8");
  return dir;
}

test("filesFromBundle recurses into subfolders (src/btc-style nesting)", () => {
  const dir = bundleDir();
  try {
    const files = filesFromBundle(dir);
    assert.equal(files.length, 2);
    assert.ok(files.some((f) => f.filename === "zbtc_demo.prog.abap"), "nested subfolder file must be read");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("renderReport renders graph, findings, readiness and the out path", () => {
  const dir = bundleDir();
  try {
    const doc = analyzePackage(filesFromBundle(dir), { package: "ZDEMO" });
    const txt = renderReport(doc, 2, "specs/brownfield/analyser-findings.json");
    for (const section of ["ABAP Analyser — ZDEMO", "Code graph:", "Findings:", "S/4 readiness:", "Full report written to:"]) {
      assert.ok(txt.includes(section), `render must include "${section}"`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI runs a bundle end to end and renders the report (exit 0)", () => {
  const dir = bundleDir();
  const out = join(dir, "report.json");
  try {
    const stdout = execFileSync(process.execPath, [CLI, dir, "--package", "ZDEMO", "--out", out], { encoding: "utf8" });
    assert.match(stdout, /Code graph:/);
    assert.match(stdout, /Full report written to:/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI exits non-zero on a source-less directory (no silent empty report)", () => {
  const dir = mkdtempSync(join(tmpdir(), "analyser-cli-empty-"));
  try {
    assert.throws(() => execFileSync(process.execPath, [CLI, dir], { encoding: "utf8", stdio: "pipe" }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
