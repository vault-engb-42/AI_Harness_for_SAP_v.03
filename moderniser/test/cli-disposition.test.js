import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

// `disposition <run_id>` + parametrized `decide` end-to-end (real subprocess, real fs, golden fixture — no
// mocks). B3: the plan-time DISPOSITION gate emits the manifest and raises one DISPOSITION_REVIEW per prompted
// node; `decide` routes the parametrized form (approve | override:<disposition> | other:<freeform>).

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "cli.js");
const FIXTURE = join(HERE, "fixtures", "analyser-findings.json");

function mkCli() {
  const base = mkdtempSync(join(tmpdir(), "disp-cli-"));
  const state = join(base, "state");
  const runs = join(base, "runs");
  return (...a) => JSON.parse(execFileSync(process.execPath, [CLI, ...a, "--state-dir", state, "--runs-dir", runs], { encoding: "utf8" }));
}

test("disposition emits the manifest summary + raises one DISPOSITION_REVIEW per prompt row", () => {
  const cli = mkCli();
  const planned = cli("plan", FIXTURE);
  const out = cli("disposition", planned.run_id);
  assert.equal(out.summary.prompt_count, planned.nodes.length, "abap_fico: every node prompts");
  assert.equal(out.summary.auto_count, 0);
  const escs = cli("escalations", planned.run_id, "--max", "50");
  const raised = [...escs.surfaced, ...escs.queued];
  assert.equal(raised.length, out.summary.prompt_count);
  assert.ok(raised.every((e) => e.kind === "DISPOSITION_REVIEW" && e.status === "OPEN"));
});

test("disposition is idempotent — a re-run raises no duplicate reviews", () => {
  const cli = mkCli();
  const planned = cli("plan", FIXTURE);
  cli("disposition", planned.run_id);
  cli("disposition", planned.run_id);
  const escs = cli("escalations", planned.run_id, "--max", "50");
  assert.equal([...escs.surfaced, ...escs.queued].length, planned.nodes.length, "the bus dedupes an already-open review");
});

test("packets renders the DISPOSITION_REVIEW typed decision set", () => {
  const cli = mkCli();
  const planned = cli("plan", FIXTURE);
  cli("disposition", planned.run_id);
  const p = cli("packets", planned.run_id, "--max", "50").packets.find((x) => x.kind === "DISPOSITION_REVIEW");
  assert.ok(p, "a DISPOSITION_REVIEW packet is rendered");
  assert.deepEqual(p.decisions, ["approve", "override", "other"]);
});

test("decide routes a parametrized DISPOSITION_REVIEW (override:<disposition>) end-to-end", () => {
  const cli = mkCli();
  const planned = cli("plan", FIXTURE);
  cli("disposition", planned.run_id);
  const id = cli("escalations", planned.run_id, "--max", "50").surfaced[0].id;
  const row = cli("decide", planned.run_id, id, "override:refactor", "--by", "alice");
  assert.equal(row.status, "RESOLVED");
  assert.equal(row.resolved_by, "alice");
  assert.deepEqual(row.decision, { verb: "override", disposition: "refactor" });
});

test("decide refuses an invalid parametrized override target on a DISPOSITION_REVIEW", () => {
  const cli = mkCli();
  const planned = cli("plan", FIXTURE);
  cli("disposition", planned.run_id);
  const id = cli("escalations", planned.run_id, "--max", "50").surfaced[0].id;
  assert.throws(() => cli("decide", planned.run_id, id, "override:port", "--by", "alice"));
});
