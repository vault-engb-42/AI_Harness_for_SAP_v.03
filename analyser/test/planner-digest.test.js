import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { analyzePackage } from "../src/orchestrator.js";
import { buildPlannerDigest, writeDigest, digestPathFor } from "../src/planner-digest.js";
import { validatePlannerDigest } from "../src/validate-planner-digest.js";
import { filesFromBundle } from "../src/modes.js";

// G5 (arch spec §15.8, gap #20): the analyser emits a deterministic, size-capped
// planner-digest.json — used-objects only {object, grade, successor?, effort_tier}
// + Top-N findings — that the planner grounds on instead of the raw findings doc.
// Real pipeline, real files on disk, no mocks.

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "cli.js");
const TMP = join(tmpdir(), `analyser-digest-test-${process.pid}`);
after(() => rmSync(TMP, { recursive: true, force: true }));

const GRADE = new Set(["A", "B", "C", "D", "unknown"]);
const TIER = new Set(["retire", "re-platform", "keep-and-clean", "unknown"]);

// Same fixture the orchestrator suite uses: a customer class inheriting a deprecated
// SAP factory + a deprecated table read — yields grade C, a named successor, and
// released-api + P4-invariant + abaplint findings (>1 finding, so a cap is observable).
const FILES = [
  {
    filename: "zcl_svc.clas.abap",
    source: `CLASS zcl_svc DEFINITION PUBLIC INHERITING FROM cl_a4c_bc_factory.
  PUBLIC SECTION.
    METHODS run.
ENDCLASS.
CLASS zcl_svc IMPLEMENTATION.
  METHOD run.
    AUTHORITY-CHECK OBJECT 'S_DEVELOP' ID 'ACTVT' FIELD '03'.
    SELECT SINGLE * FROM bapiret1 INTO @DATA(ls).
  ENDMETHOD.
ENDCLASS.`,
  },
];
const OPTS = { source_system: "DEV100", package: "ZTEST", generated_at: "2026-07-02T00:00:00Z" };

// A multi-object bundle so array ORDER is observable in the determinism test.
const MULTI = [
  { filename: "zcl_a.clas.abap", source: `CLASS zcl_a DEFINITION PUBLIC FINAL CREATE PUBLIC.\n  PUBLIC SECTION.\n    METHODS run.\nENDCLASS.\nCLASS zcl_a IMPLEMENTATION.\n  METHOD run.\n    SELECT * FROM kna1 INTO TABLE @DATA(lt).\n  ENDMETHOD.\nENDCLASS.` },
  { filename: "zr_b.prog.abap", source: `REPORT zr_b.\nSTART-OF-SELECTION.\n  SELECT * FROM vbak INTO TABLE @DATA(lt).` },
  { filename: "zif_c.intf.abap", source: `INTERFACE zif_c PUBLIC.\n  METHODS do_it.\nENDINTERFACE.` },
];

test("digest projects used objects to {object, grade, successor?, effort_tier}", () => {
  const digest = buildPlannerDigest(analyzePackage(FILES, OPTS));
  const svc = digest.objects.find((o) => o.object === "ZCL_SVC");
  assert.ok(svc, "customer object ZCL_SVC present");
  assert.equal(svc.grade, "C");
  assert.ok(TIER.has(svc.effort_tier), `effort_tier legal: ${svc.effort_tier}`);
  const parent = digest.objects.find((o) => o.object === "CL_A4C_BC_FACTORY");
  assert.ok(parent, "SAP dependency node present");
  assert.equal(parent.successor, "CL_BCFG_CD_REUSE_API_FACTORY", "deprecated SAP object carries its oracle successor");
  // exactly the four §15.8 keys — no extra fields leak in
  for (const o of digest.objects) {
    const keys = Object.keys(o).sort();
    assert.deepEqual(keys, o.successor ? ["effort_tier", "grade", "object", "successor"] : ["effort_tier", "grade", "object"]);
    assert.ok(GRADE.has(o.grade), `grade legal: ${o.grade}`);
    assert.ok(TIER.has(o.effort_tier), `effort_tier legal: ${o.effort_tier}`);
  }
});

test("digest is a STRICT projection — invents no object or finding", () => {
  const doc = analyzePackage(FILES, OPTS);
  const digest = buildPlannerDigest(doc);
  const nodeObjects = new Set(doc.graph.nodes.map((n) => n.object));
  for (const o of digest.objects) assert.ok(nodeObjects.has(o.object), `${o.object} must be a real graph node`);
  for (const df of digest.findings) {
    assert.ok(
      doc.findings.some((sf) => sf.rule_id === df.rule_id && sf.object === df.object && sf.severity === df.severity && sf.message === df.message),
      `digest finding ${df.rule_id}/${df.object} must project a real analyser-findings entry`,
    );
  }
});

test("digest excludes method/form member nodes (counts OBJECTS)", () => {
  const doc = analyzePackage(MULTI, OPTS);
  const digest = buildPlannerDigest(doc);
  const members = new Set(["method", "form"]);
  const expected = doc.graph.nodes.filter((n) => !members.has(n.kind)).length;
  assert.equal(digest.object_count, expected, "object_count excludes method/form member nodes");
  const memberOwnersOnly = new Set(doc.graph.nodes.filter((n) => members.has(n.kind)).map((n) => n.id));
  for (const o of digest.objects) assert.ok(!memberOwnersOnly.has(o.object), "no member node id appears as a digest object");
});

