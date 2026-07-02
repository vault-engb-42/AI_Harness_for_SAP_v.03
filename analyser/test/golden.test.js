import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { analyzePackage } from "../src/orchestrator.js";
import { validateFindings } from "../src/validate-findings.js";

// C5 golden fixtures — a representative brownfield+RAP package with curated
// must-detect expectations. Asserts PRESENCE of key facts (robust to rule
// growth) plus determinism and schema validity, rather than a brittle full
// snapshot.

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const read = (name) => ({ filename: name, source: readFileSync(join(FIX, name), "utf8") });
const FILES = [
  read("zcl_legacy.clas.abap"),
  read("zi_travel.ddls.asddls"),
  read("zbp_travel.bdef.asbdef"),
];
const OPTS = { source_system: "DEV100", package: "ZGOLDEN", generated_at: "2026-07-02T00:00:00Z" };

const doc = analyzePackage(FILES, OPTS);
const ruleIds = new Set(doc.findings.map((f) => f.rule_id));
const nodeById = (id) => doc.graph.nodes.find((n) => n.id === id);
const hasEdge = (s, t, k) => doc.graph.edges.some((e) => e.source === s && e.target === t && e.kind === k);

test("the golden document is schema-valid", () => {
  const { valid, errors } = validateFindings(doc);
  assert.ok(valid, errors.join("; "));
});

test("analysis is deterministic (same input -> byte-identical output)", () => {
  const a = JSON.stringify(analyzePackage(FILES, OPTS));
  const b = JSON.stringify(analyzePackage(FILES, OPTS));
  assert.equal(a, b);
});

test("graph captures class, CDS and RAP objects", () => {
  assert.equal(nodeById("ZCL_LEGACY")?.kind, "class");
  assert.equal(nodeById("ZI_TRAVEL")?.kind, "cds");
  assert.equal(nodeById("ZBP_TRAVEL")?.kind, "behavior");
});

test("graph captures the key dependency edges", () => {
  assert.ok(hasEdge("ZCL_LEGACY", "CL_A4C_BC_FACTORY", "inherits"), "inherits deprecated class");
  assert.ok(hasEdge("ZCL_LEGACY", "BAPIRET1", "uses-table"), "uses deprecated table");
  assert.ok(hasEdge("ZCL_LEGACY", "Z_LEGACY_FM", "call-function"), "calls function module");
  assert.ok(hasEdge("ZBP_TRAVEL", "ZI_TRAVEL", "consumes-cds"), "RAP behavior -> CDS entity");
});

test("cross-family findings are all detected", () => {
  assert.ok(ruleIds.has("talos-cloud-001-call-function"), "regex-pack: CALL FUNCTION");
  assert.ok(ruleIds.has("talos-select-in-loop"), "statement-pack: SELECT in LOOP");
  assert.ok(ruleIds.has("released-api"), "released-api: deprecated dependency");
  assert.ok(ruleIds.has("talos-cds-auth-not-required"), "metadata-pack: CDS #NOT_REQUIRED");
});

test("S/4 readiness reflects the two deprecated dependencies", () => {
  assert.ok(doc.s4_readiness.deprecated_hits >= 2, `deprecated_hits=${doc.s4_readiness.deprecated_hits}`);
  assert.ok(doc.s4_readiness.s4_readiness_pct < 100);
});

test("blast radius lists the at-risk SAP objects", () => {
  const objs = doc.blast_radius.map((b) => b.object);
  assert.ok(objs.includes("BAPIRET1"));
  assert.ok(objs.includes("CL_A4C_BC_FACTORY"));
});

test("nodes carry modernization metadata for deprecated dependencies", () => {
  const parent = nodeById("CL_A4C_BC_FACTORY");
  assert.equal(parent.effort_tier, "re-platform");
  assert.equal(parent.modernization_target, "CL_BCFG_CD_REUSE_API_FACTORY");
});
