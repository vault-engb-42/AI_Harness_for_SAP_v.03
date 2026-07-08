import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { filesFromBundle } from "../src/modes.js";
import { analyzePackage } from "../src/orchestrator.js";

// Determinism contract (arch spec §7 / §3.A): the OFFLINE analyse(files)->report
// is a pure function — its output is byte-identical across runs EXCEPT the single
// injectable volatile field `generated_at`. These are the red tests for A1-A6.
// Real pipeline, real subprocesses, real files on disk — no mocks.

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "cli.js");
const FIXED_TS = "2026-01-01T00:00:00.000Z";

// Multi-object sources with released-API / table-access findings, so the
// findings[], graph.nodes[], graph.edges[] and blast_radius[] arrays are
// non-trivial and their ORDER is observable if the pipeline does not sort.
const SRC_CLAS = `CLASS zcl_a DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS run.
ENDCLASS.
CLASS zcl_a IMPLEMENTATION.
  METHOD run.
    SELECT * FROM kna1 INTO TABLE @DATA(lt).
  ENDMETHOD.
ENDCLASS.`;
const SRC_PROG = `REPORT zr_b.
START-OF-SELECTION.
  SELECT * FROM vbak INTO TABLE @DATA(lt).`;
const SRC_INTF = `INTERFACE zif_c PUBLIC.
  METHODS do_it.
ENDINTERFACE.`;

/** A multi-file, multi-object, nested bundle so array ORDER is observable. */
function bundleDir() {
  const dir = mkdtempSync(join(tmpdir(), "analyser-determinism-"));
  writeFileSync(join(dir, "zcl_a.clas.abap"), SRC_CLAS, "utf8");
  writeFileSync(join(dir, "zr_b.prog.abap"), SRC_PROG, "utf8");
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "zif_c.intf.abap"), SRC_INTF, "utf8");
  return dir;
}

/** Strip the one injectable volatile field; everything else must be stable. */
function stripVolatile(doc) {
  const { generated_at, ...rest } = doc;
  return rest;
}
const sha = (obj) => createHash("sha256").update(JSON.stringify(obj)).digest("hex");

test("A1/A2/A5 — offline report is byte-identical regardless of source-file order", () => {
  const dir = bundleDir();
  try {
    const files = filesFromBundle(dir);
    assert.ok(files.length >= 3, "need multiple files for input order to be observable");
    const opts = { package: "ZDET", source_system: "bundle:fixed", generated_at: FIXED_TS };
    const forward = analyzePackage(files, opts);
    const reversed = analyzePackage([...files].reverse(), opts);
    assert.equal(
      sha(stripVolatile(forward)),
      sha(stripVolatile(reversed)),
      "analyse(files) must not depend on input file order — sort files (A1), findings (A2) and every Set/Map emit (A5)",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("A1 — CRLF vs LF line endings produce a byte-identical report", () => {
  const lf = bundleDir();
  const crlf = mkdtempSync(join(tmpdir(), "analyser-determinism-crlf-"));
  try {
    // same logical sources, only line endings differ
    writeFileSync(join(crlf, "zcl_a.clas.abap"), SRC_CLAS.replace(/\n/g, "\r\n"), "utf8");
    writeFileSync(join(crlf, "zr_b.prog.abap"), SRC_PROG.replace(/\n/g, "\r\n"), "utf8");
    mkdirSync(join(crlf, "sub"));
    writeFileSync(join(crlf, "sub", "zif_c.intf.abap"), SRC_INTF.replace(/\n/g, "\r\n"), "utf8");
    const opts = { package: "ZDET", source_system: "bundle:fixed", generated_at: FIXED_TS };
    const docLf = analyzePackage(filesFromBundle(lf), opts);
    const docCrlf = analyzePackage(filesFromBundle(crlf), opts);
    assert.equal(
      sha(stripVolatile(docLf)),
      sha(stripVolatile(docCrlf)),
      "line endings must be normalized before hashing/analysis (A1) — CRLF and LF inputs must yield the same report",
    );
  } finally {
    rmSync(lf, { recursive: true, force: true });
    rmSync(crlf, { recursive: true, force: true });
  }
});

test("A6 — the CLI produces a byte-identical report across fresh processes (minus generated_at)", () => {
  const dir = bundleDir();
  const out = join(dir, "r.json");
  try {
    const hashes = [];
    for (let i = 0; i < 3; i++) {
      const stdout = execFileSync(
        process.execPath,
        [CLI, dir, "--package", "ZDET", "--out", out, "--json"],
        { encoding: "utf8" },
      );
      hashes.push(sha(stripVolatile(JSON.parse(stdout))));
    }
    assert.equal(new Set(hashes).size, 1, `all fresh-process runs must hash-match (got ${new Set(hashes).size} distinct hashes)`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("A4 — coverage_note carries no volatile timing under a forced soft-budget overrun", () => {
  const dir = bundleDir();
  const prev = process.env.ABAPLINT_TIMEOUT_MS;
  process.env.ABAPLINT_TIMEOUT_MS = "1"; // force the parse+graph soft-budget overrun path
  try {
    const files = filesFromBundle(dir);
    const opts = { package: "ZDET", source_system: "bundle:fixed", generated_at: FIXED_TS };
    const a = analyzePackage(files, opts);
    const b = analyzePackage(files, opts);
    assert.equal(sha(stripVolatile(a)), sha(stripVolatile(b)), "two runs under a forced timeout must be byte-identical");
    assert.match(a.coverage_note ?? "", /exceeded the ABAPLINT_TIMEOUT_MS soft budget/, "the overrun path must be exercised");
    assert.doesNotMatch(a.coverage_note ?? "", /took/, "no volatile elapsed-ms ('took Nms') in the note (A4)");
  } finally {
    if (prev === undefined) delete process.env.ABAPLINT_TIMEOUT_MS; else process.env.ABAPLINT_TIMEOUT_MS = prev;
  }
});
