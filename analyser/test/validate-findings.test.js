import { test } from "node:test";
import assert from "node:assert/strict";
import { validateFindings } from "../src/validate-findings.js";

function minimalValid() {
  return {
    source_system: "DEV",
    package: "ZP",
    generated_at: "2026-07-02T00:00:00Z",
    findings: [{ rule_id: "r", severity: "priority-1", object: "ZCL", message: "m" }],
    s4_readiness: { s4_readiness_pct: 100, released_hits: 1, deprecated_hits: 0 },
    graph: { nodes: [{ id: "ZCL", kind: "class", object: "ZCL", namespace: "Z" }], edges: [] },
  };
}

test("a well-formed document validates", () => {
  const { valid, errors } = validateFindings(minimalValid());
  assert.ok(valid, errors.join("; "));
});

test("a missing required top-level field fails", () => {
  const doc = minimalValid();
  delete doc.s4_readiness;
  const { valid, errors } = validateFindings(doc);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("s4_readiness")));
});

test("a bad finding severity fails", () => {
  const doc = minimalValid();
  doc.findings[0].severity = "blocker";
  const { valid, errors } = validateFindings(doc);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("bad severity")));
});

test("a bad edge kind fails", () => {
  const doc = minimalValid();
  doc.graph.edges.push({ source: "A", target: "B", kind: "invokes" });
  const { valid, errors } = validateFindings(doc);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("bad kind")));
});

test("a bad node namespace fails", () => {
  const doc = minimalValid();
  doc.graph.nodes[0].namespace = "customer";
  const { valid, errors } = validateFindings(doc);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("bad namespace")));
});

test("a finding missing its object fails", () => {
  const doc = minimalValid();
  delete doc.findings[0].object;
  const { valid } = validateFindings(doc);
  assert.equal(valid, false);
});

test("null and empty-string enum values are rejected (not silently accepted)", () => {
  const withNullSeverity = minimalValid();
  withNullSeverity.findings[0].severity = null;
  assert.equal(validateFindings(withNullSeverity).valid, false, "null severity");

  const withEmptyNamespace = minimalValid();
  withEmptyNamespace.graph.nodes[0].namespace = "";
  assert.equal(validateFindings(withEmptyNamespace).valid, false, "empty namespace");

  const withNullRequired = minimalValid();
  withNullRequired.package = null;
  assert.equal(validateFindings(withNullRequired).valid, false, "null required field");
});