test("digest is byte-identical across input order AND generated_at (deterministic, no wall-clock)", () => {
  const a = buildPlannerDigest(analyzePackage(MULTI, { ...OPTS, generated_at: "2020-01-01T00:00:00Z" }));
  const b = buildPlannerDigest(analyzePackage([...MULTI].reverse(), { ...OPTS, generated_at: "2099-12-31T23:59:59Z" }));
  assert.equal(JSON.stringify(a), JSON.stringify(b), "digest must not depend on input order or generated_at");
  assert.ok(!("generated_at" in a), "digest must carry no volatile generated_at field");
});

test("digest finding order is input-order-independent (findingComparator is a true total order)", () => {
  // Two findings that tie on (severity, object, rule_id, finding_id) but differ in message —
  // finding_id is hash(rule_id|object|enclosing_unit|normalized_snippet), NOT per-finding-unique,
  // so message is a legitimate divergence the comparator must still order deterministically.
  const mk = (message) => ({ object: "ZCL_X", rule_id: "released-api", severity: "priority-2", family: "released-api", message, finding_id: "SAME" });
  const base = { package: "ZP", source_system: "x", schema_version: "1.1.0", findings: [mk("alpha"), mk("beta")], graph: { nodes: [], edges: [] } };
  const forward = buildPlannerDigest(base);
  const reversed = buildPlannerDigest({ ...base, findings: [...base.findings].reverse() });
  assert.equal(
    JSON.stringify(forward.findings),
    JSON.stringify(reversed.findings),
    "findings tying on (severity,object,rule_id,finding_id) but differing in message must order deterministically regardless of input order",
  );
});

test("validatePlannerDigest accepts a real digest and rejects malformed ones (fail-closed)", () => {
  const digest = buildPlannerDigest(analyzePackage(FILES, OPTS));
  assert.ok(validatePlannerDigest(digest).valid, `should be valid: ${validatePlannerDigest(digest).errors.join("; ")}`);
  const badGrade = structuredClone(digest);
  badGrade.objects[0].grade = "Z";
  assert.ok(!validatePlannerDigest(badGrade).valid, "illegal grade must be rejected");
  const badSeverity = structuredClone(digest);
  if (badSeverity.findings.length) badSeverity.findings[0].severity = "sev-9";
  assert.ok(!badSeverity.findings.length || !validatePlannerDigest(badSeverity).valid, "illegal severity must be rejected");
  assert.ok(!validatePlannerDigest({ package: "ZP" }).valid, "missing required top-level fields must be rejected");
});

test("writeDigest is fail-closed and round-trips valid JSON; digestPathFor is the sibling path", () => {
  assert.equal(digestPathFor(join("x", "y", "analyser-findings.json")), join("x", "y", "planner-digest.json"));
  const out = join(TMP, "planner-digest.json");
  writeDigest(analyzePackage(FILES, OPTS), out);
  const reparsed = JSON.parse(readFileSync(out, "utf8"));
  assert.ok(validatePlannerDigest(reparsed).valid);
  assert.equal(reparsed.package, "ZTEST");
  const badDoc = {
    package: "ZP", source_system: "x", findings: [],
    graph: { nodes: [{ id: "N", object: "N", kind: "class", clean_core_grade: "BOGUS", effort_tier: "unknown" }], edges: [] },
  };
  assert.throws(() => writeDigest(badDoc, join(TMP, "never.json")), /schema-invalid/, "a schema-invalid digest is refused before write");
});

test("Top-N cap is honoured and truncation is loud (total count retained)", () => {
  const doc = analyzePackage(FILES, OPTS);
  assert.ok(doc.findings.length > 1, "fixture must yield multiple findings for the cap to be observable");
  const prev = process.env.PLANNER_DIGEST_MAX_FINDINGS;
  process.env.PLANNER_DIGEST_MAX_FINDINGS = "1";
  try {
    const digest = buildPlannerDigest(doc);
    assert.equal(digest.findings.length, 1, "findings capped at the configured max");
    assert.equal(digest.findings_included, 1);
    assert.ok(digest.finding_count > digest.findings_included, "loud truncation: total finding_count > included");
    const rank = { "priority-1": 0, "priority-2": 1, "priority-3": 2, info: 3 };
    const minSev = Math.min(...doc.findings.map((f) => rank[f.severity] ?? 99));
    assert.equal(rank[digest.findings[0].severity], minSev, "the single kept finding is the most severe present");
  } finally {
    if (prev === undefined) delete process.env.PLANNER_DIGEST_MAX_FINDINGS;
    else process.env.PLANNER_DIGEST_MAX_FINDINGS = prev;
  }
});

test("the CLI emits planner-digest.json next to analyser-findings.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "analyser-digest-cli-"));
  const out = join(dir, "r.json");
  try {
    writeFileSync(join(dir, "zcl_a.clas.abap"), MULTI[0].source, "utf8");
    writeFileSync(join(dir, "zr_b.prog.abap"), MULTI[1].source, "utf8");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "zif_c.intf.abap"), MULTI[2].source, "utf8");
    execFileSync(process.execPath, [CLI, dir, "--package", "ZDET", "--out", out, "--json"], { encoding: "utf8" });
    const digestPath = digestPathFor(out);
    assert.ok(existsSync(digestPath), "cli emits planner-digest.json beside the findings report");
    assert.ok(validatePlannerDigest(JSON.parse(readFileSync(digestPath, "utf8"))).valid, "emitted digest is schema-valid");
    assert.ok(filesFromBundle(dir).length >= 3, "bundle had multiple objects");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
