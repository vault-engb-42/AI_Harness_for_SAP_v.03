import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// P3 side-lookup — `findings-brief <object> --findings <analyser-findings.json>` reads the object's
// priority-1 structural anti-patterns from the findings doc (NOT the frozen plan) and renders them
// as a pre-generation "avoid these" grounding brief, so the generator writes the fixed form
// first-pass instead of reproducing the source defect.

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "cli.js");

function findingsBrief(object, findingsPath) {
  const r = spawnSync(process.execPath, [CLI, "findings-brief", object, "--findings", findingsPath], { encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function writeFindings(rows) {
  const dir = mkdtempSync(join(tmpdir(), "fbrief-"));
  const p = join(dir, "analyser-findings.json");
  writeFileSync(p, JSON.stringify({ findings: rows }));
  return p;
}

test("renders the object's priority-1 KB anti-patterns as avoid-grounding, scoped to that object", () => {
  const p = writeFindings([
    { rule_id: "talos-select-in-loop", severity: "priority-1", object: "ZCL_X", file: "zcl_x.clas.abap", line: 49, message: "N+1" },
    { rule_id: "talos-rap-modify-in-loop", severity: "priority-1", object: "ZCL_X", file: "zcl_x.clas.abap", line: 12, message: "EML in loop" },
    { rule_id: "talos-select-in-loop", severity: "priority-1", object: "ZCL_OTHER", file: "o.clas.abap", line: 1, message: "N+1" },
  ]);
  const { code, out } = findingsBrief("ZCL_X", p);
  assert.equal(code, 0);
  const res = JSON.parse(out);
  assert.equal(res.object, "ZCL_X");
  assert.equal(res.count, 2, "only ZCL_X's two anti-patterns, not ZCL_OTHER's");
  assert.match(res.brief, /do NOT reproduce|avoid/i);
  assert.match(res.brief, /zcl_x\.clas\.abap:49/);
  assert.match(res.brief, /WITH lt|FOR ALL ENTRIES|pre-load/i, "carries the batched/pre-loaded exemplars");
});

test("object matching is case-insensitive", () => {
  const p = writeFindings([{ rule_id: "talos-select-in-loop", severity: "priority-1", object: "ZCL_X", file: "z", line: 1, message: "m" }]);
  assert.equal(JSON.parse(findingsBrief("zcl_x", p).out).count, 1);
});

test("an object with no structural anti-patterns yields an empty brief (count 0, no noise)", () => {
  const p = writeFindings([{ rule_id: "talos-select-in-loop", severity: "priority-1", object: "ZCL_OTHER", file: "o", line: 1, message: "m" }]);
  const res = JSON.parse(findingsBrief("ZCL_X", p).out);
  assert.equal(res.count, 0);
  assert.equal(res.brief, "");
});

test("fails loud (exit 1) when --findings is missing", () => {
  const r = spawnSync(process.execPath, [CLI, "findings-brief", "ZCL_X"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--findings/);
});
