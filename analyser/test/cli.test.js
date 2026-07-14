import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
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

test("CLI --sarif exports a standalone SARIF 2.1.0 document (machine artifact, not in HTML)", () => {
  const dir = bundleDir();
  const out = join(dir, "report.json");
  const sarif = join(dir, "out.sarif");
  try {
    const stdout = execFileSync(process.execPath, [CLI, dir, "--package", "ZDEMO", "--out", out, "--sarif", sarif], { encoding: "utf8" });
    assert.match(stdout, /SARIF 2\.1\.0 export:/);
    const doc = JSON.parse(readFileSync(sarif, "utf8"));
    assert.equal(doc.version, "2.1.0");
    assert.ok(Array.isArray(doc.runs?.[0]?.results), "runs[0].results present");
    assert.equal(doc.runs[0].tool.driver.name, "sap-abap-harness-analyser");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI exits non-zero on a source-less directory (no silent empty report)", () => {
  const dir = mkdtempSync(join(tmpdir(), "analyser-cli-empty-"));
  try {
    assert.throws(() => execFileSync(process.execPath, [CLI, dir], { encoding: "utf8", stdio: "pipe" }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI `compare before.json after.json --html` writes a self-contained before/after report", () => {
  const dir = mkdtempSync(join(tmpdir(), "analyser-cmp-"));
  const mk = (pkg, s4, cloud, grade) => ({ package: pkg, findings: [], code_health: { clean_core_grade: grade, clarity: 0, stability: 0, performance: 0, compound: 0, clarity_breakdown: { cyclomatic: 0, length: 0, nesting: 0, lcom: null }, clarity_coverage: { cyclomatic: 0, length: 0, nesting: 0, lcom: 0, objects: 0 } }, s4_readiness: { s4_readiness_pct: s4, cloud_readiness_pct: cloud, s4_blocker_findings: 0, cloud_blocker_findings: 0 } });
  const before = join(dir, "b.json");
  const after = join(dir, "a.json");
  const html = join(dir, "cmp.html");
  writeFileSync(before, JSON.stringify(mk("abap_fico", 36, 27, "D")), "utf8");
  writeFileSync(after, JSON.stringify(mk("modernised abap_fico", 100, 82, "A")), "utf8");
  try {
    const stdout = execFileSync(process.execPath, [CLI, "compare", before, after, "--html", html], { encoding: "utf8" });
    assert.match(stdout, /comparison HTML:/);
    const doc = readFileSync(html, "utf8");
    assert.match(doc, /^<!doctype html>/i);
    assert.ok(doc.includes("abap_fico") && doc.includes("100") && doc.includes("82"), "both sides + headline numbers");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI `compare` with too few args exits non-zero", () => {
  const dir = mkdtempSync(join(tmpdir(), "analyser-cmp2-"));
  const b = join(dir, "b.json");
  writeFileSync(b, "{}", "utf8");
  try {
    assert.throws(() => execFileSync(process.execPath, [CLI, "compare", b], { encoding: "utf8", stdio: "pipe" }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
