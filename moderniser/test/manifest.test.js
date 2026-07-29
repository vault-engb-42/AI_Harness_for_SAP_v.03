import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildDispositionManifest } from "../src/plan/manifest.js";
import { assemblePlan } from "../src/sched/assemble.js";

// B3 — the disposition manifest (MODERNISER_DESIGN §6.11): the plan-gate artifact. One row per plan node with
// the classified disposition; prompt rows carry the 3-4-option choice set (recommended + alternatives + other);
// auto rows omit options. Plus a by-disposition summary. Pure + deterministic.

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = JSON.parse(readFileSync(join(HERE, "fixtures", "analyser-findings.json"), "utf8"));

const plan = (nodes) => ({ plan_hash: "hash123", nodes });

test("emits one row per node + a by-disposition summary; prompt rows carry options, auto rows omit them", () => {
  const m = buildDispositionManifest(
    plan([
      { id: "s1", object: "A", disposition: "re_architect", disposition_target: "RAP BO", disposition_rationale: "ui", disposition_confidence: 0.85, disposition_autonomy: "prompt" },
      { id: "s2", object: "B", disposition: "refactor", disposition_target: "in-stack", disposition_rationale: "clean", disposition_confidence: 1, disposition_autonomy: "auto" },
    ]),
    { run_id: "r1" },
  );
  assert.equal(m.run_id, "r1");
  assert.equal(m.plan_hash, "hash123");
  assert.equal(m.rows.length, 2);

  const a = m.rows.find((r) => r.object === "A");
  assert.equal(a.sig, "s1");
  assert.equal(a.disposition, "re_architect");
  assert.equal(a.autonomy, "prompt");
  assert.ok(Array.isArray(a.options) && a.options.length >= 3, "prompt row carries >=3 options");
  assert.equal(a.options[0].recommended, true);
  assert.equal(a.options[0].disposition, "re_architect");
  assert.ok(a.options.at(-1).freeform, "options end with the operator-specified `other` escape");

  const b = m.rows.find((r) => r.object === "B");
  assert.equal(b.autonomy, "auto");
  assert.equal(b.options, undefined, "auto rows omit options");

  assert.deepEqual(m.summary.by_disposition, { re_architect: 1, refactor: 1 });
  assert.equal(m.summary.prompt_count, 1);
  assert.equal(m.summary.auto_count, 1);
});

test("rows are sorted by sig and the manifest is deterministic", () => {
  const p = plan([
    { id: "sB", object: "B", disposition: "seal", disposition_rationale: "manual", disposition_confidence: 0.3, disposition_autonomy: "prompt" },
    { id: "sA", object: "A", disposition: "re_architect", disposition_rationale: "ui", disposition_confidence: 0.85, disposition_autonomy: "prompt" },
  ]);
  const m1 = buildDispositionManifest(p, { run_id: "r" });
  assert.deepEqual(m1.rows.map((r) => r.sig), ["sA", "sB"], "sorted by sig");
  assert.equal(JSON.stringify(m1), JSON.stringify(buildDispositionManifest(p, { run_id: "r" })), "deterministic");
});

test("over the real abap_fico plan: a row per node, all prompt, every prompt row a valid choice set", () => {
  const { plan: p } = assemblePlan(DOC);
  const m = buildDispositionManifest(p, { run_id: "fico" });
  assert.equal(m.rows.length, p.nodes.length);
  assert.equal(m.summary.prompt_count, p.nodes.length, "finding-derived grounding → all prompt");
  for (const r of m.rows) {
    assert.ok(r.options.length >= 3 && r.options.filter((o) => o.recommended).length === 1);
    assert.equal(r.options[0].disposition, r.disposition, "the recommended option is the classified disposition");
  }
});
