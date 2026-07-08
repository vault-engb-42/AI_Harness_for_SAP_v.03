import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceHash, configHash, runId } from "../src/run-identity.js";
import { filesFromBundle } from "../src/modes.js";
import { analyzePackage } from "../src/orchestrator.js";

// Run identity (arch spec §7): source_hash / config_hash / run_id are the
// offline provenance + cache key. SHA-256 over a canonical serialization (resolves
// the R6 "hash primitive is never named" gap). Real registries + real files.

const SRC = `CLASS zcl_a DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS run.
ENDCLASS.
CLASS zcl_a IMPLEMENTATION.
  METHOD run.
    SELECT * FROM kna1 INTO TABLE @DATA(lt).
  ENDMETHOD.
ENDCLASS.`;

test("sourceHash is a stable 64-char sha256 hex over the file set, order-independent", () => {
  const files = [{ filename: "a.abap", source: "REPORT za." }, { filename: "b.abap", source: "REPORT zb." }];
  const h1 = sourceHash(files);
  assert.match(h1, /^[0-9a-f]{64}$/, "sha256 hex");
  assert.equal(sourceHash([...files].reverse()), h1, "same set, any order -> same hash (caller canonicalizes)");
  assert.notEqual(sourceHash([{ filename: "a.abap", source: "REPORT zc." }]), h1, "different source -> different hash");
});

test("configHash is a stable sha256 hex and reflects target_release", () => {
  const a = configHash({ target_release: "S4HANA_READINESS_2025" });
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(configHash({ target_release: "S4HANA_READINESS_2025" }), a, "stable across calls");
  assert.notEqual(configHash({ target_release: "PRIVATE_EDITION" }), a, "target_release is part of identity");
});

test("runId = sha256(source_hash + config_hash), stable and sensitive to both", () => {
  const s = "a".repeat(64), c = "b".repeat(64);
  const r = runId(s, c);
  assert.match(r, /^[0-9a-f]{64}$/);
  assert.equal(runId(s, c), r, "stable");
  assert.notEqual(runId("c".repeat(64), c), r, "changes with source_hash");
  assert.notEqual(runId(s, "d".repeat(64)), r, "changes with config_hash");
});

test("analyzePackage stamps run_id / source_hash / config_hash / schema_version, deterministically", () => {
  const dir = mkdtempSync(join(tmpdir(), "run-id-"));
  try {
    writeFileSync(join(dir, "zcl_a.clas.abap"), SRC, "utf8");
    const opts = { package: "ZID", source_system: "bundle:fixed", generated_at: "2026-01-01T00:00:00.000Z" };
    const a = analyzePackage(filesFromBundle(dir), opts);
    assert.match(a.run_id, /^[0-9a-f]{64}$/, "doc carries run_id");
    assert.match(a.source_hash, /^[0-9a-f]{64}$/, "doc carries source_hash");
    assert.match(a.config_hash, /^[0-9a-f]{64}$/, "doc carries config_hash");
    assert.equal(typeof a.schema_version, "string");
    const b = analyzePackage(filesFromBundle(dir), opts);
    assert.equal(b.run_id, a.run_id, "same input -> same run_id (offline identity)");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
