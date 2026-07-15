import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// gap-2a invocation seam — the `lint-rules <sig> --files <dir>` verb runs the analyser over a
// node's generated artifacts and exits NON-ZERO (like a lint error) when a target RAP/N+1 rule
// fires, printing the structured hits on stdout so the driver can pass them back as repair
// context. Real subprocess over a scratch mkdtemp dir — never the repo's .claude/state.

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "cli.js");

function runLintRules(dir, sig = "probe") {
  const r = spawnSync(process.execPath, [CLI, "lint-rules", sig, "--files", dir], { encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const clas = (name, body) =>
  [
    `CLASS ${name} DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
    "  PUBLIC SECTION.",
    "    METHODS run.",
    "ENDCLASS.",
    `CLASS ${name} IMPLEMENTATION.`,
    "  METHOD run.",
    ...body,
    "  ENDMETHOD.",
    "ENDCLASS.",
  ].join("\n");

const CLEAN = clas("zcl_clean", ["    DATA lv_x TYPE i.", "    lv_x = 1."]);
const SELECT_IN_LOOP = clas("zcl_dirty", [
  "    DATA lt_keys TYPE STANDARD TABLE OF vbak.",
  "    LOOP AT lt_keys INTO DATA(ls_key).",
  "      SELECT SINGLE * FROM vbap INTO @DATA(ls_item) WHERE vbeln = @ls_key-vbeln.",
  "    ENDLOOP.",
]);

test("lint-rules blocks (exit 2) on a SELECT-in-loop artifact and reports the hit on stdout", () => {
  const dir = mkdtempSync(join(tmpdir(), "gap2a-"));
  writeFileSync(join(dir, "zcl_dirty.clas.abap"), SELECT_IN_LOOP);
  const { code, out } = runLintRules(dir);
  assert.equal(code, 2, "a rule hit must exit non-zero (like a lint error)");
  const res = JSON.parse(out);
  assert.equal(res.blocked, true);
  assert.ok(res.hits.some((h) => h.rule_id === "talos-select-in-loop"), "the hit must name the rule for repair context");
});

test("lint-rules includes an exemplar-backed repair brief on a hit (repair context for regeneration)", () => {
  const dir = mkdtempSync(join(tmpdir(), "gap2a-"));
  writeFileSync(join(dir, "zcl_dirty.clas.abap"), SELECT_IN_LOOP);
  const { out } = runLintRules(dir);
  const res = JSON.parse(out);
  assert.match(res.repair, /talos-select-in-loop/);
  assert.match(res.repair, /FOR ALL ENTRIES|pre-load/i, "repair carries the pre-load exemplar, not just the one-line message");
});

test("lint-rules passes (exit 0) on a clean artifact", () => {
  const dir = mkdtempSync(join(tmpdir(), "gap2a-"));
  writeFileSync(join(dir, "zcl_clean.clas.abap"), CLEAN);
  const { code, out } = runLintRules(dir);
  assert.equal(code, 0);
  assert.equal(JSON.parse(out).blocked, false);
});

test("lint-rules fails loud (exit 1) when --files is missing", () => {
  const r = spawnSync(process.execPath, [CLI, "lint-rules", "probe"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--files/);
});
