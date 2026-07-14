import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readBundleSources } from "../src/graph/sources.js";

// Gap-1 wiring (operator-ordered 2026-07-14): the Stage-1 dynamic scan needs each object's
// SOURCE, but the analyser findings doc deliberately carries none (P8 + size). This mapper
// reads the SAME abapGit bundle the analyser scanned and keys raw source by OBJECT id —
// the shape graph/adapt.js augmentFromCpg consumes.

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(HERE, "fixtures", "bundle");

test("maps bundle files to UPPERCASED object ids, recursively, ABAP extensions only", () => {
  const sources = readBundleSources(BUNDLE);
  assert.deepEqual(Object.keys(sources).sort(), ["ZFICO_BTC_CSV_SCR", "ZFICO_BTC_CSV_TOP"]);
  assert.match(sources.ZFICO_BTC_CSV_SCR, /CALL FUNCTION lv_fm/);
  assert.match(sources.ZFICO_BTC_CSV_TOP, /PERFORM upd_protocoll ON COMMIT/, "nested src/ dir is walked");
  assert.ok(!JSON.stringify(sources).includes("not ABAP"), "non-ABAP files are ignored");
});

test("multiple files for ONE object concatenate — the scan must see every line of the object", () => {
  const sources = readBundleSources(BUNDLE);
  assert.match(sources.ZFICO_BTC_CSV_TOP, /CALL TRANSACTION lv_tcode/, "the testclasses include is part of the object");
});

test("deterministic: two reads yield byte-identical maps (sorted walk)", () => {
  assert.equal(JSON.stringify(readBundleSources(BUNDLE)), JSON.stringify(readBundleSources(BUNDLE)));
});

test("a missing bundle dir fails loud — a silent {} would under-approximate (L5)", () => {
  assert.throws(() => readBundleSources(join(BUNDLE, "no-such-dir")), /bundle/i);
});
