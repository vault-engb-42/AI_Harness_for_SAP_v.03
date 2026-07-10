import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scopeNodes, scopeMeta, scopeConflictNodes } from "../src/node/scope.js";
import { canonicalNodeId } from "../src/state/node-id.js";

// §6.2 — the SCOPE per-node JOIN (keyed by object). For each modernization_plan object,
// derive canonical_sig = sha256(rule|entity_name|seam) and join grade (code_health),
// debt (debt.scores), blast (Σ blast_radius over the object's at-risk deps), complexity/
// wave/plan fields, program-pool resource keys (from `includes` edges), and parity_required.
// Pure; adapters feed kahnLevels (scopeMeta) and buildConflictGraph (scopeConflictNodes).

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = JSON.parse(readFileSync(join(HERE, "fixtures", "analyser-findings.json"), "utf8"));
const byObj = (scoped, o) => scoped.find((s) => s.object === o);

test("scopeNodes joins one record per modernization_plan object", () => {
  const s = scopeNodes(DOC);
  assert.deepEqual(s.map((n) => n.object).sort(), ["ZFICO_BTC_CSV_GL", "ZFICO_BTC_CSV_SCR", "ZFICO_BTC_CSV_TOP"]);
});

test("the entry object GL joins grade/debt/blast/complexity from the real analyser sections", () => {
  const gl = byObj(scopeNodes(DOC), "ZFICO_BTC_CSV_GL");
  assert.equal(gl.grade, "D", "code_health.by_object grade");
  assert.equal(gl.debt, 0.631, "debt.scores");
  assert.equal(gl.blast, 2, "Σ blast_radius over SKA1(1)+SKB1(1) — GL's uses-table deps");
  assert.equal(gl.migration_complexity, 1);
  assert.equal(gl.parity_required, true, "44 transformations");
  assert.deepEqual(gl.meta, { grade: "D", complexity: 1, blast: 2 });
});

test("canonical_sig = sha256(rule|entity_name|seam) with the driving finding's rule", () => {
  const gl = byObj(scopeNodes(DOC), "ZFICO_BTC_CSV_GL");
  assert.match(gl.canonical_sig, /^[0-9a-f]{64}$/);
  // GL's driving finding = its highest-severity (P1), lex-min-tiebroken rule = "released-api"
  // (stable across source shifts — NOT the positional-first transformation).
  assert.equal(gl.canonical_sig, canonicalNodeId({ rule: "released-api", entity_name: "ZFICO_BTC_CSV_GL", seam: "ZFICO_BTC_CSV_GL" }));
});

test("program_pool is derived from `includes` edges — GL/SCR/TOP share the main program's pool", () => {
  const s = scopeNodes(DOC);
  assert.equal(byObj(s, "ZFICO_BTC_CSV_GL").resource_keys.program_pool, "ZFICO_BTC_CSV_GL");
  assert.equal(byObj(s, "ZFICO_BTC_CSV_SCR").resource_keys.program_pool, "ZFICO_BTC_CSV_GL");
  assert.equal(byObj(s, "ZFICO_BTC_CSV_TOP").resource_keys.program_pool, "ZFICO_BTC_CSV_GL");
});

test("a non-entry object with no at-risk deps has blast 0 and grade unknown", () => {
  const scr = byObj(scopeNodes(DOC), "ZFICO_BTC_CSV_SCR");
  assert.equal(scr.blast, 0);
  assert.equal(scr.grade, "unknown");
  assert.equal(scr.debt, 0.184);
});

test("scopeMeta keys by object for kahnLevels; scopeConflictNodes keys by object for buildConflictGraph", () => {
  const s = scopeNodes(DOC);
  assert.deepEqual(scopeMeta(s).ZFICO_BTC_CSV_GL, { grade: "D", complexity: 1, blast: 2 });
  const conf = scopeConflictNodes(s).find((n) => n.id === "ZFICO_BTC_CSV_GL");
  assert.equal(conf.program_pool, "ZFICO_BTC_CSV_GL");
  assert.deepEqual(conf.ddic, []);
});

test("parity_required is false and canonical_sig uses 'no-finding' when an object has no transformations", () => {
  const doc = { modernization_plan: { objects: [{ object: "Z", kind: "class", transformation_count: 0, transformations: [] }] } };
  const z = scopeNodes(doc)[0];
  assert.equal(z.parity_required, false);
  assert.equal(z.canonical_sig, canonicalNodeId({ rule: "no-finding", entity_name: "Z", seam: "Z" }));
});

test("scopeNodes is deterministic", () => {
  assert.equal(JSON.stringify(scopeNodes(DOC)), JSON.stringify(scopeNodes(DOC)));
});

// --- Rule-11 review remediations ---

test("blast counts a shared at-risk dep ONCE even when reached via multiple edge kinds", () => {
  const doc = {
    graph: {
      nodes: [{ id: "P", object: "P", kind: "report", namespace: "Z" }, { id: "T", object: "T", kind: "table", namespace: "sap" }],
      edges: [{ source: "P", target: "T", kind: "uses-table" }, { source: "P", target: "T", kind: "call-function" }],
    },
    blast_radius: [{ object: "T", affected_program_count: 5 }],
    modernization_plan: { objects: [{ object: "P", transformation_count: 1, transformations: [{ rule_id: "r" }], migration_complexity: 0 }] },
  };
  assert.equal(scopeNodes(doc)[0].blast, 5, "5, not 10 — one distinct dep");
});

test("a shared include (pulled by two mains) puts all three in ONE program pool (co-tenant)", () => {
  const n = (id) => ({ id, object: id, kind: "report", namespace: "Z" });
  const doc = {
    graph: { nodes: [n("A"), n("B"), n("I")], edges: [{ source: "A", target: "I", kind: "includes" }, { source: "B", target: "I", kind: "includes" }] },
    modernization_plan: { objects: [{ object: "A", transformations: [] }, { object: "B", transformations: [] }, { object: "I", transformations: [] }] },
  };
  const s = scopeNodes(doc);
  const pool = (o) => s.find((x) => x.object === o).resource_keys.program_pool;
  assert.equal(pool("A"), pool("I"));
  assert.equal(pool("B"), pool("I"), "A, B, I share one co-tenancy cluster via the shared include");
});

test("canonical_sig uses the DRIVING (highest-severity) finding's rule, stable across transformation order", () => {
  const doc = {
    findings: [{ object: "Z", rule_id: "zlow", atc_priority: "P3" }, { object: "Z", rule_id: "acrit", atc_priority: "P1" }],
    modernization_plan: { objects: [{ object: "Z", transformation_count: 2, transformations: [{ rule_id: "zlow" }, { rule_id: "acrit" }], migration_complexity: 0 }] },
  };
  assert.equal(
    scopeNodes(doc)[0].canonical_sig,
    canonicalNodeId({ rule: "acrit", entity_name: "Z", seam: "Z" }),
    "P1 'acrit' drives the sig, not the positional-first 'zlow'",
  );
});
