import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalNodeId } from "../src/state/node-id.js";

// §6.3 / L6.3 / L9 — the canonical content-hashed node id keys the ratchet
// baselines, so it must be stable across re-parse and never collide distinct nodes.

const SIG = { rule: "talos-cloud-001", entity_name: "ZFICO_BTC_CSV_GL", seam: "START-OF-SELECTION" };

test("canonicalNodeId is a 64-char sha256 hex, deterministic", () => {
  const id = canonicalNodeId(SIG);
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.equal(id, canonicalNodeId({ ...SIG }));
});

test("canonicalNodeId is sensitive to every component", () => {
  const base = canonicalNodeId(SIG);
  assert.notEqual(base, canonicalNodeId({ ...SIG, rule: "talos-cloud-002" }));
  assert.notEqual(base, canonicalNodeId({ ...SIG, entity_name: "ZFICO_BTC_CSV_SCR" }));
  assert.notEqual(base, canonicalNodeId({ ...SIG, seam: "FORM_MAIN" }));
});

test("canonicalNodeId fails closed on a missing / empty / non-string component", () => {
  assert.throws(() => canonicalNodeId({ rule: "r", entity_name: "e" }));         // missing seam
  assert.throws(() => canonicalNodeId({ rule: "r", entity_name: "", seam: "s" })); // empty
  assert.throws(() => canonicalNodeId(null));
});

test("canonicalNodeId rejects a '|' in any component (delimiter-collision guard)", () => {
  // 'a'+'|'+'b|c'+'|'+'d' and 'a|b'+'|'+'c'+'|'+'d' would both be "a|b|c|d"
  assert.throws(() => canonicalNodeId({ rule: "a", entity_name: "b|c", seam: "d" }));
});
