import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SEVERITY, NODE_KIND, EDGE_KIND, EDGE_ACCESS, NAMESPACE, validateFindings } from "../src/validate-findings.js";
import { KNOWN_HINTS } from "../../moderniser/src/node/disposition-hints.js";

// THE SEAM. `analyser-findings.json` is the entire contract between two independently-edited engines, and
// it is declared in more than one place: the JSON Schema is authoritative, `validate-findings.js` states in
// its own docstring that it "mirrors" that schema, and `edge-kinds.js` carries the EdgeKind union a third
// time as a typedef. A hand mirror drifts silently — the mirror keeps validating documents happily while
// agreeing to a stale vocabulary.
//
// Measured cost of that drift (2026-08-12/13): R3a added `access` to uses-table edges and FOUR consumers
// were not updated — semantic.js, cpg.js, extract/bundle.js (where a modernisation that deleted an object's
// only DB write scored the strongest available pass) and the schema itself. Eleven modules read
// `graph.edges` and each re-projects it longhand, so one added field is N independent omissions rather than
// one compile error.
//
// These tests make the copies check each other. They do not stop someone adding a field; they stop a field
// being added in one declaration and silently absent from another.

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(readFileSync(join(HERE, "..", "..", ".claude", "schemas", "analyser-findings.schema.json"), "utf8"));
const edgeProps = SCHEMA.properties.graph.properties.edges.items.properties;
const nodeProps = SCHEMA.properties.graph.properties.nodes.items.properties;
const findingProps = SCHEMA.properties.findings.items.properties;

const sorted = (xs) => [...xs].sort();

test("the validator's edge-kind vocabulary IS the schema's — not a copy that happens to agree today", () => {
  assert.deepEqual(sorted(EDGE_KIND), sorted(edgeProps.kind.enum));
});

test("the validator's node-kind vocabulary IS the schema's", () => {
  assert.deepEqual(sorted(NODE_KIND), sorted(nodeProps.kind.enum));
});

test("the validator's severity and namespace vocabularies ARE the schema's", () => {
  assert.deepEqual(sorted(SEVERITY), sorted(findingProps.severity.enum));
  assert.deepEqual(sorted(NAMESPACE), sorted(nodeProps.namespace.enum));
});

test("the validator knows about `access` — the field whose omission cost four consumers", () => {
  assert.deepEqual(sorted(EDGE_ACCESS), sorted(edgeProps.access.enum));
});

test("a bad `access` mode is REJECTED — declaring the field is not the same as enforcing it", () => {
  const doc = {
    source_system: "t", package: "t", generated_at: "2026-08-13T00:00:00Z", findings: [],
    s4_readiness: { s4_readiness_pct: 100, released_hits: 0, deprecated_hits: 0 },
    graph: { nodes: [], edges: [{ source: "ZA", target: "ZTAB", kind: "uses-table", access: "rw" }] },
  };
  const { errors } = validateFindings(doc);
  assert.ok(errors.some((e) => /access/i.test(e)), `expected an access error, got: ${JSON.stringify(errors)}`);
});

test("a VALID access mode passes, and an absent one is legal (pre-R3a documents)", () => {
  const base = (edge) => ({
    source_system: "t", package: "t", generated_at: "2026-08-13T00:00:00Z", findings: [],
    s4_readiness: { s4_readiness_pct: 100, released_hits: 0, deprecated_hits: 0 },
    graph: { nodes: [], edges: [edge] },
  });
  for (const edge of [
    { source: "ZA", target: "ZTAB", kind: "uses-table", access: "write" },
    { source: "ZA", target: "ZTAB", kind: "uses-table", access: "read" },
    { source: "ZA", target: "ZTAB", kind: "uses-table" },
  ]) {
    const { errors } = validateFindings(base(edge));
    assert.deepEqual(errors.filter((e) => /access/i.test(e)), [], `${JSON.stringify(edge)} must be accepted`);
  }
});

// The OTHER seam: the analyser stamps `disposition_hint` on a rule and the moderniser acts on it directly —
// a ui_rearch hint routes an object to re_architect. The producer's vocabulary and the consumer's closed
// enum are declared in different repos-worth of file, and a hint the consumer does not know is silently
// ignored (dispositionHint falls through to the regex fallback), so drift here is invisible by construction.
test("the schema's disposition_hint enum IS the moderniser's closed hint vocabulary", () => {
  assert.deepEqual(sorted(findingProps.disposition_hint.enum), sorted(KNOWN_HINTS));
});

test("every disposition_hint stamped on a rule is one the moderniser recognises", () => {
  const rows = (p) => {
    const j = JSON.parse(readFileSync(join(HERE, "..", "rules", "data", p), "utf8"));
    return Array.isArray(j) ? j : (j.rules ?? Object.values(j).find(Array.isArray));
  };
  const unknown = [];
  for (const pack of ["regex-rules.json", "metadata-rules.json"]) {
    for (const r of rows(pack)) {
      if (r?.disposition_hint && !KNOWN_HINTS.has(r.disposition_hint)) {
        unknown.push(`${pack}:${r.id} stamps '${r.disposition_hint}'`);
      }
    }
  }
  assert.deepEqual(unknown, [], `hints the moderniser would silently ignore:\n  ${unknown.join("\n  ")}`);
});
